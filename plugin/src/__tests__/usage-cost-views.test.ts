import { describe, expect, it } from 'vitest';
import type { TranscriptCostSummary } from '@agentdeck/shared';
import { renderUsageCache, renderUsageCost } from '../renderers/usage-dial-renderer.js';
import type { UsageModeData } from '../utility-modes/usage.js';

function bucket(costUsd: number, over = {}) {
  return {
    calls: 1,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUsd,
    ...over,
  };
}

function summary(over: Partial<TranscriptCostSummary> = {}): TranscriptCostSummary {
  return {
    today: bucket(12.34),
    last7Days: bucket(56.78),
    last30Days: bucket(120),
    cacheHitRatio: 0.988,
    byModel: [{ model: 'claude-opus-5', costUsd: 90 }, { model: 'claude-sonnet-5', costUsd: 30 }],
    scannedAt: Date.now(),
    ...over,
  };
}

function data(cost?: TranscriptCostSummary): UsageModeData {
  return cost ? { transcriptCost: cost } : {};
}

describe('renderUsageCost', () => {
  it('leads with today and shows the 7d/30d totals', () => {
    const svg = renderUsageCost(data(summary()));
    expect(svg).toContain('COST · TODAY');
    expect(svg).toContain('$12.34');
    expect(svg).toContain('7d $56.78');
    expect(svg).toContain('30d $120');
  });

  it('abbreviates four-figure spend so it still fits the LCD', () => {
    const svg = renderUsageCost(data(summary({ today: bucket(1234.5) })));
    expect(svg).toContain('$1.2K');
  });

  it('marks the figure as a floor when a model is unpriced', () => {
    const svg = renderUsageCost(data(summary({ unpricedModels: ['claude-from-the-future'] })));
    expect(svg).toContain('$12.34+');
  });

  it('says so rather than showing $0.00 when there is no history', () => {
    const svg = renderUsageCost(data());
    expect(svg).toContain('no local history');
    expect(svg).not.toContain('$0.00');
  });

  it('shows the running total in green when no budget is set', () => {
    const svg = renderUsageCost(data(summary()));
    expect(svg).toContain('COST · TODAY');
    expect(svg).toContain('7d $56.78');
    expect(svg).toContain('#34d399');
  });

  it('reframes the sub-line as spend-against-budget once one is set', () => {
    const svg = renderUsageCost(data(summary({ dailyBudgetUsd: 20, budgetState: 'ok' })));
    expect(svg).toContain('of $20.00');
    expect(svg).toContain('#34d399');
  });

  it('turns amber on the warn threshold', () => {
    const svg = renderUsageCost(data(summary({
      today: bucket(17), dailyBudgetUsd: 20, budgetState: 'warn',
    })));
    expect(svg).toContain('#fbbf24');
    expect(svg).toContain('COST · TODAY');
  });

  it('calls out going over budget in the header, not just the colour', () => {
    const svg = renderUsageCost(data(summary({
      today: bucket(25), dailyBudgetUsd: 20, budgetState: 'over',
    })));
    expect(svg).toContain('COST · OVER BUDGET');
    expect(svg).toContain('#f87171');
  });
});

describe('renderUsageCache', () => {
  it('shows the hit rate and the top model by spend', () => {
    const svg = renderUsageCache(data(summary()));
    expect(svg).toContain('99%');
    expect(svg).toContain('opus-5 $90'); // "claude-" prefix trimmed to fit
  });

  it('greens a healthy ratio and reds a broken one', () => {
    expect(renderUsageCache(data(summary({ cacheHitRatio: 0.99 })))).toContain('#34d399');
    expect(renderUsageCache(data(summary({ cacheHitRatio: 0.85 })))).toContain('#fbbf24');
    expect(renderUsageCache(data(summary({ cacheHitRatio: 0.4 })))).toContain('#f87171');
  });

  it('says so rather than showing 0% when there is no history', () => {
    const svg = renderUsageCache(data());
    expect(svg).toContain('no local history');
    expect(svg).not.toContain('0%');
  });
});
