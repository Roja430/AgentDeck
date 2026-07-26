/**
 * Windows equivalents of the macOS `open` calls the E4 launcher depends on.
 *
 * There is no `open -a` here, and the obvious substitute — spawning the app's
 * executable — does not work for Store-packaged apps: they live under
 * `%ProgramFiles%\WindowsApps`, which is ACL-locked against direct execution.
 * What does work is the URI scheme an app registers (Claude registers
 * `claude://`), resolved through ShellExecute. `explorer.exe <uri>` is the
 * standard way to reach ShellExecute without going through a shell.
 */
import { execFile } from 'child_process';

/** Hand a URI to the shell. */
function shellOpen(uri: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('explorer.exe', [uri], { windowsHide: true, timeout: 5000 }, (err: any) => {
      // explorer.exe reports a non-zero exit code even when it succeeded, so
      // only a failure to start it at all counts as an error here.
      if (err && (err.code === 'ENOENT' || err.code === 'EACCES')) reject(err);
      else resolve();
    });
  });
}

export function openUrl(url: string): Promise<void> {
  return shellOpen(url);
}

/** Registry answers do not change under us within a run. */
const schemeCache = new Map<string, boolean>();

/** True when some app has claimed `<scheme>://` for opening. */
function hasRegisteredScheme(scheme: string): Promise<boolean> {
  const cached = schemeCache.get(scheme);
  if (cached !== undefined) return Promise.resolve(cached);

  return new Promise((resolve) => {
    const roots = ['HKCU', 'HKLM'];
    let pending = roots.length;
    let found = false;
    for (const root of roots) {
      const key = `${root}\\SOFTWARE\\Classes\\${scheme}\\shell\\open\\command`;
      execFile('reg', ['query', key], { windowsHide: true, timeout: 3000 }, (err) => {
        if (!err) found = true;
        if (--pending === 0) {
          schemeCache.set(scheme, found);
          resolve(found);
        }
      });
    }
  });
}

/** Exported for tests — the naming rule, without touching the registry. */
export function schemeForAppName(name: string): string | null {
  // An app's URI scheme is conventionally its lowercased name (Claude →
  // claude://). That covers the agents in DEFAULT_TARGETS; anything whose name
  // is not a legal scheme is rejected rather than guessed at, so the chain
  // falls through to its `url:` step.
  const scheme = name.trim().toLowerCase();
  return /^[a-z][a-z0-9+.-]*$/.test(scheme) ? scheme : null;
}

/**
 * Launch or focus a desktop app by name.
 * Rejects when nothing has registered the scheme, so the caller's fallback
 * chain moves on to the next step — same contract as the macOS version.
 */
export async function openApp(name: string): Promise<void> {
  const scheme = schemeForAppName(name);
  if (!scheme) throw new Error(`"${name}" is not a usable URI scheme on Windows`);
  if (!(await hasRegisteredScheme(scheme))) {
    throw new Error(`No app registered for "${name}" on Windows`);
  }
  await shellOpen(`${scheme}://`);
}
