import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { listRecentProjects } from '../recent-projects.js';

const NOW = Date.parse('2026-07-26T12:00:00Z');
const DAY = 86_400_000;

describe('listRecentProjects', () => {
  let root: string;

  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'agentdeck-recent-')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** Transcripts encode the real path in `cwd`; the folder name is lossy. */
  function transcript(dirName: string, file: string, cwd: string, ts: number, mtime = ts): void {
    const dir = join(root, dirName);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, file);
    const lines = [
      JSON.stringify({ type: 'user', cwd, timestamp: new Date(ts - 1000).toISOString() }),
      JSON.stringify({ type: 'assistant', cwd, timestamp: new Date(ts).toISOString() }),
    ];
    writeFileSync(path, lines.join('\n') + '\n', 'utf-8');
    utimesSync(path, new Date(mtime), new Date(mtime));
  }

  const scan = (over = {}) => listRecentProjects({ dir: root, now: NOW, ...over });

  it('recovers the real path from cwd, not the encoded folder name', () => {
    // The folder name flattens both separators and spaces into dashes.
    transcript('C--Users-me-Claude-Code', 's1.jsonl', 'C:\\Users\\me\\Claude Code', NOW);
    expect(scan()).toEqual([
      { path: 'C:\\Users\\me\\Claude Code', name: 'Claude Code', lastActiveAt: NOW },
    ]);
  });

  it('orders by most recent activity', () => {
    transcript('a', 's.jsonl', '/work/old', NOW - 5 * DAY);
    transcript('b', 's.jsonl', '/work/new', NOW - 1000);
    expect(scan().map((p) => p.name)).toEqual(['new', 'old']);
  });

  it('collapses several transcripts of one project to its newest', () => {
    transcript('a', 's1.jsonl', '/work/proj', NOW - 3 * DAY);
    transcript('a', 's2.jsonl', '/work/proj', NOW - 1000);
    const list = scan();
    expect(list).toHaveLength(1);
    expect(list[0].lastActiveAt).toBe(NOW - 1000);
  });

  it('caps the list so the dial stays rollable', () => {
    for (let i = 0; i < 9; i++) transcript(`p${i}`, 's.jsonl', `/work/p${i}`, NOW - i * 1000);
    expect(scan({ limit: 3 })).toHaveLength(3);
  });

  it('drops projects untouched for longer than the window', () => {
    transcript('old', 's.jsonl', '/work/stale', NOW - 60 * DAY, NOW - 60 * DAY);
    expect(scan({ windowDays: 30 })).toEqual([]);
  });

  it('skips transcripts with no cwd rather than inventing one', () => {
    const dir = join(root, 'x');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 's.jsonl'), JSON.stringify({ type: 'user' }) + '\n', 'utf-8');
    expect(scan()).toEqual([]);
  });

  it('tolerates a torn final line', () => {
    const dir = join(root, 'x');
    mkdirSync(dir, { recursive: true });
    const lines = [
      JSON.stringify({ type: 'assistant', cwd: '/work/p', timestamp: new Date(NOW).toISOString() }),
      '{"type":"assist',
    ];
    writeFileSync(join(dir, 's.jsonl'), lines.join('\n') + '\n', 'utf-8');
    expect(scan().map((p) => p.path)).toEqual(['/work/p']);
  });

  it('returns nothing when there is no history directory', () => {
    expect(listRecentProjects({ dir: join(root, 'nope'), now: NOW })).toEqual([]);
  });

  describe('home directory', () => {
    // Running `claude` without cd-ing anywhere records the home directory as a
    // project. It is not one, and being recent it outranks real work on a list
    // capped at five.
    it('is left out of the list', () => {
      transcript('home', 's.jsonl', '/home/me', NOW);
      transcript('proj', 's.jsonl', '/work/real', NOW - DAY);
      expect(scan({ home: '/home/me' }).map((p) => p.path)).toEqual(['/work/real']);
    });

    it('is matched despite a trailing separator', () => {
      transcript('home', 's.jsonl', '/home/me/', NOW);
      expect(scan({ home: '/home/me' })).toEqual([]);
    });

    it('still keeps directories nested under home', () => {
      transcript('nested', 's.jsonl', '/home/me/code/app', NOW);
      expect(scan({ home: '/home/me' }).map((p) => p.path)).toEqual(['/home/me/code/app']);
    });
  });
});
