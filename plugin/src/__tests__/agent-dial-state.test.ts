/**
 * Agent-control dial — the roll and what counts as "already active".
 *
 * The dial writes into a live prompt on press, so the entry under the cursor
 * has to be exactly what the user read off the LCD: a catalog arriving mid-roll
 * must not slide the selection onto a different model.
 */
import { describe, expect, it } from 'vitest';
import type { ModelCatalogEntry } from '@agentdeck/shared';
import { PermissionMode } from '@agentdeck/shared';
import {
  AgentDialState,
  OFFERED_MODES,
  buildAgentEntries,
  isSameModel,
  FALLBACK_MODELS,
} from '../agent-dial-state.js';

const catalog = (over: Partial<ModelCatalogEntry>[] = []): ModelCatalogEntry[] =>
  over.map((o, i) => ({
    key: `m${i}`, name: `Model ${i}`, role: 'configured', available: true, ...o,
  }));

describe('buildAgentEntries', () => {
  it('puts models first and modes last', () => {
    const entries = buildAgentEntries(catalog([{ key: 'sonnet', name: 'Sonnet 5' }]));
    expect(entries.map((e) => e.kind)).toEqual(['model', ...OFFERED_MODES.map(() => 'mode')]);
    expect(entries[0]).toMatchObject({ kind: 'model', label: 'Sonnet 5', value: 'sonnet' });
  });

  it('drops models the account cannot reach', () => {
    const entries = buildAgentEntries(catalog([
      { key: 'ok', available: true },
      { key: 'nope', available: false },
    ]));
    expect(entries.filter((e) => e.kind === 'model').map((e) => e.value)).toEqual(['ok']);
  });

  it('falls back to the CLI aliases when no catalog arrives', () => {
    // `modelCatalog` only ever comes from the OpenClaw adapter, so for a Claude
    // session it stays empty forever — a catalog-only roll offered no models
    // and the dial read "No session".
    const entries = buildAgentEntries([]);
    const models = entries.filter((e) => e.kind === 'model').map((e) => e.value);
    expect(models).toEqual(FALLBACK_MODELS.map((m) => m.key));
    expect(entries.filter((e) => e.kind === 'mode')).toHaveLength(OFFERED_MODES.length);
  });

  it('prefers a real catalog over the fallback once one arrives', () => {
    const entries = buildAgentEntries(catalog([{ key: 'sonnet' }]));
    expect(entries.filter((e) => e.kind === 'model').map((e) => e.value)).toEqual(['sonnet']);
  });

  it('falls back rather than emptying when every model is unavailable', () => {
    const entries = buildAgentEntries(catalog([{ key: 'nope', available: false }]));
    expect(entries.filter((e) => e.kind === 'model').length).toBe(FALLBACK_MODELS.length);
  });

  it('leaves the blanket-approval modes off the dial', () => {
    const values = buildAgentEntries([]).map((e) => e.value);
    expect(values).not.toContain(PermissionMode.BYPASS_PERMISSIONS);
    expect(values).not.toContain(PermissionMode.DONT_ASK);
  });
});

describe('AgentDialState', () => {
  it('keeps the cursor on the same entry when the catalog changes', () => {
    const s = new AgentDialState();
    s.setCatalog(catalog([{ key: 'a' }, { key: 'b' }]));
    s.rotate(1); // → b
    expect(s.current()?.value).toBe('b');

    // A model appears ahead of b — the cursor must follow b, not the index.
    s.setCatalog(catalog([{ key: 'new' }, { key: 'a' }, { key: 'b' }]));
    expect(s.current()?.value).toBe('b');
  });

  it('clamps the cursor when the list shrinks under it', () => {
    const s = new AgentDialState();
    s.setCatalog(catalog([{ key: 'a' }, { key: 'b' }, { key: 'c' }]));
    while (s.getCursor() < s.getEntries().length - 1) s.rotate(1); // → last entry
    s.setCatalog(catalog([{ key: 'a' }]));
    expect(s.getCursor()).toBeLessThan(s.getEntries().length);
    expect(s.current()).toBeDefined();
  });

  it('wraps in both directions', () => {
    const s = new AgentDialState();
    s.setCatalog(catalog([{ key: 'a' }]));
    const total = s.getEntries().length;
    s.rotate(-1);
    expect(s.getCursor()).toBe(total - 1);
    s.rotate(1);
    expect(s.getCursor()).toBe(0);
  });

  it('marks the entry in effect for both kinds', () => {
    const s = new AgentDialState();
    s.setCatalog(catalog([{ key: 'sonnet', name: 'Sonnet 5' }]));
    s.setActive('Sonnet 5', PermissionMode.ACCEPT_EDITS);
    expect(s.isCurrentActive()).toBe(true);

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
