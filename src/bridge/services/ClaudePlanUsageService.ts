/**
 * Claude plan-usage snapshot builder + resolver.
 * TypeScript port of the JetBrains plugin's ClaudePlanUsageService plus the
 * pluggable relay vendor stack (provider/claude/usage/*, upstream 53a6cfee +
 * c1348a10 + 89065163 + 2117f71d, with the 7b75df6d/eb249af5 cache fixes).
 *
 * Feeds the ContextBar plan-usage indicator with a capacity payload
 * ({@code capacity_pct} + {@code windows[]}). Two data sources, picked by backend:
 *
 * - Relay vendors (Kimi For Coding / MiniMax Coding Plan / z.ai+bigmodel.cn):
 *   {@link matchRelayVendor} matches the {@code ANTHROPIC_BASE_URL} host (and
 *   path, for api.kimi.com/coding) against {@link RELAY_USAGE_VENDORS} and the
 *   matched vendor's usage API is probed — responses are translated into the
 *   shared capacity shape.
 * - Real Anthropic (OAuth subscription): the SDK emits
 *   {@code rate_limit_event} ({@code rate_limit_info: {status, resetsAt, utilization}})
 *   during turns; {@code bridge.ts} caches it via {@link cacheRateLimitInfo}.
 *
 * The webview polls {@code get_claude_plan_usage} (~every 120s).
 */

import * as fs from 'fs';
import * as crypto from 'crypto';
import * as http from 'http';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import { URL } from 'url';

type Json = Record<string, any>;

/** Test seam replacing the real HTTP probe. */
export type RelayTransport = (url: string, token: string) => Promise<unknown>;

/** Reads the effective Claude settings (defaults to ~/.claude/settings.json). */
export type ClaudeSettingsReader = () => Json | null;

const HTTP_TIMEOUT_MS = 15_000;

function deepCopy(payload: Json): Json {
  return JSON.parse(JSON.stringify(payload));
}

