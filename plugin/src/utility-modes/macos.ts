/**
 * macOS system control via osascript.
 * Uses execFile (no shell) for safety. Debounced execution for rapid dial rotation.
 */
import { execFile } from 'child_process';

/** `osascript` exists only on macOS. */
export const HAS_OSASCRIPT = process.platform === 'darwin';

// ---- Core executor ----

function osascript(script: string): Promise<string> {
  // Reject without spawning off macOS. The volume dial polls this on a timer,
  // so an unguarded call meant a doomed process every two seconds for the whole
  // life of the plugin on Windows and Linux — plus an ENOENT warning per tick.
  if (!HAS_OSASCRIPT) {
    return Promise.reject(new Error('osascript is macOS-only'));
  }
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

/**
 * Debounced osascript execution per channel key.
 * Coalesces rapid calls (e.g. fast dial rotation) — only the final value commits.
 */
const debounceMap = new Map<string, ReturnType<typeof setTimeout>>();

function debouncedExec(key: string, script: string, delayMs = 100): void {
  const existing = debounceMap.get(key);
  if (existing) clearTimeout(existing);
  debounceMap.set(key, setTimeout(() => {
    debounceMap.delete(key);
    osascript(script).catch(() => {});
  }, delayMs));
}

// ---- Volume ----

export interface VolumeSettings {
  outputVolume: number;
  outputMuted: boolean;
}

export async function getVolumeSettings(): Promise<VolumeSettings> {
  const raw = await osascript('get volume settings');
  // "output volume:65, input volume:80, alert volume:100, output muted:false"
  const num = (key: string): number | null => {
    const m = new RegExp(`${key}:(\\d+)`).exec(raw);
    return m ? parseInt(m[1], 10) : null;
  };
  return {
    outputVolume: num('output volume') ?? 0,
    outputMuted: /output muted:true/.test(raw),
  };
}

export function setOutputVolume(vol: number): void {
  debouncedExec('output-volume', `set volume output volume ${Math.round(vol)}`);
}

/** Rejects on failure so the caller can surface it (showAlert) — see utility-dial. */
export function setOutputMuted(muted: boolean): Promise<string> {
  return osascript(`set volume output muted ${muted}`);
}

// ---- Browser Tab Focus ----

const CHROMIUM_BROWSERS = ['Google Chrome', 'Brave Browser', 'Microsoft Edge', 'Arc'] as const;
const SEARCHABLE_BROWSERS = [...CHROMIUM_BROWSERS, 'Safari'] as const;

/** Get list of searchable browsers currently running. */
async function getRunningBrowsers(): Promise<string[]> {
  const names = SEARCHABLE_BROWSERS.map(b => `"${b}"`).join(', ');
  try {
    const result = await osascript(
      `tell application "System Events" to get name of every process whose name is in {${names}}`,
    );
    if (!result) return [];
    return result.split(', ').filter(n => (SEARCHABLE_BROWSERS as readonly string[]).includes(n));
  } catch {
    return [];
  }
}

/** Try to focus an existing tab matching urlPrefix in the given browser. */
async function focusBrowserTab(browser: string, urlPrefix: string): Promise<boolean> {
  const escaped = urlPrefix.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const isChromium = (CHROMIUM_BROWSERS as readonly string[]).includes(browser);

  const script = isChromium
    ? `tell application "${browser}"
  set wIndex to 0
  repeat with w in windows
    set wIndex to wIndex + 1
    set tIndex to 0
    repeat with t in tabs of w
      set tIndex to tIndex + 1
      if URL of t starts with "${escaped}" then
        set active tab index of w to tIndex
        set index of w to 1
        activate
        return "found"
      end if
    end repeat
  end repeat
end tell
return "notfound"`
    : `tell application "Safari"
  set wIndex to 0
  repeat with w in windows
    set wIndex to wIndex + 1
    set tIndex to 0
    repeat with t in tabs of w
      set tIndex to tIndex + 1
      if URL of t starts with "${escaped}" then
        set current tab of w to t
        set index of w to 1
        activate
        return "found"
      end if
    end repeat
  end repeat
end tell
return "notfound"`;

  try {
    const result = await osascript(script);
    return result === 'found';
  } catch {
    return false;
  }
}

/**
 * Focus an existing browser tab matching urlPrefix, or open a new one.
 * Searches running Chromium browsers and Safari. Falls back to `open` command.
 */
export async function openOrFocusBrowserTab(urlPrefix: string): Promise<void> {
  const browsers = await getRunningBrowsers();
  for (const browser of browsers) {
    const found = await focusBrowserTab(browser, urlPrefix);
    if (found) return;
  }
  // No existing tab found — open normally
  await new Promise<void>((resolve, reject) => {
    execFile('open', [urlPrefix], { timeout: 3000 }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

export async function openAgentDeckAppOrGitHub(): Promise<void> {
  const appOpened = await new Promise<boolean>((resolve) => {
    execFile('open', ['-a', 'AgentDeck'], { timeout: 3000 }, (err) => {
      resolve(!err);
    });
  });
  if (appOpened) return;
  await openOrFocusBrowserTab('https://puritysb.github.io/AgentDeck/');
}

// ---- App launch ----

/**
 * Launch or focus a desktop app by name (`open -a`).
 * Rejects when the app is not installed, so the caller can surface it.
 */
export function openApp(appName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('open', ['-a', appName], { timeout: 5000 }, (err) => {
      if (err) reject(new Error(`Cannot open "${appName}": ${err.message}`));
      else resolve();
    });
  });
}
