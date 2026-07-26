/**
 * Agent-control dial — two pages, and what counts as "already active".
 *
 * The dial writes into a live prompt on press, so the entry under the cursor
 * has to be exactly what the user read off the LCD: a catalog arriving mid-roll
 * must not slide the selection onto a different model, and a page swap must not
 * carry a cursor across.
 */
import { describe, expect, it } from 'vitest';
import type { ModelCatalogEntry } from '@agentdeck/shared';
import { PermissionMode } from '@agentdeck/shared';
import {
  AgentDialState,
  FALLBACK_MODELS,
  OFFERED_MODES,
  buildModelEntries,
  buildModeEntries,
  isSameModel,
} from '../agent-dial-state.js';

const catalog = (over: Partial<ModelCatalogEntry>[] = []): ModelCatalogEntry[] =>
  over.map((o, i) => ({
    key: `m${i}`, name: `Model ${i}`, role: 'configured', available: true, ...o,
  }));

describe('page contents', () => {
  it('lists the catalog models when there is a catalog', () => {
    const entries = buildModelEntries(catalog([{ key: 'sonnet', name: 'Sonnet 5' }]));
    expect(entries).toEqual([{ kind: 'model', label: 'Sonnet 5', value: 'sonnet' }]);
  });

  it('drops models the account cannot reach', () => {
    const entries = buildModelEntries(catalog([{ key: 'ok' }, { key: 'nope', available: false }]));
    expect(entries.map((e) => e.value)).toEqual(['ok']);
  });

  it('falls back to the CLI aliases when no catalog arrives', () => {
    // `modelCatalog` only ever comes from the OpenClaw adapter, so for a Claude
    // session it stays empty forever — a catalog-only page offered no models
    // and the dial read "No session".
    expect(buildModelEntries([]).map((e) => e.value)).toEqual(FALLBACK_MODELS.map((m) => m.key));
  });

  it('falls back rather than emptying when every model is unavailable', () => {
    const entries = buildModelEntries(catalog([{ key: 'nope', available: false }]));
    expect(entries).toHaveLength(FALLBACK_MODELS.length);
  });

  it('leaves the blanket-approval modes off the dial', () => {
    const values = buildModeEntries().map((e) => e.value);
    expect(values).toHaveLength(OFFERED_MODES.length);
    expect(values).not.toContain(PermissionMode.BYPASS_PERMISSIONS);
    expect(values).not.toContain(PermissionMode.DONT_ASK);
  });
});

describe('AgentDialState pages', () => {
  it('starts on the model page and swaps on tap', () => {
    const s = new AgentDialState();
    expect(s.getPage()).toBe('model');
    expect(s.togglePage()).toBe('mode');
    expect(s.current()?.kind).toBe('mode');
    expect(s.togglePage()).toBe('model');
  });

  it('keeps a separate cursor per page', () => {
    const s = new AgentDialState();
    s.rotate(1);
    const modelPick = s.current()?.value;

    s.togglePage();
    s.rotate(1);
    const modePick = s.current()?.value;
    expect(modePick).not.toBe(modelPick);

    // Coming back must land where the user left, not at the top.
    s.togglePage();
    expect(s.current()?.value).toBe(modelPick);
    s.togglePage();
    expect(s.current()?.value).toBe(modePick);
  });

  it('rotates only within the current page', () => {
    const s = new AgentDialState();
    const models = s.getEntries().length;
    for (let i = 0; i < models; i++) s.rotate(1);
    expect(s.getCursor()).toBe(0);
    expect(s.current()?.kind).toBe('model');
  });

  it('wraps in both directions', () => {
    const s = new AgentDialState();
    const total = s.getEntries().length;
    s.rotate(-1);
    expect(s.getCursor()).toBe(total - 1);
    s.rotate(1);
    expect(s.getCursor()).toBe(0);
  });
});

describe('AgentDialState catalog and active marker', () => {
  it('keeps the cursor on the same model when the catalog changes', () => {
    const s = new AgentDialState();
    s.setCatalog(catalog([{ key: 'a' }, { key: 'b' }]));
    s.rotate(1); // → b
    expect(s.current()?.value).toBe('b');

    // A model appears ahead of b — the cursor must follow b, not the index.
    s.setCatalog(catalog([{ key: 'new' }, { key: 'a' }, { key: 'b' }]));
    expect(s.current()?.value).toBe('b');
  });

  it('clamps the model cursor when the catalog shrinks under it', () => {
    const s = new AgentDialState();
    s.setCatalog(catalog([{ key: 'a' }, { key: 'b' }, { key: 'c' }]));
    s.rotate(1); s.rotate(1); // → c
    s.setCatalog(catalog([{ key: 'a' }]));
    expect(s.getCursor()).toBeLessThan(s.getEntries().length);
    expect(s.current()).toBeDefined();
  });

  it('marks the entry in effect on each page', () => {
    const s = new AgentDialState();
    s.setCatalog(catalog([{ key: 'sonnet', name: 'Sonnet 5' }]));
    s.setActive('Sonnet 5', PermissionMode.ACCEPT_EDITS);
    expect(s.isCurrentActive()).toBe(true);

    s.togglePage();
    while (s.current()?.value !== PermissionMode.ACCEPT_EDITS) s.rotate(1);
    expect(s.isCurrentActive()).toBe(true);
    s.rotate(1);
    expect(s.isCurrentActive()).toBe(false);
  });
});

describe('isSameModel', () => {
  // The catalog carries keys and the agent reports display names; neither side
  // promises the other's spelling, and showing nothing as active is worse than
  // matching loosely.
  it('matches a key against the reported display name', () => {
    expect(isSameModel('sonnet', 'Sonnet 5')).toBe(true);
    expect(isSameModel('claude-opus-5', 'claude-opus-5')).toBe(true);
    expect(isSameModel('opus', 'Claude Opus 5')).toBe(true);
  });

  it('does not match a different model or a missing report', () => {
    expect(isSameModel('sonnet', 'Opus 5')).toBe(false);
    expect(isSameModel('sonnet', undefined)).toBe(false);
  });
});
