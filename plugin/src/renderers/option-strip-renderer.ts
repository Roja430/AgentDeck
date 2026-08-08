/**
 * AWAITING option list, drawn across all four Stream Deck+ encoder LCDs.
 *
 * Same technique as the offline banner: compose one 800×100 canvas and hand
 * each encoder a 200px window onto it. That is what buys the takeover its
 * reason to exist — a key can show two wrapped lines of ~13 characters, while
 * this canvas has the whole strip to work with.
 *
 * The question spans the full width rather than sitting in E1's 200px column.
 * Confined to one encoder it clipped at ~24 characters, and "Do you want to
 * overwrit…" does not tell you what you are approving — which is the one thing
 * a permission prompt has to communicate. It costs a row of options; permission
 * prompts have two or three, and longer lists scroll.
 *
 * Colour carries the answer's meaning: yes reads green, no reads red, and the
 * strip's border, counter and highlight all take the colour of whichever option
 * the cursor is on. On a panel you glance at rather than read, that is the
 * difference between working out which row is highlighted and simply seeing
 * that you are about to approve something. Anything the classifier cannot place
 * stays neutral — painting an arbitrary AskUserQuestion choice green would
 * assert a meaning it does not have.
 */
import { UI } from '@agentdeck/shared';

const SLICE_W = 200;
const TOTAL_W = 800;
const H = 100;
const FONT = "'IBM Plex Sans','Yu Gothic UI',Meiryo,sans-serif";

/** Rows that fit under the question. Drives scrolling, so it is not cosmetic. */
export const VISIBLE_ROWS = 3;
const ROW_H = 20;
const ROW_TOP = 52;
const PAD_X = 20;

/**
 * True black, not the design system's `Ink.s900`.
 *
 * DESIGN.md §10.2 steers blacks toward the aquarium green because that rule is
 * about *rendered* surfaces. This one is an emissive 200×100 LCD in a dark
 * room, where black means the pixels are off: any lifted black shows as a grey
 * rectangle floating on the dial, and the colour-coded rows lose contrast
 * against it. Hardware panels are the documented exception (§2.6).
 */
const BG = '#000000';

export type OptionSense = 'affirm' | 'deny' | 'neutral';

const SENSE_COLOR: Record<OptionSense, string> = {
  affirm: UI.ok,
  deny: UI.error,
  neutral: UI.attn,
};

/** Row text for an option that carries no yes/no meaning of its own. */
const NEUTRAL_TEXT = '#e2e8f0';
/** Everything greys out when the session cannot be answered from the dials. */
const UNANSWERABLE = '#64748b';

/**
 * Anchored at the start of the label, which is the whole safety property.
 *
 * Claude Code writes the sense first and the caveat after — "No, tell Claude
 * what to do differently", "Yes, and don't ask again". Matching anywhere in the
 * string would read that trailing "don't" as a refusal and paint an approval
 * red, which is the one mistake this must never make.
 */
