/**
 * SVG pixmap for the session navigation dial (200x100 encoder LCD).
 *
 * Shows one session at a time — the one rotation has landed on — with its
 * position in the list, so the dial reads like a rolodex rather than a menu.
 */
import type { SessionInfo } from '@agentdeck/shared';

const W = 200;
const H = 100;

/** Semantic state colours, matching the keypad's session tiles. */
const STATE_COLOR: Record<string, string> = {
  idle: '#34d399',
  processing: '#fbbf24',
  awaiting: '#f59e0b',
  error: '#f87171',
  disconnected: '#64748b',
};

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function svgWrap(inner: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${inner}</svg>`;
}

function accentBar(color: string, fillRatio = 1): string {
  const barW = Math.max(2, Math.round(180 * fillRatio));
  return `<rect x="10" y="90" width="180" height="2" rx="1" fill="#1e293b"/>
    <rect x="10" y="90" width="${barW}" height="2" rx="1" fill="${color}" opacity="0.4"/>`;
}

/** Trim to fit 200px at 16px — the LCD has no wrapping. */
function fit(s: string, max = 20): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export interface SessionDialData {
  sessions: SessionInfo[];
  /** Index the dial has rotated to. */
  cursor: number;
  /** Session the daemon currently considers focused. */
  focusedId?: string;
}

export function renderSessionDial(data: SessionDialData): string {
  const { sessions, cursor, focusedId } = data;

  if (sessions.length === 0) {
    return svgWrap(`
      <rect width="${W}" height="${H}" fill="#0f172a"/>
      <text x="100" y="18" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" font-weight="bold" fill="#94a3b8">SESSIONS</text>
      <text x="100" y="56" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" fill="#64748b">none running</text>
      ${accentBar('#64748b', 0)}
    `);
  }

  const idx = Math.min(Math.max(cursor, 0), sessions.length - 1);
  const s = sessions[idx];
  const state = (s.state ?? 'disconnected').toLowerCase();
  const color = STATE_COLOR[state] ?? '#64748b';
  const isFocused = focusedId != null && s.id === focusedId;

  // The counter is what makes rotation legible when sessions outnumber keys.
  const counter = `${idx + 1}/${sessions.length}`;
  const detail = s.currentTool
    ? fit(s.currentTool, 22)
    : fit((s.modelName ?? state).replace(/^claude-/, ''), 22);

  return svgWrap(`
    <rect width="${W}" height="${H}" fill="#0f172a"/>
    <text x="10" y="18" text-anchor="start" font-family="Arial,sans-serif" font-size="14" font-weight="bold" fill="#94a3b8">SESSIONS</text>
    <text x="190" y="18" text-anchor="end" font-family="monospace" font-size="12" fill="#64748b">${counter}</text>
    <text x="100" y="50" text-anchor="middle" font-family="Arial,sans-serif" font-size="18" font-weight="bold" fill="${color}">${esc(fit(s.projectName || s.id, 18))}</text>
    <text x="100" y="70" text-anchor="middle" font-family="monospace" font-size="11" fill="#64748b">${esc(detail)}</text>
    ${isFocused ? `<circle cx="10" cy="46" r="3" fill="${color}"/>` : ''}
    ${accentBar(color, (idx + 1) / sessions.length)}
  `);
}