function asDouble(o: Json, ...keys: string[]): number | null {
  for (const k of keys) {
    const v = o?.[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '') {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function asLong(o: Json, ...keys: string[]): number | null {
  const n = asDouble(o, ...keys);
  return n === null ? null : Math.trunc(n);
}

/**
 * Values below this threshold are treated as epoch SECONDS, not millis:
 * 1e11 ms is March 1973 while 1e11 s is the year 5138, so any realistic reset
 * time sits cleanly on one side of it. Vendor APIs differ on the unit (and
 * some are undocumented), so sniff the unit here (upstream 7b75df6d
 * RelayUsageJson.asEpochMs) instead of assuming seconds per field.
 */
const EPOCH_SECONDS_CEILING = 100_000_000_000;

/** Epoch timestamp among {@code keys}, normalized to milliseconds, or null. */
function asEpochMs(o: Json, ...keys: string[]): number | null {
  const v = asLong(o, ...keys);
  if (v === null || v < 0) return null;
  return v < EPOCH_SECONDS_CEILING ? v * 1000 : v;
}

function asInt(o: Json, key: string): number | null {
  return asLong(o, key);
}

function asString(o: Json, key: string): string | null {
  const v = o?.[key];
  return typeof v === 'string' ? v : null;
}

function envString(settings: Json | null, key: string): string | null {
  const env = settings?.env;
  if (!env || typeof env !== 'object') return null;
  const v = env[key];
  return typeof v === 'string' ? v : null;
}

export function clampPct(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, v));
}

export function unavailable(message: string): Json {
  return {
    present: false,
    unavailable: true,
    provider: 'claude',
    message,
  };
}

/** Default reader: ~/.claude/settings.json (provider env is synced there). */
export function readClaudeSettingsFile(): Json | null {
  try {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    if (!fs.existsSync(settingsPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

// ============================================================================
// Relay vendor env + transport policy
// ============================================================================

/**
 * Credentials and routing inputs a relay usage vendor needs, extracted from the
 * Claude settings.json env block once per resolve so every vendor sees a
 * consistent snapshot (upstream RelayUsageEnv).
 */
export interface RelayUsageEnv {
  /** ANTHROPIC_BASE_URL — the anthropic-compat endpoint whose host/path identifies the vendor. */
  baseUrl: string | null;
  /** Bearer token: ANTHROPIC_AUTH_TOKEN, falling back to ANTHROPIC_API_KEY (the SDK's own chain). */
  token: string | null;
  /** Active model id (ANTHROPIC_MODEL or the per-tier defaults) for per-model quota APIs (MiniMax). */
  model: string | null;
}

function relayEnvFromSettings(settings: Json | null): RelayUsageEnv {
  const baseUrl = envString(settings, 'ANTHROPIC_BASE_URL');
  const token = envString(settings, 'ANTHROPIC_AUTH_TOKEN') ?? envString(settings, 'ANTHROPIC_API_KEY');
  let model: string | null = null;
  for (const key of [
    'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_FABLE_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  ]) {
    model = envString(settings, key);
    if (model) break;
  }
  return { baseUrl, token, model };
}

/**
 * Origin ({@code scheme://host[:port]}) of an anthropic base URL when it is safe
 * to send credentials there — TLS, or plain HTTP for loopback targets only; any
 * custom port is kept. Null when the URL is malformed or unsafe, so a Bearer
 * token never travels over plaintext to a remote host (upstream
 * RelayUsageHttp.secureOrigin).
 */
export function secureOrigin(baseUrl: string): string | null {
  try {
    const u = new URL(baseUrl);
    const scheme = u.protocol.replace(/:$/, '');
    const host = u.hostname;
    if (!scheme || !host) return null;
    // WHATWG URL keeps brackets around IPv6 literals in hostname (upstream 7b75df6d
    // RelayUsageHttp: correct IPv6 loopback origins).
    const loopback = host.toLowerCase() === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
    if (scheme.toLowerCase() !== 'https' && !(scheme.toLowerCase() === 'http' && loopback)) {
      return null;
    }
    return u.port ? `${scheme}://${host}:${u.port}` : `${scheme}://${host}`;
  } catch {
    return null;
  }
}

/**
 * Canonical form of a base URL for cache keys: WHATWG URL parsing already
 * lowercases scheme/host, keeps IPv6 brackets and drops default ports (80/443)
 * from {@code port} — matching upstream RelayUsageRegistry.canonicalBaseUrl.
 * Malformed URLs degrade to the trimmed input.
 */
function canonicalBaseUrl(baseUrl: string): string {
  try {
    const u = new URL(baseUrl.trim());
    if (!u.hostname) return baseUrl.trim();
    return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}`;
  } catch {
    return baseUrl.trim();
  }
}

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

// ============================================================================
// Capacity payload construction (upstream RelayUsageJson)
// ============================================================================

/** One {@code windows[]} entry. {@code id} doubles as {@code period_type}; reset is optional. */
function windowEntry(id: string, usedPct: number, resetAtMs: number | null): Json {
  const w: Json = { id, used_pct: usedPct, period_type: id };
  if (resetAtMs !== null) w.reset_at = new Date(resetAtMs).toISOString();
  return w;
}

/**
 * Assemble the shared capacity payload from ordered windows. The binding
 * {@code capacity_pct} prefers the 5h window (the shortest actionable budget)
 * and otherwise falls back to the worst window. {@code windows} must be
 * non-empty; {@code level} (plan tier) is optional and vendor-specific.
 */
function capacityPayload(source: string, windows: Json[], level: string | null): Json | null {
  if (windows.length === 0) return null;
  let primary5h: number | null = null;
  let maxPct = 0;
  for (const w of windows) {
    if (w.id === '5h') primary5h = w.used_pct;
    if (w.used_pct > maxPct) maxPct = w.used_pct;
  }

  const out: Json = {
    ok: true,
    present: true,
    provider: 'claude',
    source,
    capacity_pct: primary5h !== null ? primary5h : maxPct,
    period_type: windows[0].id,
    windows,
  };
  if (level) out.level = level;
  return out;
}

// ============================================================================
// Relay vendors
// ============================================================================

/**
 * One relay vendor that can report Claude plan usage for its own backend
 * (upstream RelayUsageVendor). Implementations are stateless; caching, HTTP and
 * error policy live in {@link ClaudePlanUsageService}. {@link matches} receives
 * the lowercased base-URL host and path; {@link parse} translates the usage API
 * response into the capacity shape (null when the response carries no usable
 * data, e.g. an expired plan).
 */
export interface RelayUsageVendor {
  /** Stable vendor id ("zai", "minimax", "kimi-coding"); namespaces the probe cache. */
  readonly id: string;
  /** Path appended to the secure origin when probing. */
  readonly usagePath: string;
  matches(host: string | null, path: string): boolean;
  parse(body: unknown, env: RelayUsageEnv): Json | null;
}

// ===== Kimi For Coding (api.kimi.com/coding) =====

/**
 * Classify a limits[] entry by its window duration. Observed shapes: 300 minutes
 * (or 18000 seconds) → 5h; 604800 seconds or 7 days → 7d. When {@code timeUnit}
 * is present it is authoritative — a 300-SECOND window is five minutes, not 5h,
 * and must be ignored rather than misclassified (upstream 2117f71d). Unit absent
 * falls back to the numeric heuristic over the observed values; anything
 * unrecognized is ignored rather than guessed.
 */
function kimiCodingWindowPeriod(item: Json): string | null {
  const win = item.window;
  if (!win || typeof win !== 'object') return null;
  const duration = asDouble(win as Json, 'duration');
  if (duration === null) return null;
  const d = Math.trunc(duration);
  const unit = asString(win as Json, 'timeUnit');
  if (unit) {
    const u = unit.toUpperCase();
    if (u.includes('MINUTE')) return d === 300 ? '5h' : null;
    if (u.includes('SECOND')) {
      if (d === 18000) return '5h';
      return d === 604800 ? '7d' : null;
    }
    if (u.includes('HOUR')) {
      if (d === 5) return '5h';
      return d === 168 ? '7d' : null;
    }
    if (u.includes('DAY')) return d === 7 ? '7d' : null;
    return null;
  }
  if (d === 300 || d === 18000) return '5h';
  return d === 604800 ? '7d' : null;
}

/**
 * Merge one limit/remaining (or limit/used) pair into {@code byPeriod}, keeping
 * the worse usage when both sources report the same window (e.g. a weekly
 * limits[] entry plus the top-level usage object).
 */
function kimiCodingMergeWindow(byPeriod: Map<string, Json>, period: string, detail: unknown): void {
  if (!detail || typeof detail !== 'object') return;
  const d = detail as Json;
  const limit = asDouble(d, 'limit');
  if (limit === null || limit <= 0) return;
  const used = asDouble(d, 'used');
  let pct: number;
  if (used !== null) {
    pct = (used / limit) * 100;
  } else {
    const remaining = asDouble(d, 'remaining');
    if (remaining === null) return;
    pct = (Math.max(0, limit - remaining) / limit) * 100;
  }
  pct = clampPct(pct);
  const resetAtMs = asEpochMs(d, 'resetTime', 'reset_time');

  const existing = byPeriod.get(period);
  if (existing) {
    if (pct > existing.used_pct) existing.used_pct = pct;
    if (!existing.reset_at && resetAtMs !== null) existing.reset_at = new Date(resetAtMs).toISOString();
    return;
  }
  byPeriod.set(period, windowEntry(period, pct, resetAtMs));
}

/**
 * Parse the Kimi For Coding {@code /coding/v1/usages} body into the capacity
 * shape: each {@code limits[]} entry is a rolling window (identified by
 * {@code window.duration}) and the top-level {@code usage} object is the weekly
 * quota. Percentages are derived as {@code (limit − remaining) / limit} (or
 * {@code used / limit} when the API reports {@code used} directly).
 */
export function parseKimiCodingUsages(body: unknown): Json | null {
  if (!body || typeof body !== 'object') return null;
  const byPeriod = new Map<string, Json>();
  const limits = (body as Json).limits;
  if (Array.isArray(limits)) {
    for (const el of limits) {
      if (!el || typeof el !== 'object') continue;
      const item = el as Json;
      const period = kimiCodingWindowPeriod(item);
      if (period) kimiCodingMergeWindow(byPeriod, period, item.detail);
    }
  }
  kimiCodingMergeWindow(byPeriod, '7d', (body as Json).usage);
  return capacityPayload('kimi-coding-usages', Array.from(byPeriod.values()), null);
}

// ===== MiniMax Coding Plan (minimaxi.com / minimax.io) =====

/** Lowercase + strip non-alphanumerics, for tolerant cross-format model matching. */
function normalizeModelKey(s: unknown): string {
  return typeof s === 'string' ? s.toLowerCase().replace(/[^a-z0-9]/g, '') : '';
}

/**
 * Pick the model_remains entry for the user's active model. Matching runs in
 * two passes — exact normalized-name equality first, then bidirectional
 * substring — so an earlier substring hit never shadows a later exact entry
 * ("MiniMax-M2" must not resolve to a "MiniMax-M2.5" entry that precedes the
 * exact one, upstream 2117f71d). Substring matching tolerates "MiniMax-M3" vs
 * "M3", "minimax_m3", Unicode-dash variants etc. Fallback chain: "general"
 * (the Coding Plan default) → first entry.
 */
function pickMinimaxModel(remains: unknown[], currentModel: string | null): Json | null {
  const objects = remains.filter((el): el is Json => !!el && typeof el === 'object' && !Array.isArray(el));
  const cur = normalizeModelKey(currentModel);
  if (cur) {
    for (const entry of objects) {
      const name = normalizeModelKey(entry.model_name);
      if (name && name === cur) return entry;
    }
    for (const entry of objects) {
      const name = normalizeModelKey(entry.model_name);
      if (name && (name.includes(cur) || cur.includes(name))) return entry;
    }
  }
  for (const entry of objects) {
    if (entry.model_name === 'general') return entry;
  }
  return objects[0] ?? null;
}

/** Remaining percent (0-100) → clamped used percent; null when the field is absent. */
function invertRemainingPct(remainingPct: number | null): number | null {
  return remainingPct === null ? null : clampPct(100 - remainingPct);
}

/**
 * Parse the coding-plan-remains body for {@code currentModel} into the capacity
 * shape. The API reports REMAINING percentages per model per window — inverted
 * here into used percentages. The weekly window is only reported when
 * {@code current_weekly_status == 1} (weekly quota enabled for the plan).
 */
export function parseMinimaxRemains(body: unknown, currentModel: string | null): Json | null {
  if (!body || typeof body !== 'object') return null;
  // base_resp carries a non-zero status_code on API errors — treat as "no
  // data" so the caller can fall back rather than show garbage.
  const baseResp = (body as Json).base_resp;
  const statusCode = baseResp && typeof baseResp === 'object' ? asInt(baseResp as Json, 'status_code') : null;
  if (statusCode !== null && statusCode !== 0) return null;
  const remains = (body as Json).model_remains;
  if (!Array.isArray(remains) || remains.length === 0) return null;
  const main = pickMinimaxModel(remains, currentModel);
  if (!main) return null;

  const windows: Json[] = [];
  const pushWindow = (id: string, usedPct: number | null, resetAtMs: number | null) => {
    if (usedPct !== null) windows.push(windowEntry(id, usedPct, resetAtMs));
  };
  pushWindow('5h', invertRemainingPct(asDouble(main, 'current_interval_remaining_percent')), asEpochMs(main, 'end_time'));
  if (asInt(main, 'current_weekly_status') === 1) {
    pushWindow('7d', invertRemainingPct(asDouble(main, 'current_weekly_remaining_percent')), asEpochMs(main, 'weekly_end_time'));
  }
  pushWindow('monthly', invertRemainingPct(asDouble(main, 'current_monthly_remaining_percent')), asEpochMs(main, 'monthly_end_time'));
  return capacityPayload('minimax-coding-plan', windows, null);
}

// ===== z.ai / bigmodel.cn (智谱 GLM Coding Plan) =====

/** A z.ai backend is identified by its anthropic-compat base URL host being z.ai/bigmodel.cn or a subdomain. */
export function isZaiBackend(settings: Json | null): boolean {
  const base = envString(settings, 'ANTHROPIC_BASE_URL');
  if (!base) return false;
  try {
    const host = new URL(base).hostname?.toLowerCase();
    if (!host) return false;
    // z.ai and bigmodel.cn expose the same anthropic-compat usage API
    // (upstream 7b75df6d ZaiUsageVendor host matching, case-insensitive).
    return host === 'z.ai' || host.endsWith('.z.ai')
      || host === 'open.bigmodel.cn' || host.endsWith('.bigmodel.cn');
  } catch {
    return false;
  }
}

/**
 * Derive {@code <origin>/api/monitor/usage/quota/limit} from the anthropic base URL
 * (port kept). The Bearer token rides along, so plain HTTP is only allowed for
 * loopback targets (local proxies); anything else must be TLS.
 */
export function monitorUrl(baseUrl: string): string | null {
  const origin = secureOrigin(baseUrl);
  return origin ? `${origin}${ZAI_USAGE_PATH}` : null;
}

const ZAI_USAGE_PATH = '/api/monitor/usage/quota/limit';

/**
 * Map a z.ai limit to a window id/period. Observed payloads use unit 3=hours
 * (number=5 → 5h), unit 6=weeks (number=1 → 7d) and unit 4=weeks expressed as
 * seven days (number=7 → 7d). Unknown or inconsistent shapes return null so the
 * caller skips the window instead of showing a guessed period.
 */
function zaiPeriod(lim: Json, type: string | null): string | null {
  if (type && type.toUpperCase().includes('TIME')) return 'monthly';
  // Unknown or inconsistent unit/number shapes are ignored rather than guessed
  // (upstream 7b75df6d ZaiUsageVendor.period).
  const unit = asInt(lim, 'unit');
  const number = asInt(lim, 'number');
  if (unit === null || number === null) return null;
  switch (unit) {
    case 3: return number === 5 ? '5h' : null;
    case 6: return number === 1 ? '7d' : null;
    case 4: return number === 7 ? '7d' : null;
    default: return null;
  }
}

/**
 * Parse the z.ai {@code /api/monitor/usage/quota/limit} body into the capacity shape.
 * Coding-token windows ({@code CREDIT_LIMIT}/{@code TOKENS_LIMIT}) map to 5h/7d; the
 * {@code TIME_LIMIT} monthly MCP budget maps to a {@code monthly} window. Only limits
 * carrying a {@code percentage} are emitted.
 */
export function parseZaiQuota(body: unknown): Json | null {
  if (!body || typeof body !== 'object') return null;
  const data = (body as Json).data;
  if (!data || typeof data !== 'object' || !Array.isArray((data as Json).limits)) {
    return null;
  }
  const level = asString(data as Json, 'level');

  // Two limit types can map to the same window (e.g. TOKENS_LIMIT and
  // CREDIT_LIMIT both with unit=3 → "5h"); merge them, surfacing the worse
  // usage, so the frontend never sees duplicate window ids.
  const byPeriod = new Map<string, Json>();
  for (const el of (data as Json).limits as unknown[]) {
    if (!el || typeof el !== 'object') continue;
    const lim = el as Json;
    let pct = asDouble(lim, 'percentage');
    if (pct === null) continue;
    pct = clampPct(pct);
    const type = asString(lim, 'type');
    const period = zaiPeriod(lim, type);
    if (period === null) continue;
    const resetsAtMs = asEpochMs(lim, 'nextResetTime', 'next_reset_time');

    const existing = byPeriod.get(period);
    if (existing) {
      if (pct > existing.used_pct) existing.used_pct = pct;
      if (!existing.reset_at && resetsAtMs !== null) existing.reset_at = new Date(resetsAtMs).toISOString();
      continue;
    }
    byPeriod.set(period, windowEntry(period, pct, resetsAtMs));
  }
  return capacityPayload('zai-quota-limit', Array.from(byPeriod.values()), level);
}

// ===== Vendor registry =====

const KIMI_CODING_VENDOR: RelayUsageVendor = {
  id: 'kimi-coding',
  usagePath: '/coding/v1/usages',
  // api.kimi.com also serves the plain Moonshot-style API; only the /coding
  // path is the Coding Plan whose /v1/usages endpoint exists. The segment
  // boundary matters: a hypothetical "/codingfoo" path is not the plan.
  matches: (host, path) =>
    host === 'api.kimi.com' && (path === '/coding' || path.startsWith('/coding/')),
  parse: (body) => parseKimiCodingUsages(body),
};

const MINIMAX_VENDOR: RelayUsageVendor = {
  id: 'minimax',
  usagePath: '/v1/api/openplatform/coding_plan/remains',
  matches: (host) =>
    host === 'minimaxi.com' || !!host?.endsWith('.minimaxi.com')
    || host === 'minimax.io' || !!host?.endsWith('.minimax.io'),
  parse: (body, env) => parseMinimaxRemains(body, env.model),
};

const ZAI_VENDOR: RelayUsageVendor = {
  id: 'zai',
  usagePath: ZAI_USAGE_PATH,
  matches: (host) =>
    host === 'z.ai' || !!host?.endsWith('.z.ai')
    || host === 'open.bigmodel.cn' || !!host?.endsWith('.bigmodel.cn'),
  parse: (body) => parseZaiQuota(body),
};

/**
 * Registered relay vendors, in match order (upstream RelayUsageRegistry).
 * Order matters where vendors share a host: api.kimi.com serves both the plain
 * Moonshot API and the Coding Plan, so kimi-coding (path-gated on /coding)
 * must sit before any future plain-kimi vendor.
 */
export const RELAY_USAGE_VENDORS: readonly RelayUsageVendor[] = [
  KIMI_CODING_VENDOR,
  MINIMAX_VENDOR,
  ZAI_VENDOR,
];

/** Vendor owning {@code baseUrl}, or null when unassigned/malformed. */
export function matchRelayVendor(baseUrl: string | null | undefined): RelayUsageVendor | null {
  if (!baseUrl) return null;
  let host: string;
  let path: string;
  try {
    const u = new URL(baseUrl);
    if (!u.hostname) return null;
    host = u.hostname.toLowerCase();
    path = (u.pathname || '').toLowerCase();
  } catch {
    return null;
  }
  for (const vendor of RELAY_USAGE_VENDORS) {
    if (vendor.matches(host, path)) return vendor;
  }
  return null;
}

// ============================================================================
// Real Anthropic rate_limit_event
// ============================================================================

/**
 * Window classification prefers the CLI-provided {@code rateLimitType}
 * ({@code five_hour} / {@code seven_day} / {@code seven_day_sonnet} / …) over
 * the reset-delta heuristic, which only survives as a fallback.
 */
export function periodTypeFromRateLimit(rateLimitInfo: Json, resetsAtMs: number | null): string {
  const type = asString(rateLimitInfo, 'rateLimitType') ?? asString(rateLimitInfo, 'rate_limit_type');
  if (type) {
    if (type.startsWith('five_hour')) return '5h';
    if (type.startsWith('seven_day')) return '7d';
  }
  return resetsAtMs !== null ? periodTypeFromResetMs(resetsAtMs) : '5h';
}

export function periodTypeFromResetMs(resetsAtMs: number, nowMs: number = Date.now()): string {
  const deltaMs = resetsAtMs - nowMs;
  return deltaMs <= 6 * 60 * 60 * 1000 ? '5h' : '7d';
}

/** Build the capacity payload cached from a SDK {@code rate_limit_event}. */
export function buildCapacityPayload(rateLimitInfo: Json): Json | null {
  const utilization = asDouble(rateLimitInfo, 'utilization');
  if (utilization === null) return null;
  // The CLI documents utilization as a fraction of the window (0-1, and
  // exceeding 1 when over capacity), so scale it to a percent. The <= 10
  // guard only protects against a hypothetical already-percent payload
  // (0-100) from being scaled twice.
  const pct = clampPct(utilization <= 10.0 ? utilization * 100.0 : utilization);

  // resetsAt is epoch SECONDS in the Anthropic CLI schema, but relay vendors may
  // already send millis — sniff the unit instead of assuming (upstream 7b75df6d).
  const resetsAtMs = asEpochMs(rateLimitInfo, 'resetsAt', 'resets_at', 'resetAt');
  const resetAt = resetsAtMs !== null ? new Date(resetsAtMs).toISOString() : null;
  const periodType = periodTypeFromRateLimit(rateLimitInfo, resetsAtMs);

  const window: Json = { id: periodType, used_pct: pct, period_type: periodType };
  if (resetAt) window.reset_at = resetAt;

  const out: Json = {
    ok: true,
    present: true,
    provider: 'claude',
    source: 'sdk-rate-limit',
    capacity_pct: pct,
    period_type: periodType,
    windows: [window],
  };
  if (resetAt) out.reset_at = resetAt;
  const status = asString(rateLimitInfo, 'status');
  if (status) out.rate_limit_status = status;
  return out;
}

// ============================================================================
// Service
// ============================================================================

/** Production relay usage probe (plain http/https, Bearer auth, no redirects). */
function httpGetJson(url: string, token: string): Promise<unknown> {
  // Manual deferred — Promise.withResolvers requires ES2024 lib, which this
  // project's tsconfig target does not include.
  let resolve!: (value: unknown) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    reject(new Error(`Invalid relay usage URL: ${url}`));
    return promise;
  }
  const client = parsed.protocol === 'http:' ? http : https;
  const request = client.get(parsed, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'User-Agent': 'vscode-cc-gui-relay-usage',
    },
    timeout: HTTP_TIMEOUT_MS,
  }, (response) => {
    const status = response.statusCode ?? 0;
    if (status !== 200) {
      response.resume();
      reject(new Error(`relay usage HTTP ${status}`));
      return;
    }
    const chunks: Buffer[] = [];
    response.on('data', (chunk: Buffer) => chunks.push(chunk));
    response.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(new Error(`Invalid JSON from ${url}: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
    response.on('error', (error) => reject(error));
  });
  request.on('timeout', () => {
    request.destroy(new Error(`Request to ${url} timed out after ${HTTP_TIMEOUT_MS}ms`));
  });
  request.on('error', (error) => reject(error));
  return promise;
}

export class ClaudePlanUsageService {
  /**
   * Fresh-cache TTL. Set just under the webview's 120s poll cadence so that
   * back-to-back polls (multiple panels, manual refresh) dedupe onto a
   * single probe; a regular 120s poll always re-probes.
   */
  static readonly RELAY_CACHE_TTL_MS = 115_000;
  /** Max age for serving a stale cached payload after repeated probe failures. */
  static readonly RELAY_CACHE_STALE_MAX_MS = 30 * 60_000;
  /**
   * Bound on cached relay payloads: settings can hold multiple relay
   * credentials over the lifetime of one extension host (upstream RelayUsageCache).
   */
  static readonly RELAY_CACHE_MAX_ENTRIES = 16;

  /** Last rate_limit_event snapshot (real Anthropic). Null until the first event arrives. */
  private cachedRateLimit: Json | null = null;

  /**
   * Bounded insertion-ordered relay payload cache. Reads and writes both
   * refresh insertion order, so actively polled accounts survive eviction
   * (upstream RelayUsageCache + eb249af5 touch-on-hit). Payloads are deep-copied
   * at the boundaries so callers cannot mutate cached data.
   */
  private readonly relayCache = new Map<string, { atMs: number; payload: Json }>();

  private readonly readSettings: ClaudeSettingsReader;
  private transport: RelayTransport;
  private readonly log: (line: string) => void;

  constructor(
    readSettings: ClaudeSettingsReader = readClaudeSettingsFile,
    transport: RelayTransport = httpGetJson,
    log: (line: string) => void = () => {},
  ) {
    this.readSettings = readSettings;
    this.transport = transport;
    this.log = log;
  }

  /**
   * Cache a {@code rate_limit_event} snapshot from the SDK stream (real Anthropic).
   * Called by {@code bridge.ts} when a {@code [MESSAGE]} line carries
   * {@code type: 'rate_limit_event'}.
   */
  cacheRateLimitInfo(rateLimitInfo: unknown): void {
    if (!rateLimitInfo || typeof rateLimitInfo !== 'object') return;
    try {
      const payload = buildCapacityPayload(rateLimitInfo as Json);
      if (payload) {
        this.cachedRateLimit = payload;
      }
    } catch (e) {
      this.log(`[ClaudePlanUsage] Failed to cache rate_limit_event: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Resolve the plan-usage payload for the webview poll. Delegates to the relay
   * vendor registry (cache + probe + stale policy inside); when no vendor
   * matches or every probe path fails, falls back to the cached rate_limit
   * snapshot (real Anthropic). Final fallback is an unavailable marker.
   *
   * Settings are re-read from disk on each call, so edits to settings.json are
   * picked up between polls.
   */
  async resolvePlanUsagePayload(nowMs: number = Date.now()): Promise<Json> {
    try {
      const settings = this.readSettings?.() ?? null;
      if (settings) {
        const relay = await this.resolveViaRelayVendors(settings, nowMs);
        if (relay) return relay;
      }
    } catch (e) {
      this.log(`[ClaudePlanUsage] Resolve failed, falling back to rate_limit cache: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (this.cachedRateLimit) {
      return deepCopy(this.cachedRateLimit);
    }
    return unavailable('Claude usage unavailable');
  }

  /**
   * Resolve via the relay vendor registry: match ANTHROPIC_BASE_URL against
   * {@link RELAY_USAGE_VENDORS}, then probe with the shared cache/stale policy
   * (upstream RelayUsageRegistry.resolve). Null when no vendor matches, the
   * credential is missing, or the probe yields no usable data and no fresh or
   * stale cache entry can be served — the caller falls back to the SDK
   * rate_limit snapshot. Exposed for tests.
   */
  async resolveViaRelayVendors(settings: Json, nowMs: number = Date.now()): Promise<Json | null> {
    const env = relayEnvFromSettings(settings);
    const vendor = matchRelayVendor(env.baseUrl);
    if (!vendor || !env.token || !env.baseUrl) return null;
    // Keep credentials out of long-lived cache objects while retaining account
    // isolation. MiniMax selects a model-specific quota before the payload
    // reaches the cache, so its key includes the model (upstream 7b75df6d).
    let cacheKey = `${vendor.id}\n${canonicalBaseUrl(env.baseUrl)}\n${sha256Hex(env.token)}`;
    if (vendor.id === 'minimax') {
      cacheKey += `\n${env.model ?? ''}`;
    }

    const fresh = this.relayCacheRead(cacheKey, nowMs, ClaudePlanUsageService.RELAY_CACHE_TTL_MS, false);
    if (fresh) return fresh;

    const origin = secureOrigin(env.baseUrl);
    if (origin) {
      try {
        const body = await this.transport(origin + vendor.usagePath, env.token);
        const payload = vendor.parse(body, env);
        if (payload) {
          this.relayCacheStore(cacheKey, payload, nowMs);
          return deepCopy(payload);
        }
      } catch (e) {
        this.log(`[ClaudePlanUsage] relay usage probe failed (${vendor.id}): ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return this.relayCacheRead(cacheKey, nowMs, ClaudePlanUsageService.RELAY_CACHE_STALE_MAX_MS, true);
  }

  /**
   * Fresh ({@code maxAgeMs} = TTL) or stale (STALE_MAX, flagged) cache read.
   * Every hit refreshes insertion order so actively polled accounts are not
   * evicted by probes of other accounts. A clock rollback (nowMs < atMs) makes
   * the entry's age unknowable and counts as a miss — re-probe rather than
   * serve data of unknowable age (upstream RelayUsageCache.age).
   */
  private relayCacheRead(key: string, nowMs: number, maxAgeMs: number, markStale: boolean): Json | null {
    const c = this.relayCache.get(key);
    if (!c) return null;
    const ageMs = nowMs - c.atMs;
    if (ageMs < 0 || ageMs >= maxAgeMs) return null;
    this.relayCache.delete(key);
    this.relayCache.set(key, c);
    const copy = deepCopy(c.payload);
    if (markStale) copy.stale = true;
    return copy;
  }

  private relayCacheStore(key: string, payload: Json, nowMs: number): void {
    this.relayCache.delete(key);
    this.relayCache.set(key, { atMs: nowMs, payload: deepCopy(payload) });
    while (this.relayCache.size > ClaudePlanUsageService.RELAY_CACHE_MAX_ENTRIES) {
      const oldest = this.relayCache.keys().next().value;
      if (oldest === undefined) break;
      this.relayCache.delete(oldest);
    }
  }

  /** Test-only: replace the HTTP transport. Pass the default to restore. */
  setRelayTransportForTests(transport: RelayTransport): void {
    this.transport = transport;
  }

  /** Test-only: drop cached snapshots. */
  resetCachesForTests(): void {
    this.relayCache.clear();
    this.cachedRateLimit = null;
  }
}
