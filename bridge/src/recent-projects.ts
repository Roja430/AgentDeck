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
  /** Override the home directory, which is filtered out (tests). */
  home?: string;
  /** Override "now" (tests). */
  now?: number;
  /** Paths to hide. Defaults to `recentProjects.exclude` in settings.json. */
  exclude?: string[];
}

const DEFAULT_LIMIT = 5;

/**
 * The home directory is not a project. It appears whenever Claude Code was run
 * without cd-ing anywhere first, and because that tends to be recent it sorts
 * near the top and pushes a real project off a list capped at five. Starting a
 * new session in `~` is never what picking an entry on the dial meant.
 */
function isHomeDir(path: string, home: string): boolean {
  return samePath(path, home);
}

/**
 * Trailing separators are never meaningful. On Windows, neither is case, nor
 * the choice of slash — `C:/work` and `C:\work` are the same directory, and a
 * hand-written settings file will contain whichever one the user typed. Making
 * that the difference between the setting working and silently doing nothing
 * would be a poor trade for a stricter comparison.
 */
function samePath(a: string, b: string): boolean {
  const strip = (p: string) => p.replace(/[\\/]+$/, '');
  if (process.platform !== 'win32') return strip(a) === strip(b);
  const norm = (p: string) => strip(p).replace(/\//g, '\\').toLowerCase();
  return norm(a) === norm(b);
}

/**
 * Directories the user never wants offered as a launch target, from
 * `~/.agentdeck/settings.json`:
 *
 *     { "recentProjects": { "exclude": ["C:\\work\\scratch"] } }
 *
 * Deleting the transcripts is not a substitute: this list is derived from them,
 * so the entry returns the moment Claude Code runs there again — and deleting
 * takes the conversation history with it.
 *
 * **Exact paths only, never prefixes.** Excluding a parent would take its
 * children with it, and the case this was written for wants the opposite: the
 * parent gone from the dial while a project inside it stays.
 *
 * Read on every call rather than cached, so an edit takes effect on the next
 * list instead of on the next restart.
 */
function loadExclusions(): string[] {
  const file = join(homedir(), '.agentdeck', 'settings.json');
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, any>;
    const list = raw?.recentProjects?.exclude;
    if (!Array.isArray(list)) return [];
    return list.filter((p): p is string => typeof p === 'string' && p.trim().length > 0);
  } catch {
    // Missing or malformed. Either way there is nothing to hide, and a launcher
    // that silently empties itself over a typo is worse than one that shows an
    // entry the user wanted gone.
    return [];
  }
}

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
  const home = opts.home ?? homedir();
  const exclude = opts.exclude ?? loadExclusions();

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
      if (isHomeDir(cwd, home)) continue;
      if (exclude.some((e) => samePath(cwd, e))) continue;
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
