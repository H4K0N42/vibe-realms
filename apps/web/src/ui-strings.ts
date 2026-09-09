/**
 * Strings for the app itself. Card text comes from upstream's `.properties`
 * files (see i18n.ts); nothing here does, because upstream is a score
 * calculator and has no words for turns, rooms or reveals.
 *
 * Only the two locales the picker offers. The card data ships in all fourteen,
 * but promising an interface language we have not written would be worse than
 * not offering it.
 */
export const UI = {
  de: {
    'app.title': 'Fantasy Realms',
    'app.tagline': 'Sammle sieben Karten, die sich gegenseitig verstärken – und keine, die sich blockiert.',
    'app.how.1': 'Jeder Zug: eine Karte ziehen, eine ablegen.',
    'app.how.2': 'Liegen zehn Karten in der Ablage, endet das Spiel.',
    'app.how.3': 'Die höchste Punktzahl gewinnt.',
    'app.players': '2–6 Spieler · ein Gerät pro Spieler',

    'home.name': 'Name',
    'home.namePlaceholder': 'Dein Name',
    'home.code': 'Raumcode',
    'home.codePlaceholder': 'CODE',
    'home.join': 'Beitreten',
    'home.new': 'Neues Spiel',
    'home.hint': 'Code eingeben, um einem Spiel beizutreten – oder leer lassen für ein neues.',

    'bar.room': 'Raum',
    'bar.copy': 'Einladungslink kopieren',
    'bar.copied': 'Link kopiert',
    'bar.language': 'Sprache',
    'bar.leave': 'Verlassen',
    'bar.leaveConfirm': 'Wirklich verlassen?',
    'bar.leaveCancel': 'Doch nicht',

    'lobby.you': '(du)',
    'lobby.host': 'wartet',
    'lobby.expansions': 'Erweiterungen',
    'lobby.exp.suits': 'Verfluchter Schatz (Gebäude/Outsider/Untote)',
    'lobby.exp.items': 'Verfluchte Gegenstände',
    'lobby.start': 'Spiel starten',
    'lobby.needPlayers': 'Mindestens {n} Spieler.',
    'lobby.invite': 'Schick den Link oder den Code an deine Mitspieler.',

    'table.yourTurnDraw': 'Zieh dir eine Karte herüber',
    'table.yourTurnDiscard': 'Karte in die Ablage ziehen',
    'table.waitingFor': '{name} ist am Zug',
    'table.waiting': 'Warte…',
    'table.deck': 'Nachziehstapel: {n} Karten',
    'table.discardCount': 'Ablage {n}/{max}',
    'table.offline': 'offline',
    'table.disconnected': 'Verbindung verloren – dein Sitzplatz bleibt reserviert.',
    'table.keyboardHint': 'Enter zieht bzw. legt ab · Alt+←/→ sortiert die Hand · Leertaste zeigt den vollen Text',

    'card.blanked': 'blockiert',
    'card.aria': '{name}, Stärke {strength}, {suit}',
    'card.ariaBlanked': '{name}, Stärke {strength}, {suit} – blockiert',
    'card.deckAria': 'Nachziehstapel, {n} Karten',
    'card.close': 'Schließen',

    'vote.gone': '{names} ist nicht mehr verbunden.',
    'vote.question': 'Spiel vorzeitig beenden und werten? ({have}/{needed})',
    'vote.yes': 'Jetzt werten',
    'vote.waiting': 'Warte auf die anderen…',
    'vote.withdraw': 'Zurückziehen',

    'reveal.next': 'Nächste Karte aufdecken ({have}/{total})',
    'reveal.watching': '{name} deckt auf…',
    'reveal.nextPlayer': 'Nächster Spieler',
    'reveal.showScores': 'Endstand zeigen',
    'reveal.choosing': '{name} wählt noch Karten aus…',
    'reveal.blanked': 'BLOCKIERT',
    'reveal.freed': 'frei!',

    'action.title': 'Karten mit Wahl',
    'action.pickCard': '– Karte wählen –',
    'action.pickSuit': '– Gattung –',
    'action.confirm': 'Bestätigen',
    'action.decline': 'Nicht nutzen',

    'scores.final': 'Endstand',
    'scores.early': 'Vorzeitig beendet',
    'scores.winner': 'gewinnt',
    'scores.points': 'Punkte',
    'scores.behind': '{n} zurück',
    'scores.details': 'Wertung im Detail',
    'scores.col.card': 'Karte',
    'scores.col.base': 'Basis',
    'scores.col.bonus': 'Bonus',
    'scores.col.penalty': 'Abzug',
    'scores.col.effect': 'Wirkung',
    'scores.rematch': 'Revanche',
    'scores.rematchHint': 'Gleicher Raum, gleiche Runde.',
    'scores.home': 'Zur Startseite',
  },
  en: {
    'app.title': 'Fantasy Realms',
    'app.tagline': 'Collect seven cards that strengthen one another – and none that blanks them.',
    'app.how.1': 'Each turn: draw one card, discard one.',
    'app.how.2': 'Once ten cards lie in the discard area, the game ends.',
    'app.how.3': 'Highest score wins.',
    'app.players': '2–6 players · one device each',

    'home.name': 'Name',
    'home.namePlaceholder': 'Your name',
    'home.code': 'Room code',
    'home.codePlaceholder': 'CODE',
    'home.join': 'Join',
    'home.new': 'New game',
    'home.hint': 'Enter a code to join a game – or leave it blank to start one.',

    'bar.room': 'Room',
    'bar.copy': 'Copy invite link',
    'bar.copied': 'Link copied',
    'bar.language': 'Language',
    'bar.leave': 'Leave',
    'bar.leaveConfirm': 'Really leave?',
    'bar.leaveCancel': 'Stay',

    'lobby.you': '(you)',
    'lobby.host': 'waiting',
    'lobby.expansions': 'Expansions',
    'lobby.exp.suits': 'Cursed Hoard (Buildings/Outsiders/Undead)',
    'lobby.exp.items': 'Cursed Items',
    'lobby.start': 'Start game',
    'lobby.needPlayers': 'At least {n} players.',
    'lobby.invite': 'Send the link or the code to the others.',

    'table.yourTurnDraw': 'Drag a card over to your hand',
    'table.yourTurnDiscard': 'Drag a card to the discard area',
    'table.waitingFor': "{name}'s turn",
    'table.waiting': 'Waiting…',
    'table.deck': 'Draw pile: {n} cards',
    'table.discardCount': 'Discard {n}/{max}',
    'table.offline': 'offline',
    'table.disconnected': 'Connection lost – your seat is held.',
    'table.keyboardHint': 'Enter draws or discards · Alt+←/→ sorts your hand · Space shows the full text',

    'card.blanked': 'blanked',
    'card.aria': '{name}, strength {strength}, {suit}',
    'card.ariaBlanked': '{name}, strength {strength}, {suit} – blanked',
    'card.deckAria': 'Draw pile, {n} cards',
    'card.close': 'Close',

    'vote.gone': '{names} is no longer connected.',
    'vote.question': 'End the game early and score it? ({have}/{needed})',
    'vote.yes': 'Score now',
    'vote.waiting': 'Waiting for the others…',
    'vote.withdraw': 'Withdraw',

    'reveal.next': 'Turn over the next card ({have}/{total})',
    'reveal.watching': '{name} is revealing…',
    'reveal.nextPlayer': 'Next player',
    'reveal.showScores': 'Show final scores',
    'reveal.choosing': '{name} is still choosing…',
    'reveal.blanked': 'BLANKED',
    'reveal.freed': 'freed!',

    'action.title': 'Cards with a choice',
    'action.pickCard': '– pick a card –',
    'action.pickSuit': '– suit –',
    'action.confirm': 'Confirm',
    'action.decline': "Don't use",

    'scores.final': 'Final scores',
    'scores.early': 'Ended early',
    'scores.winner': 'wins',
    'scores.points': 'points',
    'scores.behind': '{n} behind',
    'scores.details': 'Full breakdown',
    'scores.col.card': 'Card',
    'scores.col.base': 'Base',
    'scores.col.bonus': 'Bonus',
    'scores.col.penalty': 'Penalty',
    'scores.col.effect': 'Effect',
    'scores.rematch': 'Rematch',
    'scores.rematchHint': 'Same room, same players.',
    'scores.home': 'Back to the start',
  },
} as const;

export type UiKey = keyof typeof UI.de;
export type UiLocale = keyof typeof UI;

export function isUiLocale(locale: string): locale is UiLocale {
  return locale in UI;
}

/** `{name}` placeholders are filled from `vars`; anything unknown is left alone. */
export function translate(
  locale: string,
  key: UiKey,
  vars?: Record<string, string | number>,
): string {
  const table = isUiLocale(locale) ? UI[locale] : UI.en;
  const text: string = table[key] ?? UI.en[key] ?? key;
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}
