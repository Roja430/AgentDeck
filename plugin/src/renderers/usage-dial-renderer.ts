/**
 * SVG pixmap renderer for the Usage Dial (E3).
 * 200x100, #0f172a bg. Shows rate limit gauges, token counts, cost.
 * Follows shared encoder design: 14px bold header, 2px accent bar at y=90.
 */
import { formatTokens, type UsageModeData } from '../utility-modes/usage.js';

const W = 200;
const H = 100;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function svgWrap(inner: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${inner}</svg>`;
}


/** Shared accent bar: 2px at y=90, x=10..190 with dark bg + colored fill */
function accentBar(color: string, fillRatio = 1): string {
  const barW = Math.max(2, Math.round(180 * fillRatio));
  return `<rect x="10" y="90" width="180" height="2" rx="1" fill="#1e293b"/>
    <rect x="10" y="90" width="${barW}" height="2" rx="1" fill="${color}" opacity="0.4"/>`;
}





/** Session stats: tokens + cost */
export function renderUsageSession(data: UsageModeData): string {
  const inp = formatTokens(data.inputTokens);
  const out = formatTokens(data.outputTokens);
  const cost = data.estimatedCostUsd != null ? `$${data.estimatedCostUsd.toFixed(2)}` : '';
  const dur = data.sessionDurationSec != null ? formatDuration(data.sessionDurationSec) : '';

  return svgWrap(`
    <rect width="${W}" height="${H}" fill="#0f172a"/>
    <text x="100" y="18" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" font-weight="bold" fill="#94a3b8">SESSION</text>
    <text x="100" y="46" text-anchor="middle" font-family="monospace" font-size="14" fill="#60a5fa">\u25B2${esc(inp)}  \u25BC${esc(out)}</text>
    <text x="100" y="70" text-anchor="middle" font-family="Arial,sans-serif" font-size="18" font-weight="bold" fill="#ffffff">${esc(cost || '\u2014')}</text>
    ${dur ? `<text x="100" y="84" text-anchor="middle" font-family="Arial,sans-serif" font-size="10" fill="#64748b">${esc(dur)}</text>` : ''}
    ${accentBar('#60a5fa')}
  `);
}




/** `$12.34`, or `$1.2K` once the figure stops fitting at 18px. */
function formatUsd(usd: number): string {
  if (usd >= 1000) return `$${(usd / 1000).toFixed(1)}K`;
  if (usd >= 100) return `$${usd.toFixed(0)}`;
  return `$${usd.toFixed(2)}`;
}

/**
 * COST view: today's spend as the headline, 7d/30d underneath.
 *
 * This is the number the 5h/7d quota gauges cannot show — a subscription user
 * sees "62% of the 5h window" but never a dollar figure.
 */
export function renderUsageCost(data: UsageModeData): string {
  const cost = data.transcriptCost;
  if (!cost) {
    return svgWrap(`
      <rect width="${W}" height="${H}" fill="#0f172a"/>
      <text x="100" y="18" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" font-weight="bold" fill="#94a3b8">COST</text>
      <text x="100" y="58" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" fill="#64748b">no local history</text>
      ${accentBar('#34d399')}
    `);
  }

  const today = formatUsd(cost.today.costUsd);
  const week = formatUsd(cost.last7Days.costUsd);
  const month = formatUsd(cost.last30Days.costUsd);
  // Any unpriced model means the totals are a floor, not the real figure.
  const approx = cost.unpricedModels && cost.unpricedModels.length > 0;

  // With a budget set the headline becomes spend-against-budget and the accent
  // bar turns into a fuel gauge; without one it stays a plain running total.
  const budget = cost.dailyBudgetUsd;
  const state = cost.budgetState;
  const color = state === 'over' ? '#f87171' : state === 'warn' ? '#fbbf24' : '#34d399';
  const fill = budget ? Math.min(1, cost.today.costUsd / budget) : 1;
  const header = state === 'over' ? 'COST · OVER BUDGET' : 'COST · TODAY';
  const subLeft = budget ? `of ${formatUsd(budget)}` : `7d ${week}`;
  const subRight = budget ? `30d ${month}` : `30d ${month}`;

  return svgWrap(`
    <rect width="${W}" height="${H}" fill="#0f172a"/>
    <text x="100" y="18" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" font-weight="bold" fill="${state === 'over' ? color : '#94a3b8'}">${header}</text>
    <text x="100" y="52" text-anchor="middle" font-family="Arial,sans-serif" font-size="26" font-weight="bold" fill="${color}">${esc(approx ? `${today}+` : today)}</text>
    <text x="56" y="78" text-anchor="middle" font-family="monospace" font-size="12" fill="#64748b">${esc(subLeft)}</text>
    <text x="144" y="78" text-anchor="middle" font-family="monospace" font-size="12" fill="#64748b">${esc(subRight)}</text>
    ${accentBar(color, fill)}
  `);
}

/**
 * CACHE view: cache-read share of input tokens, plus the top model by spend.
 *
 * A Claude Code session is overwhelmingly cache reads; a ratio that drops means
 * the prompt prefix is being invalidated and the same work costs more.
 */
export function renderUsageCache(data: UsageModeData): string {
  const cost = data.transcriptCost;
  const ratio = cost?.cacheHitRatio;
  const top = cost?.byModel?.[0];

  if (ratio == null) {
    return svgWrap(`
      <rect width="${W}" height="${H}" fill="#0f172a"/>
      <text x="100" y="18" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" font-weight="bold" fill="#94a3b8">CACHE</text>
      <text x="100" y="58" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" fill="#64748b">no local history</text>
      ${accentBar('#a78bfa')}
    `);
  }

  const pct = Math.round(ratio * 100);
  // Claude Code sits near 99% when caching is healthy, so the warning band is
  // high: below 80% something is invalidating the prefix every turn.
  const color = pct >= 90 ? '#34d399' : pct >= 80 ? '#fbbf24' : '#f87171';
  const topLine = top ? `${top.model.replace(/^claude-/, '')} ${formatUsd(top.costUsd)}` : '';

  return svgWrap(`
    <rect width="${W}" height="${H}" fill="#0f172a"/>
    <text x="100" y="18" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" font-weight="bold" fill="#94a3b8">CACHE HITS</text>
    <text x="100" y="52" text-anchor="middle" font-family="Arial,sans-serif" font-size="26" font-weight="bold" fill="${color}">${pct}%</text>
    ${topLine ? `<text x="100" y="78" text-anchor="middle" font-family="monospace" font-size="11" fill="#64748b">${esc(topLine)}</text>` : ''}
    ${accentBar(color, ratio)}
  `);
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return `${m}m${s > 0 ? ` ${s}s` : ''}`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h${rm > 0 ? ` ${rm}m` : ''}`;
}
