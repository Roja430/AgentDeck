/**
 * Desktop notification for "an agent needs you".
 *
 * The deck already flashes the session key, but that only helps if you are
 * looking at the deck. This covers the case the deck cannot: the agent hits a
 * permission prompt while you are in another window.
 *
 * Deliberately narrow — it fires on the AWAITING states only. A toast for every
 * turn end would train you to ignore them.
 *
 * No new dependency on any platform:
 *   Windows — PowerShell driving the WinRT toast API
 *   macOS   — `osascript -e 'display notification'`
 *   Linux   — `notify-send` when it exists, otherwise a no-op
 */
import { spawn } from './proc.js';
import { loadNotificationSettings } from '@agentdeck/shared';
import { debug } from './logger.js';

/**
 * Toasts are addressed by (group, tag) so a repeat for the same session
 * *replaces* its predecessor instead of stacking. A session that flips
 * awaiting → answered → awaiting during one task would otherwise leave a
 * column of stale notifications behind.
 */
const TOAST_GROUP = 'agentdeck';

/**
 * PowerShell's own AppUserModelID. Toasts need a registered AUMID to display,
 * and registering one would mean installing a Start Menu shortcut — far more
 * intrusive than borrowing the shell's, which every Windows install already has.
 */
const POWERSHELL_AUMID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

export interface AttentionNotice {
  /** Stable per session — drives toast replacement and the repeat guard. */
  sessionId: string;
  title: string;
  body: string;
}

/** Last notice per session, so one prompt doesn't fire repeatedly. */
const lastNotifiedAt = new Map<string, number>();

/** XML text nodes: a project named `Foo & <Bar>` must not break the document. */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Single-quoted PowerShell literal — only the quote itself needs doubling. */
function psLiteral(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** AppleScript string literal. */
function osaLiteral(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function buildWindowsToastScript(notice: AttentionNotice): string {
  const xml = `<toast><visual><binding template="ToastGeneric">`
    + `<text>${escapeXml(notice.title)}</text>`
    + `<text>${escapeXml(notice.body)}</text>`
    + `</binding></visual></toast>`;

  return [
    `$ErrorActionPreference='Stop'`,
    `[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]`,
    `[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime]`,
    `$d=New-Object Windows.Data.Xml.Dom.XmlDocument`,
    `$d.LoadXml(${psLiteral(xml)})`,
    `$t=New-Object Windows.UI.Notifications.ToastNotification $d`,
    `$t.Tag=${psLiteral(notice.sessionId.slice(0, 64))}`,
    `$t.Group=${psLiteral(TOAST_GROUP)}`,
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(${psLiteral(POWERSHELL_AUMID)}).Show($t)`,
  ].join('; ');
}

/** UTF-16LE base64 — sidesteps every quoting rule between here and PowerShell. */
export function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function notifyWindows(notice: AttentionNotice): void {
  const child = spawn('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-WindowStyle', 'Hidden',
    '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', encodePowerShellCommand(buildWindowsToastScript(notice)),
  ], { stdio: 'ignore', detached: false });
  child.on('error', (err) => debug('Notify', `toast failed: ${err.message}`));
  child.unref?.();
}

function notifyMacos(notice: AttentionNotice): void {
  const script = `display notification ${osaLiteral(notice.body)} with title ${osaLiteral(notice.title)}`;
  const child = spawn('osascript', ['-e', script], { stdio: 'ignore' });
  child.on('error', (err) => debug('Notify', `osascript failed: ${err.message}`));
}

function notifyLinux(notice: AttentionNotice): void {
  const child = spawn('notify-send', [notice.title, notice.body], { stdio: 'ignore' });
  // notify-send is not always installed; absence is not an error worth raising.
  child.on('error', () => debug('Notify', 'notify-send unavailable'));
}

/** Reset the repeat guard (tests, and on daemon restart). */
export function resetNotifyState(): void {
  lastNotifiedAt.clear();
}

/** Platform dispatch. Never throws — a notification is not worth a crash. */
function showNotification(notice: AttentionNotice): boolean {
  try {
    if (process.platform === 'win32') notifyWindows(notice);
    else if (process.platform === 'darwin') notifyMacos(notice);
    else notifyLinux(notice);
    return true;
  } catch (err) {
    debug('Notify', `notify failed: ${err}`);
    return false;
  }
}

/**
 * Raise an attention notice, unless settings disable it or the same session
 * already produced one inside the repeat window. Returns whether it fired, so
 * callers and tests can tell suppression from delivery.
 */
export function notifyAttention(notice: AttentionNotice, now = Date.now()): boolean {
  const settings = loadNotificationSettings();
  if (!settings.attention) return false;

  const previous = lastNotifiedAt.get(notice.sessionId);
  if (previous !== undefined && now - previous < settings.repeatWindowMs) {
    debug('Notify', `suppressed repeat for ${notice.sessionId}`);
    return false;
  }
  lastNotifiedAt.set(notice.sessionId, now);

  const shown = showNotification(notice);
  if (shown) debug('Notify', `notified ${notice.sessionId}: ${notice.title}`);
  return shown;
}

/**
 * Report that something the user just pressed did not work.
 *
 * Not gated by `notifications.attention` and not debounced: this is feedback
 * for a deliberate action, not an interruption. A button that silently does
 * nothing is indistinguishable from a dead daemon.
 */
export function notifyFailure(body: string, tag = 'agentdeck-error'): boolean {
  return showNotification({ sessionId: tag, title: 'AgentDeck', body });
}

/** Clear the guard for a session that is no longer waiting. */
export function clearAttention(sessionId: string): void {
  lastNotifiedAt.delete(sessionId);
}
