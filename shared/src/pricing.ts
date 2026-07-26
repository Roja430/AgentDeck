/**
 * Model pricing table for APME cost tracking.
 *
 * Each `ModelEvent` in a SessionSample is priced at ingestion so cost is a
 * first-class, per-unit signal (not a post-hoc estimate). Local models (MLX,
 * on-device Foundation Models) are $0 — that is the whole point of the
 * local-first judge: guilt-free全数 evaluation.
 *
 * IMPORTANT — these rates are best-effort public list prices and are the ONE
 * place to correct pricing. They are intentionally overridable at runtime so a
 * code change is never required to fix a rate:
 *   - `setPricingOverrides({...})` merges a partial table (e.g. loaded from
 *     ~/.agentdeck/settings.json → apme.pricing) over the defaults.
 *   - Unknown models fall back to `UNKNOWN_PRICE` ($0) and are flagged via
 *     `isPricedModel()` so the dashboard can mark cost as "unpriced" rather
 *     than silently showing $0 as if the call were free.
 *
 * Rates are $/million-tokens (USD). Verified model IDs come from the Anthropic
 * `claude-api` reference; dollar figures should be confirmed against
 * https://anthropic.com/pricing before relying on absolute cost numbers.
 */

export interface ModelPrice {
  /** USD per 1M input tokens. */
  inPerMtok: number;
  /** USD per 1M output tokens. */
  outPerMtok: number;
  /** USD per 1M cache-write tokens. Defaults to `CACHE_WRITE_MULTIPLIER × inPerMtok`. */
  cacheWritePerMtok?: number;
  /** USD per 1M cache-read tokens. Defaults to `CACHE_READ_MULTIPLIER × inPerMtok`. */
  cacheReadPerMtok?: number;
  /** Coarse provider tag for scorecard grouping / "subscription vs marginal". */
  provider?: string;
}

/**
 * Prompt-cache write premium. 1.25× is the 5-minute TTL — the default Claude
 * Code uses. The 1-hour TTL costs 2× instead; override per model if a workload
 * runs on it, otherwise cache-write cost is understated.
 */
export const CACHE_WRITE_MULTIPLIER = 1.25;
/** Prompt-cache read discount — roughly a tenth of the base input rate. */
export const CACHE_READ_MULTIPLIER = 0.1;

export const UNKNOWN_PRICE: ModelPrice = { inPerMtok: 0, outPerMtok: 0, provider: 'unknown' };
const ZERO_LOCAL: ModelPrice = { inPerMtok: 0, outPerMtok: 0, provider: 'local' };

/**
 * Default rates, in USD per million tokens. Anthropic figures are the public
 * list prices; Sonnet 5 carries an introductory $2/$10 through 2026-08-31 that
 * this table does not model (it prices at the standard $3/$15). Confirm before
 * treating absolute USD figures as authoritative — see file header.
 */
const DEFAULT_PRICING: Record<string, ModelPrice> = {
  // ── Anthropic ──
  'claude-fable-5': { inPerMtok: 10, outPerMtok: 50, provider: 'anthropic' },
  'claude-mythos-5': { inPerMtok: 10, outPerMtok: 50, provider: 'anthropic' },
  'claude-opus-5': { inPerMtok: 5, outPerMtok: 25, provider: 'anthropic' },
  'claude-opus-4-8': { inPerMtok: 5, outPerMtok: 25, provider: 'anthropic' },
  'claude-opus-4-7': { inPerMtok: 5, outPerMtok: 25, provider: 'anthropic' },
  'claude-opus-4-6': { inPerMtok: 5, outPerMtok: 25, provider: 'anthropic' },
  'claude-sonnet-5': { inPerMtok: 3, outPerMtok: 15, provider: 'anthropic' },
  'claude-sonnet-4-6': { inPerMtok: 3, outPerMtok: 15, provider: 'anthropic' },
  'claude-sonnet-4-5': { inPerMtok: 3, outPerMtok: 15, provider: 'anthropic' },
  'claude-haiku-4-5': { inPerMtok: 1, outPerMtok: 5, provider: 'anthropic' },
  // ── OpenAI (Codex) — confirm before trusting absolute USD ──
  'gpt-5-codex': { inPerMtok: 1.25, outPerMtok: 10, provider: 'openai' },
  'gpt-5': { inPerMtok: 1.25, outPerMtok: 10, provider: 'openai' },
};

