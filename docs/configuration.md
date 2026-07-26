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

