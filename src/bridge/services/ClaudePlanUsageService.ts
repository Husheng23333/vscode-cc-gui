/**
 * Claude plan-usage snapshot builder + resolver.
 * TypeScript port of the JetBrains plugin's ClaudePlanUsageService.
 *
 * Feeds the ContextBar plan-usage indicator with a capacity payload
 * ({@code capacity_pct} + {@code windows[]}). Two data sources, picked by backend:
 *
 * - z.ai proxy (detected via ANTHROPIC_BASE_URL host being {@code z.ai} or a
 *   subdomain): probes {@code {origin}/api/monitor/usage/quota/limit} and parses
 *   the {@code TOKENS_LIMIT}/{@code CREDIT_LIMIT} windows (5h + 7d) plus the
 *   {@code TIME_LIMIT} monthly MCP budget.
 * - Real Anthropic (OAuth subscription): the SDK emits {@code rate_limit_event}
 *   ({@code rate_limit_info: {status, resetsAt, utilization}}) during turns;
 *   {@code bridge.ts} caches it via {@link cacheRateLimitInfo}.
 *
 * The webview polls {@code get_claude_plan_usage} (~every 120s).
 */

import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import { URL } from 'url';

type Json = Record<string, any>;

/** Test seam replacing the real HTTP probe. */
export type ZaiTransport = (url: string, token: string) => Promise<unknown>;

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

/** A z.ai backend is identified by its anthropic-compat base URL host being {@code z.ai} or a subdomain. */
export function isZaiBackend(settings: Json | null): boolean {
  const base = envString(settings, 'ANTHROPIC_BASE_URL');
  if (!base) return false;
  try {
    const host = new URL(base).hostname?.toLowerCase();
    if (!host) return false;
    return host === 'z.ai' || host.endsWith('.z.ai');
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
  try {
    const u = new URL(baseUrl);
    const scheme = u.protocol.replace(/:$/, '');
    const host = u.hostname;
    if (!scheme || !host) return null;
    const loopback = host.toLowerCase() === 'localhost' || host === '127.0.0.1' || host === '::1';
    if (scheme.toLowerCase() !== 'https' && !(scheme.toLowerCase() === 'http' && loopback)) {
      return null;
    }
    const origin = u.port ? `${scheme}://${host}:${u.port}` : `${scheme}://${host}`;
    return `${origin}/api/monitor/usage/quota/limit`;
  } catch {
    return null;
  }
}

/**
 * Map a z.ai limit to a window id/period. Observed z.ai payloads use
 * unit 3=hours (number=5 → 5h), unit 6=weeks (number=1 → 7d) and unit 4=days
 * (number=7 → 7d). The {@code number} field is assumed to match those shapes —
 * a hypothetical unit=4/number=1 (1-day) window would still be labelled 7d.
 */
function zaiPeriod(lim: Json, type: string | null): string {
  if (type && type.toUpperCase().includes('TIME')) return 'monthly';
  const unit = asInt(lim, 'unit');
  if (unit === null) return '5h';
  switch (unit) {
    case 3: return '5h';
    case 6:
    case 4: return '7d';
    default: return '5h';
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
    const resetsAtMs = asLong(lim, 'nextResetTime', 'next_reset_time');
    const resetAt = resetsAtMs !== null ? new Date(resetsAtMs).toISOString() : null;

    const existing = byPeriod.get(period);
    if (existing) {
      if (pct > existing.used_pct) existing.used_pct = pct;
      if (!existing.reset_at && resetAt) existing.reset_at = resetAt;
      continue;
    }

    const w: Json = { id: period, used_pct: pct, period_type: period };
    if (resetAt) w.reset_at = resetAt;
    byPeriod.set(period, w);
  }
  if (byPeriod.size === 0) return null;

  let primary5h: number | null = null;
  let maxPct = 0;
  for (const w of byPeriod.values()) {
    if (w.id === '5h') primary5h = w.used_pct;
    if (w.used_pct > maxPct) maxPct = w.used_pct;
  }

  const out: Json = {
    ok: true,
    present: true,
    provider: 'claude',
    source: 'zai-quota-limit',
    capacity_pct: primary5h !== null ? primary5h : maxPct,
    period_type: byPeriod.keys().next().value,
    windows: Array.from(byPeriod.values()),
  };
  if (level) out.level = level;
  return out;
}

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

  // resetsAt is unix epoch SECONDS in the CLI schema (the CLI computes
  // `resetsAt - Date.now()/1000`), not millis — convert before use.
  const resetsAtSec = asLong(rateLimitInfo, 'resetsAt', 'resets_at', 'resetAt');
  const resetsAtMs = resetsAtSec !== null ? resetsAtSec * 1000 : null;
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

/** Production z.ai monitor probe (plain http/https, Bearer auth, no redirects). */
function httpGetJson(url: string, token: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error(`Invalid z.ai monitor URL: ${url}`));
      return;
    }
    const client = parsed.protocol === 'http:' ? http : https;
    const request = client.get(parsed, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'User-Agent': 'vscode-cc-gui-claude-plan-usage',
      },
      timeout: HTTP_TIMEOUT_MS,
    }, (response) => {
      const status = response.statusCode ?? 0;
      if (status !== 200) {
        response.resume();
        reject(new Error(`z.ai monitor HTTP ${status}`));
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
  });
}

