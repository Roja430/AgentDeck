# Configuration

What you can change, and where the file lives.

## Settings

Defaults ship in `config/default-settings.json` and are copied into your user
data directory on first run (`~/.agentdeck/settings.json`; the App Store macOS
app uses its container path — see CLAUDE.md → User data dir).

| Key | Default | Effect |
|-----|---------|--------|
| `bridgePort` | `9120` | Daemon hub port. Session bridges take 9121-9139. |
| `autoRestart` | `false` | Restart a session bridge when its agent exits. |
| `stuckTimeoutMs` | `300000` | How long PROCESSING may last before the session reads as stalled. |
| `reconnectIntervalMs` | `3000` | Client reconnect backoff. |
| `voiceLanguage` · `voiceAutoSend` · `whisperModel` | `ko` · `true` · `large-v3-turbo` | Dictation on the Apple app. See [Voice setup](voice-setup.md). |
| `llm.mlx.endpoint` · `llm.mlx.model` | `http://127.0.0.1:8800` · `null` | Local MLX server used by APME's judge. |
| `cost.dailyBudgetUsd` | unset | Daily spend tripwire for the COST view. Unset means no budget — see below. |
| `cost.warnAtPercent` | `80` | Share of the budget at which the COST view turns amber. |
| `notifications.attention` | `true` | Desktop notification when a session starts waiting on you. |
| `notifications.repeatWindowMs` | `60000` | Minimum gap between notices for the same session. |
| `apme.*` | enabled, auto-tuning | Evaluation module — schema and semantics in [APME](apme.md). |

### Daily cost budget

The figure the budget is compared against is an **estimate**: the bridge prices
the token counts in your local Claude Code transcripts at public list prices
(`bridge/src/transcript-cost.ts`), including the prompt-cache read and write
rates. It is not a billing feed, and nothing is blocked when the budget trips —
the COST view on the Claude usage encoder turns amber at `warnAtPercent` and red
with an `OVER BUDGET` header past the budget.

There is deliberately **no default budget**. A threshold nobody chose would
paint the encoder red on an ordinary working day. A zero or negative
`dailyBudgetUsd`, or a `warnAtPercent` outside 1–100, is treated as unset.

```json
{ "cost": { "dailyBudgetUsd": 20, "warnAtPercent": 75 } }
```

### Attention notifications

The deck flashes the session key when an agent needs you, which only helps if
you are looking at the deck. `notifications.attention` adds a desktop
notification for the case the deck cannot cover — the agent hits a permission
prompt while you are in another window.

It fires **only on the AWAITING states** (permission, option, diff), never on an
ordinary turn end: a notification per turn would train you to ignore them. A
session notifies at most once per `repeatWindowMs`, and is re-armed as soon as
it stops waiting.

No extra dependency on any platform — Windows uses the WinRT toast API through
PowerShell, macOS `osascript`, Linux `notify-send` when present. On Windows the
toast is tagged with the session id and grouped under `agentdeck`, so a session
that re-prompts *replaces* its own notification instead of stacking a column of
them in Action Center.

```json
{ "notifications": { "attention": false } }
```

## Stream Deck Property Inspector

Only the **Launcher encoder (E4)** carries per-instance settings:
`claudeTarget`, `codexTarget`, `openclawTarget` — the working directory each
agent opens in.

The keypad has no per-button configuration. Every key is a `session-slot` whose
content is derived from live session state, and the detail-view quick actions
(GO ON / REVIEW / COMMIT / CLEAR) are defined by the shared layout engine in
`shared/src/d200h-layout.ts`, not by user settings. The earlier configurable
slots 3-6 belonged to the retired mode-dial keypad — see
[Retired and Experimental Surfaces](retired-surfaces.md).

## Prompt templates

`config/prompt-templates.json` holds labelled prompts:

```json
{
  "templates": [
    { "label": "Fix Bug", "prompt": "Please fix the bug described above" },
    { "label": "Test", "prompt": "Write tests for the changes made" }
  ]
}
```

The bridge resolves `send_prompt` commands of the form `__template:<index>`
against this file. **Nothing in the shipped UI emits that command today** — the
encoder that cycled templates was retired with the multi-mode dials, so editing
this file currently has no visible effect. It is documented because the file and
the bridge handler both still exist.
