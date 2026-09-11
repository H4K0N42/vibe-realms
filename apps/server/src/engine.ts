// Adapter between the game state machine and the vendored scoring engine.
// One RoomEngine (one node:vm context) per room. See DESIGN.md "Engine reuse".
import { RoomEngine } from '@fr/engine';
import type { CardId, ExpansionConfig, PlayerScore } from '@fr/shared';

import type { GameState, PrivatePlayer } from './game.ts';

export interface RoomEngineHandle {
  /** Card ids that make up the main draw pile for this configuration. */
  drawDeck(): CardId[];
  /** Cursed Items are a separate zone, not part of the main deck. */
  cursedItemDeck(): CardId[];
  handLimit(): number;
  /** Ids of cards that ask their holder a question at scoring time. */
  actionCardIds(): Set<CardId>;
  scoreHand(
    hand: CardId[],
    discard: CardId[],
    choices?: Record<CardId, string[]>,
  ): { total: number; breakdown: PlayerScore['breakdown'] };
  /** Blanked cards only, and unlike scoreHand it accepts an over-full hand. */
  blankedIn(hand: CardId[], discard: CardId[], choices?: Record<CardId, string[]>): CardId[];
  dispose(): void;
}

/**
 * Cards the product never deals, whatever the engine offers. The promo printing
 * of the Phoenix was already dropped here in spirit (`listCards()` filters it);
 * the base Phoenix goes for the same kind of reason plus one of its own: it is
 * the card upstream has no German text for, so a German table met it as English
 * with an "EN" badge, and it is the one card whose blanking the two printings
 * disagree about (see DESIGN.md "Known divergences"). `@fr/engine` still knows
 * it and the upstream vectors still score it; it simply never reaches a table.
 */
const NOT_DEALT: readonly CardId[] = ['FR55', 'FR55P'];

export function createEngine(expansions: ExpansionConfig, playerCount: number): RoomEngineHandle {
  const engine = new RoomEngine({
    cursedHoardSuits: expansions.cursedHoardSuits,
    cursedHoardItems: expansions.cursedHoardItems,
    playerCount,
  });

  const all = engine.listCards().filter((c) => !NOT_DEALT.includes(c.id));
  const main = all.filter((c) => !c.cursedItem).map((c) => c.id);
  const cursed = all.filter((c) => c.cursedItem).map((c) => c.id);

  return {
    drawDeck: () => [...main],
    cursedItemDeck: () => [...cursed],
    handLimit: () => engine.handLimit,
    actionCardIds: () => new Set(all.filter((c) => c.action).map((c) => c.id)),
    scoreHand(hand, discard, choices = {}) {
      const result = engine.score(hand, discard, relevantChoices(hand, choices));
      return { total: result.total, breakdown: result.breakdown };
    },
    blankedIn(hand, discard, choices = {}) {
      return engine.blankedIn(hand, discard, relevantChoices(hand, choices));
    },
    dispose: () => engine.dispose(),
  };
}

/**
 * Only the choices for cards actually held, with the empty ones dropped: the
 * engine throws if a choice names a card that is not in the hand.
 */
function relevantChoices(
  hand: CardId[],
  choices: Record<CardId, string[]>,
): Record<string, string[]> {
  const relevant: Record<string, string[]> = {};
  for (const [cardId, choice] of Object.entries(choices)) {
    if (hand.includes(cardId) && choice.length > 0) relevant[cardId] = choice;
  }
  return relevant;
}

/** Fisher-Yates. `rand` is injectable so tests can be deterministic. */
export function shuffle<T>(items: T[], rand: () => number = Math.random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function combinations<T>(items: T[], k: number): T[][] {
  if (k > items.length) return [];
  if (k === items.length) return [items];
  const out: T[][] = [];
  const pick = (start: number, acc: T[]): void => {
    if (acc.length === k) {
      out.push([...acc]);
      return;
    }
    for (let i = start; i < items.length; i++) {
      acc.push(items[i]!);
      pick(i + 1, acc);
      acc.pop();
    }
  };
  pick(0, []);
  return out;
}

/**
 * Score every player.
 *
 * A player who dropped mid-turn is holding one card too many. Rather than
 * discarding arbitrarily on their behalf, score their best legal subset --
 * 8 combinations for a 7-card limit (DESIGN.md "Vote to end early").
 */
export function scoreAll(
  state: GameState,
  engine: RoomEngineHandle,
): PlayerScore[] {
  const limit = engine.handLimit();
  return state.players.map((player: PrivatePlayer): PlayerScore => {
    const candidates =
      player.hand.length <= limit ? [player.hand] : combinations(player.hand, limit);
    const choices = state.actionChoices[player.id] ?? {};

    let best: { hand: CardId[]; total: number; breakdown: PlayerScore['breakdown'] } | null = null;
    for (const hand of candidates) {
      // Cursed Items ride along with every candidate: they are held in their own
      // zone and are never the card you would drop to get under the limit.
      const withItems = [...hand, ...player.cursedItems];
      const { total, breakdown } = engine.scoreHand(withItems, state.discard, choices);
      if (best === null || total > best.total) best = { hand: withItems, total, breakdown };
    }
    return {
      playerId: player.id,
      hand: best?.hand ?? [],
      total: best?.total ?? 0,
      breakdown: best?.breakdown ?? [],
    };
  });
}
