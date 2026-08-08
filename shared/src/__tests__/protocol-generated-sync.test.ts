// Guards the protocol SSOT (shared/src/protocol.ts + shared/src/gateway-protocol.ts).
//
// The committed artifacts under generated/protocol/ — plus the TS builders in
// shared/src/command-builders.ts — are emitted by `pnpm generate-protocol`.
// Nothing forces that regeneration, so an edit to the SSOT that skips it drifts
// silently: CI catches it, but only after the push (this is how 9477cbcd broke
// master, from a comment-only edit in eed3b7be that still changes the emitted
// doc comments).
//
// This is the terrarium-rules gate applied to the protocol: regenerate into a
// temp dir, byte-compare, fail in `pnpm test` instead of in CI. Note that a
// doc-comment edit is a real change here — the comments are carried into the
// Swift/Kotlin mirrors, so "it's only a comment" is not a reason to skip the
// generator.
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

/**
 * Can the `bash` on PATH actually run the generator?
 *
 * On Windows, `bash` is frequently `C:\WINDOWS\system32\bash.exe` — WSL. That
 * shell reads the repo fine over /mnt/c, but WSL has no Linux node, so its
 * `npx` falls through PATH interop to the *Windows* node, which is then handed
 * `/mnt/c/...` paths it cannot open ("TSJ - 108: Cannot read config file").
 * The gate could never pass there; all it did was fail every local `pnpm test`.
 *
 * Returns null when the generator can run, or the reason it cannot.
 */
function generatorBlockedBecause(): string | null {
  let probe: string;
  try {
    probe = execFileSync('bash', ['-lc', 'uname -s; command -v node || true'], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
  } catch {
    return 'no `bash` on PATH';
  }
  const [kernel = '', nodePath = ''] = probe.trim().split('\n');
  if (!nodePath.trim()) return `\`bash\` (${kernel.trim()}) has no node on its PATH`;
  // A Linux shell driving a Windows checkout is the WSL case above: the shell
  // and the toolchain disagree about what a path is.
  if (process.platform === 'win32' && kernel.trim() === 'Linux') {
    return '`bash` is WSL — its node sees Windows paths, the shell sees /mnt/c';
  }
  return null;
}

const blocked = generatorBlockedBecause();
if (blocked) {
  // Loud on purpose. A gate that quietly stops running is worse than one that
  // fails: CI (Linux) still enforces this, and the developer should know that
  // their local run is not covering protocol drift.
  //
  // Written straight to stderr rather than through `console.warn`: vitest
  // intercepts console output per test, and this fires at import time in a file
  // whose every test is skipped — which is exactly when the message is dropped.
  process.stderr.write(
    `\n[protocol drift gate] SKIPPED — ${blocked}.\n`
    + '  Protocol drift is not checked locally on this machine; CI still enforces it.\n'
    + '  To check by hand: pnpm generate-protocol && git diff --exit-code generated/protocol\n\n',
  );
}

// Committed path → basename inside the regenerated output directory.
const ARTIFACTS: Array<[string, string]> = [
  ['generated/protocol/bridge-event-schema.json', 'bridge-event-schema.json'],
  ['generated/protocol/plugin-command-schema.json', 'plugin-command-schema.json'],
  ['generated/protocol/gateway-frame-schema.json', 'gateway-frame-schema.json'],
  ['generated/protocol/BridgeEvent.swift', 'BridgeEvent.swift'],
  ['generated/protocol/PluginCommand.swift', 'PluginCommand.swift'],
  ['generated/protocol/GatewayFrame.swift', 'GatewayFrame.swift'],
  ['generated/protocol/BridgeEvent.kt', 'BridgeEvent.kt'],
  ['generated/protocol/PluginCommand.kt', 'PluginCommand.kt'],
  ['generated/protocol/GatewayFrame.kt', 'GatewayFrame.kt'],
  ['generated/protocol/AgentCommand.swift', 'AgentCommand.swift'],
  ['generated/protocol/AgentCommand.kt', 'AgentCommand.kt'],
  // Ungated by the CI step, which only diffs generated/protocol/.
  ['shared/src/command-builders.ts', 'command-builders.ts'],
];

describe.skipIf(blocked !== null)('generated protocol artifacts in sync', () => {
  let freshDir: string;

  beforeAll(() => {
    freshDir = mkdtempSync(join(tmpdir(), 'agentdeck-protocol-'));
    execFileSync('bash', ['scripts/generate-protocol.sh'], {
      cwd: repoRoot,
      env: { ...process.env, AGENTDECK_PROTOCOL_OUT_DIR: freshDir },
      stdio: 'pipe',
    });
    // The override is passed through the environment, and an environment does
    // not always survive the jump into the shell (WSL forwards only what WSLENV
    // names). If it were dropped the script would fall back to OUT_DIR's
    // default — the repository — and this "check" would have quietly rewritten
    // the very artifacts it is meant to compare against. Catch that here rather
    // than reporting a suspiciously clean run.
    if (!existsSync(join(freshDir, 'bridge-event-schema.json'))) {
      throw new Error(
        'generate-protocol.sh did not write to AGENTDECK_PROTOCOL_OUT_DIR — the '
        + 'override did not reach the shell, so it may have written into '
        + 'generated/protocol instead. Check `git status` before trusting this run.',
      );
    }
    return () => rmSync(freshDir, { recursive: true, force: true });
    // The generator shells out to quicktype/ts-json-schema-generator via npx.
    // Both are devDependencies pinned in the lockfile, so this resolves the
    // local binaries and needs no network.
  }, 180_000);

  for (const [committed, basename] of ARTIFACTS) {
    it(`${committed} matches the SSOT`, () => {
      const onDisk = readFileSync(join(repoRoot, committed), 'utf8');
      const fresh = readFileSync(join(freshDir, basename), 'utf8');
      expect(
        onDisk,
        `${committed} is stale — run 'pnpm generate-protocol' and commit the result.`
      ).toBe(fresh);
    });
  }
});
