/**
 * AWAITING option list, drawn across all four Stream Deck+ encoder LCDs.
 *
 * Same technique as the offline banner: compose one 800×100 canvas and hand
 * each encoder a 200px window onto it. That is what buys the takeover its
 * reason to exist — a key can show two wrapped lines of ~13 characters, while
 * a row here has the full 600px of E2–E4 to itself.
 */

const SLICE_W = 200;
const TOTAL_W = 800;
const H = 100;
const FONT = "'IBM Plex Sans','Yu Gothic UI',Meiryo,sans-serif";

/** Rows that fit in the list panel. Drives scrolling, so it is not cosmetic. */
export const VISIBLE_ROWS = 4;
const ROW_H = 22;
const LIST_X = SLICE_W + 12;
const LIST_W = TOTAL_W - LIST_X - 12;

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
  // Keep one row of lookahead where there is room for it.
  const top = Math.min(Math.max(0, cursor - 1), maxTop);
  return top;
}

export function renderOptionStrip(slice: number, view: OptionStripView): string {
  const top = scrollTopFor(view.cursor, view.labels.length);
  const rows = view.labels.slice(top, top + VISIBLE_ROWS);

  const accent = view.answerable ? '#f59e0b' : '#64748b';
  const bodyFill = view.answerable ? '#e2e8f0' : '#94a3b8';

  const listY = 22;
  const rowEls = rows.map((label, i) => {
    const index = top + i;
    const selected = index === view.cursor;
    const y = listY + i * ROW_H;
    const marker = selected
      ? `<rect x="${LIST_X - 8}" y="${y - 15}" width="${LIST_W + 16}" height="${ROW_H - 2}" rx="5" fill="${accent}" opacity="0.20"/>`
        + `<rect x="${LIST_X - 8}" y="${y - 15}" width="3" height="${ROW_H - 2}" rx="1.5" fill="${accent}"/>`
      : '';
    return marker
      + `<text x="${LIST_X + 6}" y="${y}" font-family="${FONT}" font-size="13"`
      + ` font-weight="${selected ? '800' : '600'}"`
      + ` fill="${selected ? '#f8fafc' : bodyFill}" opacity="${selected ? '1' : '0.8'}">`
      + `${escXml(clip(`${index + 1}. ${label}`, 62))}</text>`;
  }).join('');

  // E1 panel: what is being asked, and where the cursor sits in the list.
  const counter = `${view.cursor + 1}/${view.labels.length}`;
  const hint = view.answerable ? 'Rotate · Press' : 'ターミナルで回答';
  const head = [
    `<text x="16" y="26" font-family="${FONT}" font-size="13" font-weight="800" fill="${accent}">`
      + `${escXml(view.answerable ? '選択してください' : '確認待ち')}</text>`,
    `<text x="16" y="48" font-family="${FONT}" font-size="11" font-weight="600" fill="${bodyFill}" opacity="0.85">`
      + `${escXml(clip(view.question ?? '', 24))}</text>`,
    `<text x="16" y="72" font-family="${FONT}" font-size="14" font-weight="800" fill="#f8fafc">${counter}</text>`,
    `<text x="16" y="90" font-family="${FONT}" font-size="10" font-weight="600" fill="${bodyFill}" opacity="0.75">`
      + `${escXml(hint)}</text>`,
  ].join('');

  const scrollHint = view.labels.length > VISIBLE_ROWS
    ? `<text x="${TOTAL_W - 16}" y="92" text-anchor="end" font-family="${FONT}" font-size="10" fill="${bodyFill}" opacity="0.7">`
      + `${top > 0 ? '▲' : ''}${top + VISIBLE_ROWS < view.labels.length ? '▼' : ''}</text>`
    : '';

  const content = [
    `<rect x="8" y="6" width="${TOTAL_W - 16}" height="${H - 12}" rx="14" fill="#0f172a" opacity="0.9" stroke="${accent}" stroke-width="2" stroke-opacity="0.45"/>`,
    `<line x1="${SLICE_W}" y1="14" x2="${SLICE_W}" y2="${H - 14}" stroke="${accent}" stroke-width="1" stroke-opacity="0.3"/>`,
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
