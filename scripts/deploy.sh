#!/usr/bin/env bash
#
# Deploy or update a running instance: fetch the chosen branch, rebuild the
# image, restart the container.
#
# The two things this script is careful about, because both are easy to get
# wrong and expensive to get wrong:
#
#   1. The database. ./DATA is a bind mount of live SQLite files and is never
#      touched here except to read it for a backup. `docker compose down -v`
#      does not appear in this file, and neither does `git clean`, which would
#      happily delete an untracked DATA directory.
#   2. The settings of this host. Everything host specific lives in .env, which
#      git does not track, so pulling a new docker-compose.yml cannot reset the
#      port or the uid. A missing .env is seeded from .env.example once and then
#      left alone forever.
#
# Usage: scripts/deploy.sh [main|dev] [options]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BRANCH=""
FORCE=0
BACKUP=1
PULL=1
BUILD=1
KEEP_BACKUPS=10
SERVICE="${FR_SERVICE:-vibe-realms}"

usage() {
  cat <<'EOF'
Usage: scripts/deploy.sh [main|dev] [options]

Fetches the branch, rebuilds the image and restarts the container. Never
deletes the database and never overwrites .env.

  main | dev | --branch <name>
                  Which branch to deploy. Defaults to the branch that is
                  currently checked out.
  --no-pull       Deploy the working tree as it is, without touching git.
  --no-build      Restart with the existing image, do not rebuild.
  --no-backup     Skip the DATA snapshot taken before the restart.
  --force         Discard local changes to tracked files and hard reset to the
                  remote branch. The discarded changes are saved as a patch
                  under backups/ first.
  -h, --help      This text.

Settings live in .env (see .env.example): FR_HOST_PORT, FR_DATA, FR_UID,
FR_GID, FR_SERVICE (compose service name, defaults to vibe-realms).
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    main|dev) BRANCH="$1" ;;
    --branch) BRANCH="${2:?--branch needs a name}"; shift ;;
    --no-pull) PULL=0 ;;
    --no-build) BUILD=0 ;;
    --no-backup) BACKUP=0 ;;
    --force) FORCE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33m!! %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31m!! %s\033[0m\n' "$*" >&2; exit 1; }

# Compose v2 is a docker subcommand, v1 a separate binary. Accept either.
if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  die "docker compose not found. Install Docker with the compose plugin."
fi
command -v git >/dev/null 2>&1 || die "git not found."
docker info >/dev/null 2>&1 || die "cannot talk to the Docker daemon. Is it running, and are you in the docker group?"

# --- settings -----------------------------------------------------------
# Seeded once, never rewritten: this is the file that survives updates.
if [ ! -f .env ]; then
  say "first run: creating .env from .env.example"
  cp .env.example .env
  if [ "$(id -u)" != "1000" ] || [ "$(id -g)" != "1000" ]; then
    # A bind mount keeps host ownership, so the container has to run as
    # whoever owns DATA. Getting this right on the first run saves a confusing
    # "unable to open database file" later.
    sed -i "s/^FR_UID=.*/FR_UID=$(id -u)/; s/^FR_GID=.*/FR_GID=$(id -g)/" .env
    echo "   uid:gid set to $(id -u):$(id -g) to match this host"
  fi
  echo "   review .env before the next deploy if you want a different port"
fi

# shellcheck disable=SC1091
set -a; . ./.env; set +a
DATA_DIR="${FR_DATA:-./DATA}"
SERVICE="${FR_SERVICE:-$SERVICE}"
mkdir -p "$DATA_DIR" backups

# --- code ---------------------------------------------------------------
if [ "$PULL" -eq 1 ]; then
  CURRENT="$(git rev-parse --abbrev-ref HEAD)"
  BRANCH="${BRANCH:-$CURRENT}"

  say "updating to origin/$BRANCH"
  git fetch --prune origin
  git rev-parse --verify --quiet "refs/remotes/origin/$BRANCH" >/dev/null \
    || die "origin has no branch '$BRANCH'."

  # Untracked files are left alone on purpose: DATA, .env and backups all live
  # there. Only tracked modifications are in the way of a fast forward.
  if ! git diff --quiet HEAD -- || ! git diff --quiet --cached HEAD --; then
    if [ "$FORCE" -eq 1 ]; then
      PATCH="backups/local-changes-$(date +%Y%m%d-%H%M%S).patch"
      git diff HEAD > "$PATCH"
      warn "discarding local changes to tracked files, saved to $PATCH"
      # Discard now, before checkout: a plain `git checkout` can still refuse
      # to switch branches if the dirty files conflict with the target
      # branch, even though --force was passed. Reset first so there is
      # nothing left to conflict with.
      git reset -q --hard HEAD
    else
      git --no-pager diff --stat HEAD
      die "local changes to tracked files. Commit them, or rerun with --force to discard."
    fi
  fi

  BEFORE="$(git rev-parse HEAD)"
  if [ "$FORCE" -eq 1 ]; then
    git checkout -q -f "$BRANCH" 2>/dev/null || git checkout -q -f -b "$BRANCH" "origin/$BRANCH"
    git reset -q --hard "origin/$BRANCH"
  else
    git checkout -q "$BRANCH" 2>/dev/null || git checkout -q -b "$BRANCH" "origin/$BRANCH"
    git merge --ff-only "origin/$BRANCH" \
      || die "branch $BRANCH has diverged from origin. Sort it out by hand, or rerun with --force."
  fi
  AFTER="$(git rev-parse HEAD)"

  if [ "$BEFORE" = "$AFTER" ]; then
    echo "   already at $(git rev-parse --short HEAD), nothing new"
  else
    git --no-pager log --oneline --no-decorate "$BEFORE..$AFTER" | sed 's/^/   /'
  fi
else
  say "skipping git, deploying the working tree as it is"
fi

# --- image --------------------------------------------------------------
if [ "$BUILD" -eq 1 ]; then
  say "building the image"
  "${COMPOSE[@]}" build
fi

# --- restart ------------------------------------------------------------
# The container is stopped before the snapshot so SQLite is not mid write and
# the WAL has been checked in. `stop`, not `down -v`: the bind mount is a plain
# host directory either way, but the habit matters.
say "stopping the container"
"${COMPOSE[@]}" stop || true

if [ "$BACKUP" -eq 1 ] && [ -n "$(ls -A "$DATA_DIR" 2>/dev/null)" ]; then
  SNAP="backups/data-$(date +%Y%m%d-%H%M%S).tar.gz"
  say "backing up $DATA_DIR to $SNAP"
  tar czf "$SNAP" -C "$(dirname "$DATA_DIR")" "$(basename "$DATA_DIR")"
  # Keep the last few, so this cannot fill the disk unattended.
  ls -1t backups/data-*.tar.gz 2>/dev/null | tail -n +$((KEEP_BACKUPS + 1)) | xargs -r rm --
fi

# Local-change patches from --force runs pile up the same way the data
# snapshots do, so prune those on the same schedule.
ls -1t backups/local-changes-*.patch 2>/dev/null | tail -n +$((KEEP_BACKUPS + 1)) | xargs -r rm --

say "starting"
"${COMPOSE[@]}" up -d

# --- verify -------------------------------------------------------------
# The image declares a HEALTHCHECK, so ask Docker rather than guessing the port.
CID="$("${COMPOSE[@]}" ps -q "$SERVICE" || true)"
[ -n "$CID" ] || die "the container did not come up. ${COMPOSE[*]} logs --tail 50"

say "waiting for the healthcheck"
READY=0
for _ in $(seq 60); do
  STATE="$(docker inspect -f '{{.State.Status}}' "$CID")"
  HEALTH="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CID")"
  case "$STATE" in
    exited|dead)
      "${COMPOSE[@]}" logs --tail 50
      die "the container exited right after starting."
      ;;
  esac
  # `none` means the healthcheck was disabled somewhere; then running is all
  # there is to wait for.
  if [ "$HEALTH" = "healthy" ] || { [ "$HEALTH" = "none" ] && [ "$STATE" = "running" ]; }; then
    READY=1
    break
  fi
  sleep 1
done

if [ "$READY" -ne 1 ]; then
  "${COMPOSE[@]}" logs --tail 50
  die "the container is up but never became healthy (status: $STATE/$HEALTH)."
fi

printf '\n\033[32m==> deployed: %s @ %s, http://localhost:%s\033[0m\n' \
  "$(git rev-parse --abbrev-ref HEAD)" "$(git rev-parse --short HEAD)" "${FR_HOST_PORT:-3000}"
