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
 */

const SLICE_W = 200;
const TOTAL_W = 800;
const H = 100;
const FONT = "'IBM Plex Sans','Yu Gothic UI',Meiryo,sans-serif";

/** Rows that fit under the question. Drives scrolling, so it is not cosmetic. */
export const VISIBLE_ROWS = 3;
const ROW_H = 20;
const ROW_TOP = 52;
const PAD_X = 20;
/** Right-hand reservation on the question line for the position counter. */
const COUNTER_W = 74;

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

  const accent = view.answerable ? '#f59e0b' : '#64748b';
  const bodyFill = view.answerable ? '#e2e8f0' : '#94a3b8';

  const rowEls = rows.map((label, i) => {
    const index = top + i;
    const selected = index === view.cursor;
    const y = ROW_TOP + i * ROW_H;
    const marker = selected
      ? `<rect x="${PAD_X - 8}" y="${y - 14}" width="${TOTAL_W - PAD_X * 2 + 16}" height="${ROW_H - 2}" rx="5" fill="${accent}" opacity="0.22"/>`
        + `<rect x="${PAD_X - 8}" y="${y - 14}" width="3" height="${ROW_H - 2}" rx="1.5" fill="${accent}"/>`
      : '';
    return marker
      + `<text x="${PAD_X + 4}" y="${y}" font-family="${FONT}" font-size="13"`
      + ` font-weight="${selected ? '800' : '600'}"`
      + ` fill="${selected ? '#f8fafc' : bodyFill}" opacity="${selected ? '1' : '0.8'}">`
      + `${escXml(clip(`${index + 1}. ${label}`, 84))}</text>`;
  }).join('');

  // Question gets the full width, minus the counter parked on the right.
  const questionMax = 78;
  const head = [
    `<text x="${PAD_X}" y="26" font-family="${FONT}" font-size="14" font-weight="800" fill="#f8fafc">`
      + `${escXml(clip(view.question ?? (view.answerable ? '選択してください' : '確認待ち'), questionMax))}</text>`,
    `<text x="${TOTAL_W - PAD_X}" y="26" text-anchor="end" font-family="${FONT}" font-size="13" font-weight="800" fill="${accent}">`
      + `${view.cursor + 1}/${view.labels.length}</text>`,
    `<text x="${TOTAL_W - PAD_X}" y="${H - 12}" text-anchor="end" font-family="${FONT}" font-size="10" font-weight="600" fill="${bodyFill}" opacity="0.75">`
      + `${escXml(view.answerable ? 'Rotate · Press' : 'ターミナルで回答')}</text>`,
    `<line x1="${PAD_X}" y1="34" x2="${TOTAL_W - PAD_X}" y2="34" stroke="${accent}" stroke-width="1" stroke-opacity="0.35"/>`,
  ].join('');

  const scrollHint = view.labels.length > VISIBLE_ROWS
    ? `<text x="${PAD_X}" y="${H - 12}" font-family="${FONT}" font-size="10" fill="${bodyFill}" opacity="0.7">`
      + `${top > 0 ? '▲' : ''}${top + VISIBLE_ROWS < view.labels.length ? '▼' : ''} ${view.labels.length}件</text>`
    : '';

  const content = [
    `<rect x="8" y="6" width="${TOTAL_W - 16}" height="${H - 12}" rx="14" fill="#0f172a" opacity="0.92" stroke="${accent}" stroke-width="2" stroke-opacity="0.45"/>`,
    head,
    rowEls,
    scrollHint,
  ].join('');

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SLICE_W}" height="${H}" viewBox="0 0 ${SLICE_W} ${H}">`,
    `<rect width="${SLICE_W}" height="${H}" rx="16" fill="#0A0A0E"/>`,
    `<g transform="translate(${-slice * SLICE_W} 0)">${content}</g>`,
    '</svg>',
  ].join('');
}
