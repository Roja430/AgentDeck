import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { hasOAuthToken } from '../usage-api.js';

/**
 * Windows and Linux have no Keychain — the `~/.claude/.credentials.json` file
 * is the only OAuth store there, so the usage gauges depend on this path.
 */
describe('OAuth credentials file', () => {
  let configDir: string;
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'agentdeck-creds-'));
    process.env.CLAUDE_CONFIG_DIR = configDir;
  });

  afterEach(() => {
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
    rmSync(configDir, { recursive: true, force: true });
  });

  function writeCredentials(payload: unknown): void {
    writeFileSync(join(configDir, '.credentials.json'), JSON.stringify(payload), 'utf-8');
  }

  it('reads a token from the credentials file', () => {
    writeCredentials({ claudeAiOauth: { accessToken: 'sk-test', expiresAt: Date.now() + 3600_000 } });
    expect(hasOAuthToken()).toBe(true);
  });

  it('reports no token when the file is absent', () => {
    expect(hasOAuthToken()).toBe(false);
  });

  it('reports no token when the payload has no accessToken', () => {
    writeCredentials({ claudeAiOauth: { refreshToken: 'r' } });
    expect(hasOAuthToken()).toBe(false);
  });

  it('reports no token when the file is not valid JSON', () => {
    writeFileSync(join(configDir, '.credentials.json'), '{ not json', 'utf-8');
    expect(hasOAuthToken()).toBe(false);
  });
});