let overrides: Record<string, ModelPrice> = {};

/** Merge a partial pricing table over the defaults (e.g. from user settings). */
export function setPricingOverrides(table: Record<string, ModelPrice> | null | undefined): void {
  overrides = table ? { ...table } : {};
}

/** Normalize a raw model id to its pricing key. Strips provider prefixes and
 *  date suffixes so "anthropic/claude-opus-4-8-20260101" → "claude-opus-4-8". */
export function normalizeModelId(model: string): string {
  let m = model.trim().toLowerCase();
  // provider prefix: "anthropic/claude-…", "openai/gpt-…", "openrouter:…"
  const slash = m.lastIndexOf('/');
  if (slash >= 0 && !m.startsWith('mlx:') && !m.startsWith('local:')) m = m.slice(slash + 1);
  // date suffix: "-20260101" or "-2026-01-01"
  m = m.replace(/-\d{8}$/, '').replace(/-\d{4}-\d{2}-\d{2}$/, '');
  return m;
}

/** Local models (MLX, Foundation Models, Ollama, any explicit local: prefix). */
export function isLocalModel(model: string): boolean {
  const m = model.trim().toLowerCase();
  return m.startsWith('mlx:') || m.startsWith('local:') || m.startsWith('ollama:')
    || m === 'foundationmodels' || m === 'foundation-models' || m === 'apple-fm';
}

/** Look up the price record for a model (override → default → local → unknown). */
export function priceFor(model: string | null | undefined): ModelPrice {
  if (!model) return UNKNOWN_PRICE;
  if (isLocalModel(model)) return ZERO_LOCAL;
  const key = normalizeModelId(model);
  return overrides[key] ?? overrides[model] ?? DEFAULT_PRICING[key] ?? DEFAULT_PRICING[model] ?? UNKNOWN_PRICE;
}

/** True when we have a real (non-$0-fallback) rate or a known-free local model. */
export function isPricedModel(model: string | null | undefined): boolean {
  if (!model) return false;
  if (isLocalModel(model)) return true; // known $0, not "missing"
  const key = normalizeModelId(model);
  return Boolean(overrides[key] ?? overrides[model] ?? DEFAULT_PRICING[key] ?? DEFAULT_PRICING[model]);
}

export function providerFor(model: string | null | undefined): string {
  return priceFor(model).provider ?? 'unknown';
}

/** Compute USD cost for a single model call. Rounds to 6 dp (≈$0.000001). */
export function priceUsd(model: string | null | undefined, inputTokens: number, outputTokens: number): number {
  const p = priceFor(model);
  const usd = (inputTokens / 1_000_000) * p.inPerMtok + (outputTokens / 1_000_000) * p.outPerMtok;
  return Math.round(usd * 1_000_000) / 1_000_000;
}

/** Token counts for one model call, matching the API's `usage` field names. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
}

export function cacheWriteRate(p: ModelPrice): number {
  return p.cacheWritePerMtok ?? p.inPerMtok * CACHE_WRITE_MULTIPLIER;
}

export function cacheReadRate(p: ModelPrice): number {
  return p.cacheReadPerMtok ?? p.inPerMtok * CACHE_READ_MULTIPLIER;
}

/**
 * Cache-aware cost for a single model call.
 *
 * `priceUsd` prices only fresh input and output, which is fine for the APME
 * per-unit signal but wrong for a Claude Code transcript: those turns are
 * dominated by cache reads, and charging them at the full input rate
 * overstates cost by roughly an order of magnitude.
 */
export function priceUsdWithCache(model: string | null | undefined, usage: TokenUsage): number {
  const p = priceFor(model);
  const usd =
    (usage.inputTokens / 1_000_000) * p.inPerMtok +
    (usage.outputTokens / 1_000_000) * p.outPerMtok +
    ((usage.cacheCreationTokens ?? 0) / 1_000_000) * cacheWriteRate(p) +
    ((usage.cacheReadTokens ?? 0) / 1_000_000) * cacheReadRate(p);
  return Math.round(usd * 1_000_000) / 1_000_000;
}
