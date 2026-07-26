/**
 * The two things a launch target can do, dispatched per platform.
 *
 * Kept as its own module so the launcher has one seam to mock instead of
 * reaching into a platform-specific file directly — which is what tied the
 * launcher to macOS in the first place.
 */
import { openApp as macOpenApp, openOrFocusBrowserTab } from './macos.js';
import { openApp as winOpenApp, openUrl as winOpenUrl } from './windows.js';

const IS_WINDOWS = process.platform === 'win32';

/** Launch or focus a desktop app by name. Rejects when it is not installed. */
export function openDesktopApp(name: string): Promise<void> {
  return IS_WINDOWS ? winOpenApp(name) : macOpenApp(name);
}

/**
 * Open a URL. macOS focuses an existing tab that already matches the prefix;
 * Windows hands it to the default browser, which does its own tab reuse.
 */
export function openWebUrl(url: string): Promise<void> {
  return IS_WINDOWS ? winOpenUrl(url) : openOrFocusBrowserTab(url);
}
