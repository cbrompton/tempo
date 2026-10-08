// Stack orders and card math for Tempo.
//
// Every stack is a plain array of 52 cards, index 0 = position 1 = the TOP card
// of the deck held face down. Cards are written value + suit:
//   values A 2 3 4 5 6 7 8 9 10 J Q K, suits C H S D.
//
// PLEASE VERIFY EACH ORDER AGAINST A PHYSICAL DECK before performing. These were
// typed from memory of the published orders; one transposed card is enough to
// ruin a force. Run `npm test`: it checks every stack has 52 unique cards, but it
// cannot check that the order matches your deck.

export const VALUES = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
export const SUITS = ['C', 'H', 'S', 'D'];
export const SUIT_NAMES = { C: 'Clubs', H: 'Hearts', S: 'Spades', D: 'Diamonds' };
export const SUIT_GLYPHS = { C: '♣', H: '♥', S: '♠', D: '♦' };

const split = (s) => s.trim().split(/\s+/);

// Juan Tamariz, Mnemonica. Verify against your deck.
const MNEMONICA = split(`
  4C 2H 7D 3C 4H 6D AS 5H 9S 2S QH 3D QC
  8H 6S 5S 9H KC 2D JH 3S 8S 6H 10C 5D KD
  2C 3H 8D 5C KS JD 8C 10S KH JC 7S 10H AD
  4S 7H 4D AC 9C JS QD 7C QS 10D 6C AH 9D
`);

// Bart Harding / Simon Aronson, Aronson stack. Verify against your deck.
const ARONSON = split(`
  JS KC 5C 2H 9S AS 3H 6C 8D AC 10S 5H 2D
  KD 7D 8C 3S AD 7S 5S QD AH 8S 3D 7H QH
  5D 7C 4H KH 4D 10D JC JH 10C JD 4S 10H 6H
  3C 2S 9H KS 6S 4C 8H 9C QS 6D QC 2C 9D
`);

// Si Stebbins: each card is three higher than the last, suits in CHSD order,
// starting from the Ace of Clubs. Verify against your deck.
const STEBBINS = Array.from({ length: 52 }, (_, i) => VALUES[(i * 3) % 13] + SUITS[i % 4]);

// New deck order as a modern US Bicycle deck comes out of the box, held face down:
// A-K of Hearts, A-K of Clubs, K-A of Diamonds, K-A of Spades (Ace of Spades on the
// face). Other brands differ. Verify against your deck.
const NEW_DECK_ORDER = [
  ...VALUES.map((v) => v + 'H'),
  ...VALUES.map((v) => v + 'C'),
  ...[...VALUES].reverse().map((v) => v + 'D'),
  ...[...VALUES].reverse().map((v) => v + 'S'),
];

// Eight Kings: "Eight kings threatened to save ninety-five queens for one sick knave",
// suits rotating in CHSD order, starting with the Eight of Clubs. Verify against your deck.
const EIGHT_KINGS_VALUES = ['8', 'K', '3', '10', '2', '7', '9', '5', 'Q', '4', 'A', '6', 'J'];
const EIGHT_KINGS = Array.from({ length: 52 }, (_, i) => EIGHT_KINGS_VALUES[i % 13] + SUITS[i % 4]);

export const STACKS = {
  mnemonica: { name: 'Mnemonica', cards: MNEMONICA },
  aronson: { name: 'Aronson', cards: ARONSON },
  stebbins: { name: 'Stebbins', cards: STEBBINS },
  ndo: { name: 'New Deck Order', cards: NEW_DECK_ORDER },
  eightkings: { name: 'Eight Kings', cards: EIGHT_KINGS },
  number: { name: 'Number', cards: null },
};

export const STACK_IDS = Object.keys(STACKS);

const mod = (n, m) => ((n % m) + m) % m;

export function cardName(card) {
  const value = card.slice(0, -1);
  const suit = card.slice(-1);
  return value + SUIT_GLYPHS[suit];
}

export function stackCards(stackId) {
  const stack = STACKS[stackId];
  if (!stack || !stack.cards) throw new Error(`No card order for stack "${stackId}"`);
  return stack.cards;
}

/** 1-based position of `card` in the stack, counted from the top. */
export function positionOf(stackId, card) {
  const i = stackCards(stackId).indexOf(card);
  if (i < 0) throw new Error(`${card} is not in ${stackId}`);
  return i + 1;
}

/** Card at a 1-based position (wraps mod 52). */
export function cardAt(stackId, position) {
  const cards = stackCards(stackId);
  return cards[mod(position - 1, cards.length)];
}

/**
 * The number the spectator must count to, from the top of the deck as it is now.
 *
 * - No peek: the deck is in stack order, so it's the card's stack position.
 * - Top peek: the peeked card is the current top card.
 * - Bottom peek: the peeked card is on the bottom, so the top card is the next
 *   card in stack order after it.
 *
 * The result is always 1..52 (wraps mod 52).
 */
export function forcedNumber(stackId, target, peek = null, peekType = 'bottom') {
  const t = positionOf(stackId, target) - 1;
  if (!peek) return t + 1;
  const p = positionOf(stackId, peek) - 1;
  const top = peekType === 'top' ? p : p + 1;
  return mod(t - top, 52) + 1;
}

/**
 * The entry steps the performer must complete, in order.
 * Each step is { kind: 'target' | 'peek' | 'number', force: 0 | 1 }.
 */
export function entrySteps({ stack, useOffset, useDouble }) {
  const steps = [];
  const forces = useDouble ? [0, 1] : [0];
  for (const force of forces) {
    if (stack === 'number') {
      steps.push({ kind: 'number', force });
    } else {
      steps.push({ kind: 'target', force });
      if (useOffset) steps.push({ kind: 'peek', force });
    }
  }
  return steps;
}

/**
 * Turn completed entries into forced numbers, one per force.
 * `entries` is parallel to entrySteps(settings): cards like 'QS', or integers in
 * number mode. Returns null for a force whose entries are missing.
 */
export function computeTargets(settings, entries) {
  const steps = entrySteps(settings);
  const out = [];
  const forces = settings.useDouble ? [0, 1] : [0];
  for (const force of forces) {
    const idx = (kind) => steps.findIndex((s) => s.force === force && s.kind === kind);
    if (settings.stack === 'number') {
      const v = entries[idx('number')];
      out.push(Number.isInteger(v) ? v : null);
      continue;
    }
    const target = entries[idx('target')];
    if (!target) { out.push(null); continue; }
    if (settings.useOffset) {
      const peek = entries[idx('peek')];
      out.push(peek ? forcedNumber(settings.stack, target, peek, settings.offsetType) : null);
    } else {
      out.push(forcedNumber(settings.stack, target));
    }
  }
  return out;
}
