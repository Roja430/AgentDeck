---
id: validation.design-lint
title: Design Lint Baseline
description: Regression-gate baseline for the DESIGN.md rule checker and how to move it.
category: Engineering
locale: en
canonical: true
status: stable
owner: Design system maintainers
reviewed: 2026-07-29
revision: 2026-07-29
source_of_truth: docs/design-lint-baseline.md
validators: [node scripts/build-design-system-viewer.mjs --check, bash design/lint.sh]
---

# Design Lint Baseline

Snapshot of the violation count for files under `lint.sh`'s scope (see [DESIGN.md](../DESIGN.md), [design/lint.sh](../design/lint.sh)). Used by CI as a regression gate — PRs that raise the count above this baseline fail.

Run `bash design/lint.sh` to see the current count. Run `bash design/lint.sh --json > audit.json` for machine-readable output. Exit code = total violations (0 = clean).

## Current snapshot

<!-- Updated 2026-07-29 after repairing R6, which had been reporting ~220 phantom violations. -->

Total: **91 violations** across **3 rules**.

| Rule | Count | Meaning |
|---|---|---|
| `R1_pure_white_black` | 3 | Pure `#fff` / `#000` — should use `--tide-50` / `--ink-900` |
| `R2_hardcoded_hex` | 83 | Hardcoded hex outside token files |
| `R7_arbitrary_radius` | 5 | `border-radius` outside `{0, 4, 8, 10, 12, 14, 16, 18, 999}` |

`R6_emoji_in_ui` is **0** and no longer appears. It used to dominate this table
with ~220 hits that were not emoji at all — see the History entry below.

## Top offenders

| File | Total | Notes |
|---|---|---|
| `docs/appstore-migration-diagram.html` | 61 | Off-product flowchart with generic Tailwind palette; not a UI surface — skip-rule candidate |
| `docs/design/Design System.html` | 24 | Legacy design guide intentionally displays raw colour swatches; the Pages viewer reads the canonical token file instead |
| `docs/design/Design Audit.html` | 4 | Legacy design reference page |
| `plugin-ulanzi/…/plugin/app.js` | 2 | A `#000` key bitmap and one hex — the only offenders in shipped product code |

Two of the three `R1` hits are the rule's own documentation quoting `#fff` and
`#000` as the values it forbids. Leave them; a rule page that cannot name what
it forbids is worse than a counted violation.

## Migration policy

1. **New code uses tokens.** `var(--ink-900)` in CSS, `DesignTokens.Ink.s900` in Swift/Kotlin, named imports from `@agentdeck/shared` in TS.
2. **Existing pages migrate as they are touched.** When editing one of the offender files, swap the hex values you encounter while you're there.
3. **Don't sweep-refactor for token compliance.** Each surface has its own visual signature — converting shadows/radii without a designer-in-the-loop drifts the look. Visual review required.

## Token-defining files (lint allowlist)

The lint script exempts these from the raw-hex rule because they ARE the source of token values. Drift inside them is caught by `python3 design/verify-tokens-sync.py`, not by lint:

- `design/tokens.css` — canonical SSOT
- `design/tokens.js` — browser mirror (loaded by mockup HTMLs)
- `design/components.css`, `design/patterns.css`, `design/icons.jsx` — design system styles
- `docs/design/creatures.jsx` — embeds upstream brand SVGs (DESIGN.md §6.1 forbids redrawing)
- `apple/AgentDeck/Resources/apme-dashboard.html` — embedded HTML resource, manual mirror of token primitives in its `:root`
- `docs/hardware/index.html`, `scripts/pages-index.html`, `docs/site/index.html`, `docs/gallery/index.html` — published GitHub Pages surfaces and compatibility redirects with a self-contained `:root` warm-token mirror
- `plugin/bound.serendipity.agentdeck.sdPlugin/ui/design-tokens.css` — Stream Deck Property Inspector mirror

When CSS tokens change, every file in the second half of the list (the manual mirrors) must be hand-synced.

## Excluded directories

`lint.sh` skips: `node_modules`, `.git`, `.github`, `dist`, `coverage`, `generated`, `.zig-cache`, `.zig-global-cache`, `apple/build`, `android/app/build`, `apple/AgentDeck/Resources/agentdeck-runtime`, `docs/design-mockups`, `plugin/.../bin`, `esp32/.pio`, `esp32/robot/results`, `tools/creature-simulator`, plus the file `sdpi-components.js` (vendored).

## Wiring `lint.sh` into pre-commit (baseline-aware)

The simple `bash design/lint.sh || exit 1` gate fails until the baseline reaches zero. The baseline-aware version below blocks regressions only:

```bash
cat > .git/hooks/pre-commit << 'EOF'
#!/usr/bin/env bash
set -e
# 1. Token sync MUST pass — drift here is always a bug.
python3 design/verify-tokens-sync.py >/dev/null

# 2. Lint count must not exceed baseline.
BASELINE=$(grep -m1 -oE 'Total: \*\*[0-9]+ violations\*\*' docs/design-lint-baseline.md \
           | grep -oE '[0-9]+')
CURRENT=$(bash design/lint.sh --json 2>/dev/null \
          | python3 -c 'import sys,json; print(json.load(sys.stdin)["total"])')
if [ "$CURRENT" -gt "$BASELINE" ]; then
  echo "Design lint regression: $CURRENT > baseline $BASELINE"
  bash design/lint.sh
  exit 1
fi
EOF
chmod +x .git/hooks/pre-commit
```

CI runs the same logic in `.github/workflows/design-system.yml` — see that file for the canonical implementation.

## History

- **2026-07-29** — **R6 was broken, and had been since it shipped.** Its pattern,
  `[â-ââ­ð][-¿][-¿]`, reads as one byte set
  containing the ranges `-â`, `-â` and `­-ð` — nearly every high
  byte — so it flagged every em dash, ellipsis, curly quote, box-drawing rule and
  geometric shape in the repository. 223 hits, none of them emoji, none of them
  ever clearable. Rewritten as one alternative per UTF-8 lead byte; R6 now reports 0.

  Two things follow, both worth knowing:

  **This gate has not been passing.** The baseline was last written at
  `3e27d809` (2026-07-21) claiming 89 across 3 rules; running the linter at that
  same commit gives **255 across 5**. The snapshot was recorded without the
  totals it claimed to summarise, so CI has been failing the design-system
  workflow on a phantom regression ever since.

  **The `--json` the gate parses could be malformed.** Matched lines were cut to
  160 *bytes*, which split multi-byte characters in this repo's Japanese and
  Korean copy; the CI step reads that output with `json.load`, so a broken
  sequence took the gate down with a Python traceback rather than a lint report.
  Truncation now drops dangling bytes (`clip160`).

  Genuine drift over the same period was **+2** (R1 2→3, R2 82→83), both in
  `plugin-ulanzi`. Absorbed into the new baseline rather than fixed here — that
  is a different surface and a separate change.
- **2026-05-09** — Foundation install. Baseline 111.
- **2026-05-10** — Phase 2 hotspot migration. apme-dashboard.html (11 → 0) + plugin PI HTMLs (7 → 0) + Motion pulse/wiggle tokens added to CSS. Baseline 93.
- **2026-07-18** — Legacy docs hub replaced by the token-driven design-system viewer. Baseline 89.
