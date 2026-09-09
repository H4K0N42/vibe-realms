/** A link that drops whoever follows it into the room with the code filled in. */
export function inviteLink(code: string): string {
  return `${location.origin}${location.pathname}?room=${encodeURIComponent(code)}`;
}

/**
 * The clipboard API only exists in a secure context. This game is meant to be
 * self-hosted and reached over plain HTTP on a LAN as well as through a proxy
 * with TLS, so the old selection-based copy has to stay as a fallback.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission denied or insecure origin; fall through.
  }

  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  // Off-screen but still selectable; `display: none` cannot be selected.
  field.style.cssText = 'position:fixed;top:-1000px;opacity:0';
  document.body.appendChild(field);
  try {
    field.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    field.remove();
  }
}