export class ClaudePlanUsageService {
  /**
   * Fresh-cache TTL. Set just under the webview's 120s poll cadence so that
   * back-to-back polls (multiple panels, manual refresh) dedupe onto a
   * single probe; a regular 120s poll always re-probes.
   */
  static readonly ZAI_CACHE_TTL_MS = 115_000;
  /** Max age for serving a stale cached payload after repeated probe failures. */
  static readonly ZAI_STALE_MAX_MS = 30 * 60_000;

  /** Last rate_limit_event snapshot (real Anthropic). Null until the first event arrives. */
  private cachedRateLimit: Json | null = null;

  private cachedZai: { atMs: number; key: string; payload: Json } | null = null;

  private readonly readSettings: ClaudeSettingsReader;
  private transport: ZaiTransport;
  private readonly log: (line: string) => void;

  constructor(
    readSettings: ClaudeSettingsReader = readClaudeSettingsFile,
    transport: ZaiTransport = httpGetJson,
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
   * Resolve the plan-usage payload for the webview poll. Probes the z.ai monitor
   * endpoint on a z.ai backend; otherwise returns the cached rate_limit snapshot
   * (real Anthropic). Falls back to an unavailable marker.
   *
   * Settings are re-read from disk on each call, so edits to settings.json are
   * picked up between polls.
   */
  async resolvePlanUsagePayload(nowMs: number = Date.now()): Promise<Json> {
    try {
      const settings = this.readSettings?.() ?? null;
      if (settings && isZaiBackend(settings)) {
        const zai = await this.resolveViaZaiMonitor(settings, nowMs);
        if (zai) return zai;
      }
    } catch (e) {
      this.log(`[ClaudePlanUsage] Resolve failed, falling back to rate_limit cache: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (this.cachedRateLimit) {
      return deepCopy(this.cachedRateLimit);
    }
    return unavailable('Claude usage unavailable');
  }

  /** z.ai monitor probe with TTL cache + bounded stale fallback. Exposed for tests. */
  async resolveViaZaiMonitor(settings: Json, nowMs: number = Date.now()): Promise<Json | null> {
    const base = envString(settings, 'ANTHROPIC_BASE_URL');
    const token = envString(settings, 'ANTHROPIC_AUTH_TOKEN') ?? envString(settings, 'ANTHROPIC_API_KEY');
    const url = base && token ? monitorUrl(base) : null;
    if (!url || !token) return null;
    // Key the cache by endpoint + credential so an account/base-URL switch
    // never serves the previous account's quota.
    const cacheKey = `${url}\n${token}`;

    const c = this.cachedZai;
    if (c && c.key === cacheKey && nowMs - c.atMs < ClaudePlanUsageService.ZAI_CACHE_TTL_MS) {
      return deepCopy(c.payload);
    }
    try {
      const body = await this.transport(url, token);
      const payload = parseZaiQuota(body);
      if (payload) {
        this.cachedZai = { atMs: nowMs, key: cacheKey, payload };
        return deepCopy(payload);
      }
    } catch (e) {
      this.log(`[ClaudePlanUsage] z.ai quota probe failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    // Serve the last good payload while probes keep failing — but only for a
    // bounded window, so a long outage doesn't masquerade as live data.
    if (c && c.key === cacheKey && nowMs - c.atMs < ClaudePlanUsageService.ZAI_STALE_MAX_MS) {
      const copy = deepCopy(c.payload);
      copy.stale = true;
      return copy;
    }
    return null;
  }

  /** Test-only: replace the HTTP transport. Pass the default to restore. */
  setZaiTransportForTests(transport: ZaiTransport): void {
    this.transport = transport;
  }

  /** Test-only: drop cached snapshots. */
  resetCachesForTests(): void {
    this.cachedZai = null;
    this.cachedRateLimit = null;
  }
}
