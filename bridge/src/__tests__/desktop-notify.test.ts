import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resetNotificationSettingsCache } from '@agentdeck/shared';
import {
  buildWindowsToastScript,
  clearAttention,
  encodePowerShellCommand,
  notifyAttention,
  resetNotifyState,
} from '../desktop-notify.js';

const notice = { sessionId: 'sess-1', title: 'AgentDeck', body: 'demo needs permission' };

describe('toast script construction', () => {
  it('escapes XML metacharacters in the body', () => {
    // A project literally named `Foo & <Bar>` must not break the toast document.
    const script = buildWindowsToastScript({ ...notice, body: 'Foo & <Bar> "quoted"' });
    expect(script).toContain('Foo &amp; &lt;Bar&gt;');
    expect(script).not.toContain('<Bar>');
  });

  it("cannot be broken out of by an apostrophe in the project name", () => {
    // XML escaping runs first, so `'` becomes `&apos;` and never reaches the
    // single-quoted PowerShell literal as a raw quote. That ordering is the
    // safety property — assert the outcome, not the mechanism.
    const script = buildWindowsToastScript({ ...notice, body: "it's fine" });
    expect(script).toContain('it&apos;s fine');
    const literal = /\$d\.LoadXml\('((?:[^']|'')*)'\)/.exec(script);
    expect(literal).not.toBeNull();
    expect(literal![1]).not.toContain("'");
  });

  it('tags and groups the toast so a repeat replaces rather than stacks', () => {
    const script = buildWindowsToastScript(notice);
    expect(script).toContain("$t.Tag='sess-1'");
    expect(script).toContain("$t.Group='agentdeck'");
  });

  it('caps an over-long session id rather than emitting an invalid tag', () => {
    const script = buildWindowsToastScript({ ...notice, sessionId: 'x'.repeat(200) });
    const tag = /\$t\.Tag='(x+)'/.exec(script)?.[1] ?? '';
    expect(tag.length).toBe(64);
  });

  it('encodes as UTF-16LE base64, which is what -EncodedCommand expects', () => {
    const encoded = encodePowerShellCommand('echo hi');
    expect(Buffer.from(encoded, 'base64').toString('utf16le')).toBe('echo hi');
  });
});

describe('notifyAttention gating', () => {
  let dir: string;
  const original = process.env.AGENTDECK_DATA_DIR;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentdeck-notify-'));
    process.env.AGENTDECK_DATA_DIR = dir;
    resetNotificationSettingsCache();
    resetNotifyState();
  });

  afterEach(() => {
    if (original === undefined) delete process.env.AGENTDECK_DATA_DIR;
    else process.env.AGENTDECK_DATA_DIR = original;
    rmSync(dir, { recursive: true, force: true });
    resetNotificationSettingsCache();
    resetNotifyState();
  });

  function settings(value: unknown): void {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify(value), 'utf-8');
    resetNotificationSettingsCache();
  }

  it('suppresses a repeat for the same session inside the window', () => {
    const t0 = 1_000_000;
    expect(notifyAttention(notice, t0)).toBe(true);
    expect(notifyAttention(notice, t0 + 5_000)).toBe(false);
  });

  it('notifies again once the window has passed', () => {
    const t0 = 1_000_000;
    notifyAttention(notice, t0);
    expect(notifyAttention(notice, t0 + 61_000)).toBe(true);
  });

  it('tracks the window per session, not globally', () => {
    const t0 = 1_000_000;
    expect(notifyAttention(notice, t0)).toBe(true);
    expect(notifyAttention({ ...notice, sessionId: 'sess-2' }, t0 + 1)).toBe(true);
  });

  it('re-arms a session that stopped waiting', () => {
    const t0 = 1_000_000;
    notifyAttention(notice, t0);
    clearAttention(notice.sessionId);
    expect(notifyAttention(notice, t0 + 1)).toBe(true);
  });

  it('honours notifications.attention = false', () => {
    settings({ notifications: { attention: false } });
    expect(notifyAttention(notice, 1_000_000)).toBe(false);
  });

  it('honours a custom repeat window', () => {
    settings({ notifications: { repeatWindowMs: 1000 } });
    const t0 = 1_000_000;
    notifyAttention(notice, t0);
    expect(notifyAttention(notice, t0 + 500)).toBe(false);
    expect(notifyAttention(notice, t0 + 1500)).toBe(true);
  });
});
