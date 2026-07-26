/**
 * Recent project directories, recovered from Claude Code's own transcripts.
 *
 * The "new task" affordance needs somewhere to start the session, and asking
 * the user to configure a project list would make the feature useless until
 * they did. Every transcript record carries the `cwd` it ran in, so the list
 * builds itself from work already done — no setup, no settings key.
 *
 * Directory names under `~/.claude/projects/` are a lossy encoding of the path
 * (separators and spaces both become `-`), so the `cwd` field is read instead of
 * the folder name.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { basename, join } from 'path';
import { homedir } from 'os';
import { debug } from './logger.js';

function projectsDir(): string {
  const base = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  return join(base, 'projects');
}

export interface RecentProject {
  /** Absolute path the session ran in. */
  path: string;
  /** Trailing folder name, for display on a 200px LCD. */
  name: string;
  /** Epoch ms of the newest record seen for this path. */
  lastActiveAt: number;
}

export interface RecentProjectOptions {
  /** Cap the list — the dial rolls through these, so a long list is unusable. */
  limit?: number;
  /** Ignore transcripts untouched for longer than this. Default 30 days. */
  windowDays?: number;
  /** Override the projects directory (tests). */
  dir?: string;
  /** Override "now" (tests). */
  now?: number;
}

const DEFAULT_LIMIT = 5;

/**
 * Read only the tail of a transcript: `cwd` is identical on every record, so
 * the last non-empty line answers both "where" and "when" without parsing
 * megabytes of conversation.
 */
function readTail(path: string): { cwd?: string; ts?: number } {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return {};
  }
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as Record<string, any>;
      if (typeof row.cwd === 'string' && row.cwd) {
        const ts = Date.parse(row.timestamp);
        return { cwd: row.cwd, ts: Number.isNaN(ts) ? undefined : ts };
      }
    } catch {
      continue; // torn final line while Claude Code is mid-write
    }
  }
  return {};
}

export function listRecentProjects(opts: RecentProjectOptions = {}): RecentProject[] {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const now = opts.now ?? Date.now();
  const cutoff = now - (opts.windowDays ?? 30) * 86_400_000;
  const root = opts.dir ?? projectsDir();

  const byPath = new Map<string, RecentProject>();

  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return []; // no history yet — an empty list is the honest answer
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    let files;
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const file of files) {
      const full = join(dir, file);
      let mtime: number;
      try {
        mtime = statSync(full).mtimeMs;
      } catch {
        continue;
      }
      if (mtime < cutoff) continue;

      const { cwd, ts } = readTail(full);
      if (!cwd) continue;
      // Prefer the record timestamp; fall back to mtime when the tail had none.
      const lastActiveAt = ts ?? mtime;
      const existing = byPath.get(cwd);
      if (!existing || lastActiveAt > existing.lastActiveAt) {
        byPath.set(cwd, { path: cwd, name: basename(cwd) || cwd, lastActiveAt });
      }
    }
  }

  const list = [...byPath.values()]
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    .slice(0, limit);
  debug('RecentProjects', `${list.length} project(s) from ${entries.length} dir(s)`);
  return list;
}