// The Latin alternatives carry `\b` so "Yesterday" and "Nothing" do not match.
// The Japanese ones cannot: `\b` is defined against [A-Za-z0-9_], so there is
// no boundary after `はい` and the alternative would never fire.
const AFFIRM = /^\s*(?:(?:yes|y|allow|approve|accept|ok(?:ay)?|proceed|continue|confirm)\b|はい|許可|承認)/i;
const DENY = /^\s*(?:(?:no|n|deny|reject|decline|cancel|skip|exit|quit|stop|abort|don'?t)\b|いいえ|拒否|中止)/i;

/**
 * Which way an option answers. Colour only — nothing acts on this.
 * Exported because the anchoring rule above is what would regress silently.
 */
export function classifyOption(label: string): OptionSense {
  if (AFFIRM.test(label)) return 'affirm';
  if (DENY.test(label)) return 'deny';
  return 'neutral';
}

export interface OptionStripView {
  question?: string;
  labels: string[];
  cursor: number;
  /** False when the session cannot be answered — shown, not offered. */
  answerable: boolean;
}

function escXml(s: string): string {
  return s.replace(/[<>&"]/g, (c) => (
    c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : '&quot;'
  ));
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * First visible row, chosen so the cursor stays on screen.
 * Exported because the scroll rule is the part most likely to regress.
 */
export function scrollTopFor(cursor: number, total: number): number {
  if (total <= VISIBLE_ROWS) return 0;
  const maxTop = total - VISIBLE_ROWS;
  return Math.min(Math.max(0, cursor - 1), maxTop);
}

export function renderOptionStrip(slice: number, view: OptionStripView): string {
  const top = scrollTopFor(view.cursor, view.labels.length);
  const rows = view.labels.slice(top, top + VISIBLE_ROWS);

  // A prompt nobody can answer from here gets no yes/no colour at all: green
  // would invite a press that goes nowhere.
  const senseOf = (label: string): OptionSense =>
    (view.answerable ? classifyOption(label) : 'neutral');
  const hueOf = (sense: OptionSense): string =>
    (view.answerable ? SENSE_COLOR[sense] : UNANSWERABLE);

  const accent = hueOf(senseOf(view.labels[view.cursor] ?? ''));

  const rowEls = rows.map((label, i) => {
    const index = top + i;
    const selected = index === view.cursor;
    const y = ROW_TOP + i * ROW_H;
    const sense = senseOf(label);
    const hue = hueOf(sense);
    // An unplaceable option keeps the plain reading colour; only a real yes or
    // no earns green or red.
    const fill = sense === 'neutral' && view.answerable ? NEUTRAL_TEXT : hue;
    const marker = selected
      ? `<rect x="${PAD_X - 8}" y="${y - 14}" width="${TOTAL_W - PAD_X * 2 + 16}" height="${ROW_H - 2}" rx="5" fill="${hue}" opacity="0.20"/>`
        + `<rect x="${PAD_X - 8}" y="${y - 14}" width="3" height="${ROW_H - 2}" rx="1.5" fill="${hue}"/>`
      : '';
    return marker
      + `<text x="${PAD_X + 4}" y="${y}" font-family="${FONT}" font-size="13"`
      + ` font-weight="${selected ? '800' : '600'}"`
      + ` fill="${fill}" opacity="${selected ? '1' : '0.62'}">`
      + `${escXml(clip(`${index + 1}. ${label}`, 84))}</text>`;
  }).join('');

  // Question gets the full width, minus the counter parked on the right.
  const questionMax = 78;
  const hintFill = view.answerable ? NEUTRAL_TEXT : UNANSWERABLE;
  const head = [
    `<text x="${PAD_X}" y="26" font-family="${FONT}" font-size="14" font-weight="800" fill="#f8fafc">`
      + `${escXml(clip(view.question ?? (view.answerable ? '選択してください' : '確認待ち'), questionMax))}</text>`,
    `<text x="${TOTAL_W - PAD_X}" y="26" text-anchor="end" font-family="${FONT}" font-size="13" font-weight="800" fill="${accent}">`
      + `${view.cursor + 1}/${view.labels.length}</text>`,
    `<text x="${TOTAL_W - PAD_X}" y="${H - 12}" text-anchor="end" font-family="${FONT}" font-size="10" font-weight="600" fill="${hintFill}" opacity="0.75">`
      + `${escXml(view.answerable ? 'Rotate · Press' : 'ターミナルで回答')}</text>`,
    `<line x1="${PAD_X}" y1="34" x2="${TOTAL_W - PAD_X}" y2="34" stroke="${accent}" stroke-width="1" stroke-opacity="0.35"/>`,
  ].join('');

  const scrollHint = view.labels.length > VISIBLE_ROWS
    ? `<text x="${PAD_X}" y="${H - 12}" font-family="${FONT}" font-size="10" fill="${hintFill}" opacity="0.6">`
      + `${top > 0 ? '▲' : ''}${top + VISIBLE_ROWS < view.labels.length ? '▼' : ''} ${view.labels.length}件</text>`
    : '';

  const content = [
    `<rect x="8" y="6" width="${TOTAL_W - 16}" height="${H - 12}" rx="14" fill="${BG}" stroke="${accent}" stroke-width="2" stroke-opacity="0.5"/>`,
    head,
    rowEls,
    scrollHint,
  ].join('');

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SLICE_W}" height="${H}" viewBox="0 0 ${SLICE_W} ${H}">`,
    `<rect width="${SLICE_W}" height="${H}" rx="16" fill="${BG}"/>`,
    `<g transform="translate(${-slice * SLICE_W} 0)">${content}</g>`,
    '</svg>',
  ].join('');
}
