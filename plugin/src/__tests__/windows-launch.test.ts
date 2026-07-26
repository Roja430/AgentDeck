/**
 * Windows launch helpers — the app-name → URI-scheme rule.
 *
 * `app:` targets reach Store-packaged apps through their registered scheme
 * rather than an executable path, so a name that is not a legal scheme has to
 * be rejected rather than guessed at: guessing would make the fallback chain
 * stop on a step that can never work, and the `url:` step would never run.
 */
import { describe, it, expect } from 'vitest';
import { schemeForAppName } from '../utility-modes/windows.js';

describe('windows: app name → URI scheme', () => {
  it('lowercases the shipped agent names', () => {
    expect(schemeForAppName('Claude')).toBe('claude');
    expect(schemeForAppName('Codex')).toBe('codex');
  });

  it('tolerates surrounding whitespace', () => {
    expect(schemeForAppName('  Claude  ')).toBe('claude');
  });

  it('accepts the punctuation a scheme is allowed to contain', () => {
    expect(schemeForAppName('ms-settings')).toBe('ms-settings');
    expect(schemeForAppName('com.example.app')).toBe('com.example.app');
  });

  it('rejects names that cannot be a scheme, so the chain falls through', () => {
    // A space or a leading digit makes `<name>://` malformed; returning null
    // lets runTarget move on to the url: step instead of failing the whole chain.
    expect(schemeForAppName('Visual Studio Code')).toBeNull();
    expect(schemeForAppName('1Password')).toBeNull();
    expect(schemeForAppName('')).toBeNull();
  });
});
