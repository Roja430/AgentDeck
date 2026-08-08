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
 * the folder name — the directory the session spent most of its records in. See
 * `readTranscript` for why neither the last nor the first one works.
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
 * Where a transcript's session did its work, and when it was last active.
 *
 * `cwd` is **not** constant across a transcript — the earlier code assumed it
 * was and read only the tail. An agent that runs `cd` mid-session writes the
 * new directory onto every subsequent record, so the tail reports wherever the
 * session happened to end up. On one machine, four of the recent transcripts
 * carried between two and nine different values; one ended in a `bridge/`
 * subdirectory it had visited for 153 records out of 4329, and the launcher
 * duly offered "bridge" as a project.
 *
 * That is worse than cosmetic. It moves an entry's identity around under the
 * user, and it defeats the exclusion list — a hidden project reappears the
 * moment a session inside it cd's one level down and reports a path the
 * exclusion does not name.
 *
 * The fix is **the directory the session spent the most records in**, ties
 * going to the one seen first.
 *
 * The launch directory is the tempting alternative, and it is wrong here: many
 * people start `claude` in a workspace folder holding several projects and then
 * cd into whichever one they mean to work on. Reading the head names the
 * workspace every time and collapses the whole list to one entry. Reading the
 * majority names the project, and a detour of a few dozen records can never
 * outvote the thousands the real work leaves behind — which is exactly the
 * stability the exclusion list needs.
 *
 * The timestamp comes from the end of the file: that is the recency question,
 * and the last record is the right answer to it.
 */
function readTranscript(path: string): { cwd?: string; ts?: number } {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return {};
  }
  const lines = raw.split('\n');

  const parse = (line: string): Record<string, any> | null => {
    if (!line.trim()) return null;
    try {
      return JSON.parse(line) as Record<string, any>;
    } catch {
      return null; // torn final line while Claude Code is mid-write
    }
  };

  // Insertion order is the first-seen order, so a plain scan for the maximum
  // resolves ties toward the earlier directory without extra bookkeeping.
  const counts = new Map<string, number>();
  let ts: number | undefined;
  for (const line of lines) {
    const row = parse(line);
    if (!row) continue;
    if (typeof row.cwd === 'string' && row.cwd) {
      counts.set(row.cwd, (counts.get(row.cwd) ?? 0) + 1);
    }
    const parsed = Date.parse(row.timestamp);
    if (!Number.isNaN(parsed)) ts = parsed;
  }

  let cwd: string | undefined;
  let best = 0;
  for (const [candidate, n] of counts) {
    if (n > best) {
      best = n;
      cwd = candidate;
    }
  }

  return { cwd, ts };
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

      const { cwd, ts } = readTranscript(full);
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
