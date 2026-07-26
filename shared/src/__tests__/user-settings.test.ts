import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  DEFAULT_WARN_AT_PERCENT,
  budgetStateFor,
  loadCostSettings,
  resetCostSettingsCache,
} from '../user-settings.js';

describe('loadCostSettings', () => {
  let dir: string;
  const original = process.env.AGENTDECK_DATA_DIR;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentdeck-cost-settings-'));
    process.env.AGENTDECK_DATA_DIR = dir;
    resetCostSettingsCache();
  });

  afterEach(() => {
    if (original === undefined) delete process.env.AGENTDECK_DATA_DIR;
    else process.env.AGENTDECK_DATA_DIR = original;
    rmSync(dir, { recursive: true, force: true });
    resetCostSettingsCache();
  });

  function write(settings: unknown): void {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings), 'utf-8');
    resetCostSettingsCache();
  }

  it('has no budget by default', () => {
    // A budget nobody set would paint the encoder red on a normal day.
    expect(loadCostSettings().dailyBudgetUsd).toBeNull();
    expect(loadCostSettings().warnAtPercent).toBe(DEFAULT_WARN_AT_PERCENT);
  });

  it('reads the budget and warn threshold', () => {
    write({ cost: { dailyBudgetUsd: 25, warnAtPercent: 60 } });
    expect(loadCostSettings()).toEqual({ dailyBudgetUsd: 25, warnAtPercent: 60 });
  });

  it('treats zero and negative budgets as unset', () => {
    write({ cost: { dailyBudgetUsd: 0 } });
    expect(loadCostSettings().dailyBudgetUsd).toBeNull();
    write({ cost: { dailyBudgetUsd: -5 } });
    expect(loadCostSettings().dailyBudgetUsd).toBeNull();
  });

  it('ignores a nonsensical warn threshold rather than adopting it', () => {
    write({ cost: { dailyBudgetUsd: 10, warnAtPercent: 500 } });
    expect(loadCostSettings().warnAtPercent).toBe(DEFAULT_WARN_AT_PERCENT);
  });

  it('survives a corrupt settings file', () => {
    writeFileSync(join(dir, 'settings.json'), '{ not json', 'utf-8');
    resetCostSettingsCache();
    expect(loadCostSettings().dailyBudgetUsd).toBeNull();
  });

  it('leaves unrelated settings alone', () => {
    write({ llm: { mlx: { model: 'x' } } });
    expect(loadCostSettings().dailyBudgetUsd).toBeNull();
  });
});

describe('budgetStateFor', () => {
  const settings = { dailyBudgetUsd: 20, warnAtPercent: 80 };

  it('is undefined when no budget is configured', () => {
    expect(budgetStateFor(999, { dailyBudgetUsd: null, warnAtPercent: 80 })).toBeUndefined();
  });

  it('is ok below the warn threshold', () => {
    expect(budgetStateFor(15.99, settings)).toBe('ok');
  });

  it('warns from the threshold up to the budget', () => {
    expect(budgetStateFor(16, settings)).toBe('warn');
    expect(budgetStateFor(19.99, settings)).toBe('warn');
  });

  it('is over once spend reaches the budget', () => {
    expect(budgetStateFor(20, settings)).toBe('over');
    expect(budgetStateFor(100, settings)).toBe('over');
  });
});
