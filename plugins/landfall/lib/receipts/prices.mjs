// Price table (spec §7.11, SD-23, ruling R70): prices.json holds USD per million tokens per model and token category,
// with the date they were read; a cost computed from it is an estimate. USD per million tokens equals micro-dollars
// per token, so a request costs Σ tokens × price micro-dollars, rounded once to a whole micro-dollar (R70: money is
// an integer number of micro-dollars). Categories: input, cacheWrite5m, cacheWrite1h, cacheRead, output (absolute
// prices; pricing page footnotes: cache reads cost 0.025x base input on Fable 5.1 and Mythos 5.1, 0.05x on Opus 5.5
// and Sonnet 5.5, 0.1x on every other model). `longPrompt` prices a whole request whose prompt (input + cache reads
// + cache writes) is over `overTokens`.
// Not modelled (known limits): fast mode, the US-only inference multiplier, batch discounts, server-tool fees.
import { readFileSync } from 'node:fs';

export const PRICES = Object.freeze(JSON.parse(readFileSync(new URL('./prices.json', import.meta.url), 'utf8')));
export const CATEGORIES = Object.freeze(['input', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead', 'output']);

// Prices of `model` (an API model ID, a dated one too: claude-haiku-4-5-20251001), or null.
export function priceOf(model, table = PRICES) {
  if (typeof model !== 'string') return null;
  for (const id of [model, model.replace(/-\d{8}$/, '')]) if (Object.hasOwn(table.models, id)) return table.models[id];
  return null;
}

// Whole micro-dollars of one request ({ input, output, cacheRead, cacheWrite5m, cacheWrite1h } tokens); null for an
// unpriced model.
export function requestMicroUsd(model, tokens, table = PRICES) {
  const p = priceOf(model, table);
  if (!p) return null;
  const prompt = tokens.input + tokens.cacheRead + tokens.cacheWrite5m + tokens.cacheWrite1h;
  const rate = p.longPrompt && prompt > p.longPrompt.overTokens ? p.longPrompt : p;
  return Math.round(CATEGORIES.reduce((sum, c) => sum + tokens[c] * rate[c], 0));
}
