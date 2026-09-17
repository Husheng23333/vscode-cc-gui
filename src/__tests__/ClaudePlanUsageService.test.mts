import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ClaudePlanUsageService,
  buildCapacityPayload,
  clampPct,
  isZaiBackend,
  monitorUrl,
  matchRelayVendor,
  parseKimiCodingUsages,
  parseMinimaxRemains,
  secureOrigin,
  parseZaiQuota,
  periodTypeFromResetMs,
} from '../bridge/services/ClaudePlanUsageService.ts';

/** resetsAt is epoch SECONDS in the CLI rate_limit_info schema. */
function info(utilization: number, resetsAtSec: number, status?: string, extra?: Record<string, unknown>) {
  const o: Record<string, unknown> = { utilization, resetsAt: resetsAtSec };
  if (status !== undefined) o.status = status;
  return { ...o, ...extra };
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function settingsWithBase(base: string) {
  return { env: { ANTHROPIC_BASE_URL: base } };
}

function settingsWithBaseAndToken(base: string, token: string) {
  return { env: { ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: token } };
}

function zaiBody(pct: number) {
  return {
    data: {
      level: 'max',
      limits: [
        { type: 'CREDIT_LIMIT', unit: 3, number: 5, percentage: pct, nextResetTime: 1786624965401 },
      ],
    },
  };
}

function makeService(transport?: (url: string, token: string) => Promise<unknown>) {
  return new ClaudePlanUsageService(() => null, transport ?? (async () => zaiBody(0)));
}

describe('buildCapacityPayload', () => {
  it('maps fraction utilization to percent with a 5h window', () => {
    const resetsAt = nowSec() + 3 * 60 * 60; // ~3h out → 5h bucket
    const payload = buildCapacityPayload(info(0.42, resetsAt, 'allowed_warning'))!;

    assert.equal(payload.capacity_pct, 42);
    assert.equal(payload.provider, 'claude');
    assert.equal(payload.source, 'sdk-rate-limit');
    assert.equal(payload.present, true);
    assert.equal(payload.period_type, '5h');
    assert.equal(payload.rate_limit_status, 'allowed_warning');
    assert.ok(payload.reset_at);

    const window = payload.windows[0];
    assert.equal(window.id, '5h');
    assert.equal(window.used_pct, 42);
    assert.equal(window.period_type, '5h');
  });

  it('converts epoch-seconds resetsAt to an ISO timestamp', () => {
    const resetsAtSec = nowSec() + 2 * 60 * 60; // 2h out
    const payload = buildCapacityPayload(info(0.1, resetsAtSec))!;

    const parsedMs = Date.parse(payload.reset_at);
    assert.equal(parsedMs, resetsAtSec * 1000);
    // 2h out must classify as the 5h window — with the old millis misread
    // this landed in 1970 and misclassified everything.
    assert.equal(payload.period_type, '5h');
  });

  it('clamps over-capacity fraction utilization to 100', () => {
    // utilization 1.3 = 130% used (over capacity) — must surface as ~100%,
    // not as a tiny "1.3%" reading.
    const payload = buildCapacityPayload(info(1.3, nowSec() + 3600))!;
    assert.equal(payload.capacity_pct, 100);
  });

  it('treats utilization above 10 as an already-percent value', () => {
    const resetsAt = nowSec() + 5 * 24 * 60 * 60; // ~5d → 7d bucket
    const payload = buildCapacityPayload(info(87, resetsAt, 'rejected'))!;

    assert.equal(payload.capacity_pct, 87);
    assert.equal(payload.period_type, '7d');
    assert.equal(payload.rate_limit_status, 'rejected');
  });

  it('prefers rateLimitType over the reset-delta heuristic', () => {
    // A seven_day window whose reset happens to be <6h out must still be 7d.
    assert.equal(
      buildCapacityPayload(info(0.5, nowSec() + 2 * 60 * 60, undefined, { rateLimitType: 'seven_day' }))!.period_type,
      '7d',
    );
    assert.equal(
      buildCapacityPayload(info(0.5, nowSec() + 2 * 60 * 60, undefined, { rateLimitType: 'seven_day_sonnet' }))!.period_type,
      '7d',
    );
    assert.equal(
      buildCapacityPayload(info(0.5, nowSec() + 5 * 24 * 60 * 60, undefined, { rateLimitType: 'five_hour' }))!.period_type,
      '5h',
    );
  });

  it('returns null when utilization is missing', () => {
    assert.equal(buildCapacityPayload({ resetsAt: nowSec() + 1 }), null);
  });
  it('accepts an epoch-millis resetsAt without double-converting (upstream 7b75df6d)', () => {
    // Relay vendors may already send millis; the old unconditional *1000 turned
    // those into year ~56000 and broke both reset_at and the window heuristic.
    const resetsAtMs = Date.now() + 2 * 60 * 60 * 1000; // 2h out → 5h bucket
    const payload = buildCapacityPayload(info(0.1, resetsAtMs))!;

    assert.equal(Date.parse(payload.reset_at), resetsAtMs);
    assert.equal(payload.period_type, '5h');
  });
});

describe('clampPct / periodTypeFromResetMs', () => {
  it('bounds to [0, 100]', () => {
    assert.equal(clampPct(-5), 0);
    assert.equal(clampPct(144), 100);
    assert.equal(clampPct(50), 50);
  });

  it('classifies 5h and 7d windows by reset delta', () => {
    const now = Date.now();
    assert.equal(periodTypeFromResetMs(now + 2 * 60 * 60 * 1000, now), '5h');
    assert.equal(periodTypeFromResetMs(now + 6 * 60 * 60 * 1000, now), '5h');
    assert.equal(periodTypeFromResetMs(now + 2 * 24 * 60 * 60 * 1000, now), '7d');
  });
});

describe('parseZaiQuota', () => {
  it('maps 5h/7d windows and level', () => {
    const payload = parseZaiQuota({
      code: 200,
      success: true,
      data: {
        level: 'max',
        limits: [
          { type: 'CREDIT_LIMIT', unit: 3, number: 5, percentage: 13, nextResetTime: 1786624965401 },
          { type: 'CREDIT_LIMIT', unit: 6, number: 1, percentage: 2, nextResetTime: 1787155353998 },
        ],
      },
    })!;

    assert.equal(payload.provider, 'claude');
    assert.equal(payload.source, 'zai-quota-limit');
    assert.equal(payload.present, true);
    assert.equal(payload.capacity_pct, 13);
    assert.equal(payload.period_type, '5h');
    assert.equal(payload.level, 'max');

    assert.equal(payload.windows.length, 2);
    assert.equal(payload.windows[0].id, '5h');
    assert.equal(payload.windows[0].used_pct, 13);
    assert.equal(payload.windows[1].id, '7d');
    assert.equal(payload.windows[1].used_pct, 2);
  });

  it('maps TIME_LIMIT to a monthly window', () => {
    const payload = parseZaiQuota({
      data: { level: 'pro', limits: [{ type: 'TIME_LIMIT', unit: 4, number: 1, percentage: 55 }] },
    })!;
    assert.equal(payload.windows[0].id, 'monthly');
    assert.equal(payload.level, 'pro');
  });

  it('returns null for empty limits', () => {
    assert.equal(parseZaiQuota({ data: { limits: [] } }), null);
  });

  it('maps CREDIT_LIMIT unit=days to 7d', () => {
    const payload = parseZaiQuota({
      data: { limits: [{ type: 'CREDIT_LIMIT', unit: 4, number: 7, percentage: 41 }] },
    })!;
    assert.equal(payload.windows[0].id, '7d');
    assert.equal(payload.capacity_pct, 41);
  });

  it('merges duplicate period windows keeping the worse usage', () => {
    const payload = parseZaiQuota({
      data: {
        limits: [
          { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 10, nextResetTime: 1786624965401 },
          { type: 'CREDIT_LIMIT', unit: 3, number: 5, percentage: 20, nextResetTime: 1786624965401 },
        ],
      },
    })!;

    assert.equal(payload.windows.length, 1);
    assert.equal(payload.windows[0].id, '5h');
    assert.equal(payload.windows[0].used_pct, 20);
    assert.equal(payload.capacity_pct, 20);
  });
  it('ignores unknown or inconsistent unit/number shapes instead of guessing (upstream 7b75df6d)', () => {
    // unit=3 but number=6 is not the observed 5-hour shape; unit=4/number=1
    // (hypothetical 1-day) must no longer be labelled 7d; missing number is unknown.
    const payload = parseZaiQuota({
      data: {
        limits: [
          { type: 'CREDIT_LIMIT', unit: 3, number: 6, percentage: 10 },
          { type: 'CREDIT_LIMIT', unit: 4, number: 1, percentage: 20 },
          { type: 'CREDIT_LIMIT', unit: 99, number: 1, percentage: 30 },
          { type: 'CREDIT_LIMIT', unit: 3, percentage: 40 },
        ],
      },
    });
    assert.equal(payload, null);

    // A recognizable window alongside unknown ones keeps only the known window.
    const mixed = parseZaiQuota({
      data: {
        limits: [
          { type: 'CREDIT_LIMIT', unit: 3, number: 6, percentage: 10 },
          { type: 'CREDIT_LIMIT', unit: 3, number: 5, percentage: 42, nextResetTime: 1786624965401 },
        ],
      },
    })!;
    assert.equal(mixed.windows.length, 1);
    assert.equal(mixed.windows[0].id, '5h');
    assert.equal(mixed.capacity_pct, 42);
  });
});

describe('isZaiBackend', () => {
  it('matches the z.ai host only', () => {
    assert.equal(isZaiBackend(settingsWithBase('https://api.z.ai/api/anthropic')), true);
    assert.equal(isZaiBackend(settingsWithBase('https://z.ai/api/anthropic')), true);
    assert.equal(isZaiBackend(settingsWithBase('https://api.anthropic.com')), false);
    // Look-alike hosts must not trigger the z.ai probe
    assert.equal(isZaiBackend(settingsWithBase('https://quiz.ai/api/anthropic')), false);
    assert.equal(isZaiBackend(settingsWithBase('https://buzz.ai/api')), false);
    // z.ai appearing only in the path is not a z.ai host
    assert.equal(isZaiBackend(settingsWithBase('https://gateway.example.com/z.ai/proxy')), false);
    // Malformed base URL → not z.ai, never throws
    assert.equal(isZaiBackend(settingsWithBase('not a url')), false);
  });
  it('matches bigmodel.cn hosts sharing the z.ai usage API (upstream 7b75df6d)', () => {
    assert.equal(isZaiBackend(settingsWithBase('https://open.bigmodel.cn/api/anthropic')), true);
    assert.equal(isZaiBackend(settingsWithBase('https://dev.bigmodel.cn/api/anthropic')), true);
    // Look-alikes must not trigger the probe
    assert.equal(isZaiBackend(settingsWithBase('https://notbigmodel.cn/api')), false);
    assert.equal(isZaiBackend(settingsWithBase('https://bigmodel.cn.evil.example/api')), false);
  });
});

describe('monitorUrl', () => {
  it('derives origin and path', () => {
    assert.equal(
      monitorUrl('https://api.z.ai/api/anthropic'),
      'https://api.z.ai/api/monitor/usage/quota/limit',
    );
  });

  it('keeps a custom port', () => {
    assert.equal(
      monitorUrl('http://localhost:8080/api/anthropic'),
      'http://localhost:8080/api/monitor/usage/quota/limit',
    );
  });

  it('rejects plain HTTP except for loopback hosts', () => {
    // Bearer tokens must not travel over plaintext to a remote host
    assert.equal(monitorUrl('http://api.z.ai/api/anthropic'), null);
    assert.equal(monitorUrl('http://z.ai/api/anthropic'), null);
    // Loopback proxies (local dev / tests) may use plain HTTP
    assert.equal(
      monitorUrl('http://127.0.0.1:9000/api/anthropic'),
      'http://127.0.0.1:9000/api/monitor/usage/quota/limit',
    );
    assert.equal(
      monitorUrl('http://localhost:8080/api/anthropic'),
      'http://localhost:8080/api/monitor/usage/quota/limit',
    );
  });
  it('allows plain HTTP to IPv6 loopback (upstream 7b75df6d)', () => {
    assert.equal(
      monitorUrl('http://[::1]:9000/api/anthropic'),
      'http://[::1]:9000/api/monitor/usage/quota/limit',
    );
  });
});

describe('resolveViaRelayVendors (transport injected)', () => {
  it('sends the Bearer token to the derived monitor URL', async () => {
    const seen: string[] = [];
    const service = makeService(async (url, token) => {
      seen.push(url, token);
      return zaiBody(42);
    });

    const payload = await service.resolveViaRelayVendors(
      settingsWithBaseAndToken('https://api.z.ai/api/anthropic', 'glm-secret'), 1000);

    assert.equal(seen[0], 'https://api.z.ai/api/monitor/usage/quota/limit');
    assert.equal(seen[1], 'glm-secret');
    assert.equal(payload!.capacity_pct, 42);
  });

  it('falls back to ANTHROPIC_API_KEY when the auth token is missing', async () => {
    const seen: string[] = [];
    const service = makeService(async (_url, token) => {
      seen.push(token);
      return zaiBody(1);
    });

    const settings = settingsWithBase('https://api.z.ai/api/anthropic');
    (settings.env as Record<string, string>).ANTHROPIC_API_KEY = 'sk-fallback';
    await service.resolveViaRelayVendors(settings, 1000);

    assert.equal(seen[0], 'sk-fallback');
  });

  it('enforces the cache TTL', async () => {
    let calls = 0;
    const service = makeService(async () => {
      calls += 1;
      return zaiBody(10);
    });
    const settings = settingsWithBaseAndToken('https://api.z.ai/api/anthropic', 't');
    const t0 = 1_000_000;

    await service.resolveViaRelayVendors(settings, t0);
    assert.equal(calls, 1);
    // Within TTL → served from cache, no second probe
    await service.resolveViaRelayVendors(settings, t0 + ClaudePlanUsageService.RELAY_CACHE_TTL_MS - 1);
    assert.equal(calls, 1);
    // TTL expired → probes again
    await service.resolveViaRelayVendors(settings, t0 + ClaudePlanUsageService.RELAY_CACHE_TTL_MS + 1);
    assert.equal(calls, 2);
  });

  it('keys the cache by url + token (account switch re-probes)', async () => {
    let calls = 0;
    const service = makeService(async () => {
      calls += 1;
      return zaiBody(10);
    });
    const t0 = 1_000_000;

    await service.resolveViaRelayVendors(settingsWithBaseAndToken('https://api.z.ai/api/anthropic', 'account-a'), t0);
    assert.equal(calls, 1);
    // Same URL but a different token (account switch) must not reuse the cache
    await service.resolveViaRelayVendors(settingsWithBaseAndToken('https://api.z.ai/api/anthropic', 'account-b'), t0 + 1);
    assert.equal(calls, 2);
  });

  it('serves a stale payload on probe failure, bounded by the stale cap', async () => {
    let fail = false;
    const service = makeService(async () => {
      if (fail) throw new Error('boom');
      return zaiBody(33);
    });
    const settings = settingsWithBaseAndToken('https://api.z.ai/api/anthropic', 't');
    const t0 = 1_000_000;

    await service.resolveViaRelayVendors(settings, t0);

    fail = true;
    // Probe fails with an expired-but-recent cache → stale payload
    const stale = await service.resolveViaRelayVendors(settings, t0 + ClaudePlanUsageService.RELAY_CACHE_TTL_MS + 1);
    assert.equal(stale!.capacity_pct, 33);
    assert.equal(stale!.stale, true);

    // Cache older than the stale cap → give up (null → caller falls back)
    assert.equal(await service.resolveViaRelayVendors(settings, t0 + ClaudePlanUsageService.RELAY_CACHE_STALE_MAX_MS + 1), null);
  });
  it('re-probes when the clock rolls back instead of serving unknowable-age data', async () => {
    let calls = 0;
    let fail = false;
    const service = makeService(async () => {
      calls += 1;
      if (fail) throw new Error('boom');
      return zaiBody(10);
    });
    const settings = settingsWithBaseAndToken('https://api.z.ai/api/anthropic', 't');

    await service.resolveViaRelayVendors(settings, 1_000_000);
    assert.equal(calls, 1);
    // nowMs < atMs (clock rollback): the cached entry must not count as fresh…
    await service.resolveViaRelayVendors(settings, 999_999);
    assert.equal(calls, 2);
    // …nor be served as stale when the re-probe fails.
    fail = true;
    assert.equal(await service.resolveViaRelayVendors(settings, 999_998), null);
  });
});
describe('matchRelayVendor (registry order + host/path gating)', () => {
  it('matches api.kimi.com only on the /coding path segment', () => {
    // api.kimi.com also serves the plain Moonshot API; only /coding is the plan.
    assert.equal(matchRelayVendor('https://api.kimi.com/coding')?.id, 'kimi-coding');
    assert.equal(matchRelayVendor('https://api.kimi.com/coding/')?.id, 'kimi-coding');
    // Case-insensitive host and path
    assert.equal(matchRelayVendor('https://API.KIMI.COM/CODING')?.id, 'kimi-coding');
    // The segment boundary matters: "/codingfoo" is not the plan.
    assert.equal(matchRelayVendor('https://api.kimi.com/codingfoo'), null);
    assert.equal(matchRelayVendor('https://api.kimi.com/anthropic'), null);
    assert.equal(matchRelayVendor('https://kimi.com/coding'), null);
  });

  it('matches MiniMax hosts on both TLDs', () => {
    assert.equal(matchRelayVendor('https://api.minimaxi.com/anthropic')?.id, 'minimax');
    assert.equal(matchRelayVendor('https://minimaxi.com')?.id, 'minimax');
    assert.equal(matchRelayVendor('https://api.minimax.io/anthropic')?.id, 'minimax');
    assert.equal(matchRelayVendor('https://minimax.io')?.id, 'minimax');
    // Look-alikes must not match
    assert.equal(matchRelayVendor('https://minimax.com'), null);
    assert.equal(matchRelayVendor('https://notminimaxi.com'), null);
    assert.equal(matchRelayVendor('https://minimaxi.com.evil.example'), null);
  });

  it('matches z.ai/bigmodel.cn and rejects unmatched or malformed URLs', () => {
    assert.equal(matchRelayVendor('https://api.z.ai/api/anthropic')?.id, 'zai');
    assert.equal(matchRelayVendor('https://open.bigmodel.cn/api/anthropic')?.id, 'zai');
    assert.equal(matchRelayVendor('https://api.anthropic.com'), null);
    assert.equal(matchRelayVendor('not a url'), null);
    assert.equal(matchRelayVendor(null), null);
    assert.equal(matchRelayVendor(undefined), null);
  });
});

describe('parseKimiCodingUsages', () => {
  it('derives windows from limits[] durations and the top-level weekly usage', () => {
    const payload = parseKimiCodingUsages({
      limits: [
        { window: { duration: 300, timeUnit: 'MINUTES' }, detail: { limit: 100, remaining: 40 } },
      ],
      usage: { limit: 1000, used: 250 },
    })!;

    assert.equal(payload.source, 'kimi-coding-usages');
    assert.equal(payload.windows.length, 2);
    assert.equal(payload.windows[0].id, '5h');
    assert.equal(payload.windows[0].used_pct, 60); // (100-40)/100
    assert.equal(payload.windows[1].id, '7d');
    assert.equal(payload.windows[1].used_pct, 25); // 250/1000
    // capacity_pct prefers the 5h window over the worst window
    assert.equal(payload.capacity_pct, 60);
    assert.equal(payload.period_type, '5h');
  });

  it('treats timeUnit as authoritative: 300 SECONDS is five minutes, not 5h (upstream 2117f71d)', () => {
    const payload = parseKimiCodingUsages({
      limits: [
        { window: { duration: 300, timeUnit: 'SECONDS' }, detail: { limit: 10, used: 5 } },
        { window: { duration: 168, timeUnit: 'HOURS' }, detail: { limit: 100, used: 20 } },
      ],
    })!;

    // The 300-second window is ignored, not misclassified as 5h.
    assert.equal(payload.windows.length, 1);
    assert.equal(payload.windows[0].id, '7d');
  });

  it('falls back to the numeric duration heuristic when timeUnit is absent', () => {
    const payload = parseKimiCodingUsages({
      limits: [
        { window: { duration: 18000 }, detail: { limit: 10, used: 1 } },
        { window: { duration: 604800 }, detail: { limit: 10, used: 2 } },
        { window: { duration: 999 }, detail: { limit: 10, used: 9 } },
      ],
    })!;

    assert.deepEqual(payload.windows.map((w: Record<string, unknown>) => w.id), ['5h', '7d']);
  });

  it('sniffs resetTime units and ignores entries without usable numbers', () => {
    const payload = parseKimiCodingUsages({
      limits: [
        // resetTime in SECONDS must not render as 1970 (upstream 2117f71d)
        { window: { duration: 300, timeUnit: 'MINUTES' }, detail: { limit: 100, used: 10, resetTime: 1786624965 } },
        { window: { duration: 300, timeUnit: 'MINUTES' }, detail: { limit: 0, used: 10 } },
        { window: { duration: 300, timeUnit: 'MINUTES' }, detail: { used: 10 } },
      ],
    })!;

    assert.equal(payload.windows.length, 1);
    assert.equal(payload.windows[0].reset_at, new Date(1786624965 * 1000).toISOString());
  });

  it('merges a weekly limits[] entry with the top-level usage keeping the worse usage', () => {
    const payload = parseKimiCodingUsages({
      limits: [
        { window: { duration: 7, timeUnit: 'DAYS' }, detail: { limit: 100, used: 80 } },
      ],
      usage: { limit: 100, used: 20 },
    })!;

    assert.equal(payload.windows.length, 1);
    assert.equal(payload.windows[0].id, '7d');
    assert.equal(payload.windows[0].used_pct, 80);
  });

  it('returns null when nothing usable is reported', () => {
    assert.equal(parseKimiCodingUsages(null), null);
    assert.equal(parseKimiCodingUsages({}), null);
    assert.equal(parseKimiCodingUsages({ limits: [{ window: { duration: 60, timeUnit: 'SECONDS' }, detail: { limit: 1, used: 1 } }] }), null);
  });
});

describe('parseMinimaxRemains', () => {
  const remainsBody = (entry: Record<string, unknown>, statusCode = 0) => ({
    base_resp: { status_code: statusCode },
    model_remains: [entry],
  });

  it('inverts remaining percentages and gates the weekly window on weekly_status', () => {
    const payload = parseMinimaxRemains(remainsBody({
      model_name: 'general',
      current_interval_remaining_percent: 25,
      current_weekly_status: 1,
      current_weekly_remaining_percent: 50,
      current_monthly_remaining_percent: 10,
      end_time: 1786624965, // seconds — unit sniffed via asEpochMs
    }), null)!;

    assert.equal(payload.source, 'minimax-coding-plan');
    assert.deepEqual(payload.windows.map((w: Record<string, unknown>) => [w.id, w.used_pct]), [
      ['5h', 75],
      ['7d', 50],
      ['monthly', 90],
    ]);
    // capacity_pct prefers the 5h window even though monthly is worse
    assert.equal(payload.capacity_pct, 75);
    assert.equal(payload.windows[0].reset_at, new Date(1786624965 * 1000).toISOString());

    // weekly_status != 1 → no weekly window
    const noWeekly = parseMinimaxRemains(remainsBody({
      model_name: 'general',
      current_interval_remaining_percent: 25,
      current_weekly_status: 0,
      current_weekly_remaining_percent: 50,
    }), null)!;
    assert.deepEqual(noWeekly.windows.map((w: Record<string, unknown>) => w.id), ['5h']);
  });

  it('picks an exact model match before a leading substring hit (MiniMax-M2 vs MiniMax-M2.5)', () => {
    const payload = parseMinimaxRemains({
      model_remains: [
        // A single-pass substring match would stop here ("minimaxm25" contains "minimaxm2").
        { model_name: 'MiniMax-M2.5', current_interval_remaining_percent: 10 },
        { model_name: 'MiniMax-M2', current_interval_remaining_percent: 70 },
      ],
    }, 'MiniMax-M2')!;

    assert.equal(payload.windows.length, 1);
    assert.equal(payload.windows[0].used_pct, 30);
  });

  it('tolerates cross-format model names via normalized substring matching', () => {
    const payload = parseMinimaxRemains({
      model_remains: [
        { model_name: 'MiniMax-M3', current_interval_remaining_percent: 60 },
      ],
    }, 'm3')!;
    assert.equal(payload.windows[0].used_pct, 40);
  });

  it('falls back to "general", then the first entry', () => {
    const general = parseMinimaxRemains({
      model_remains: [
        { model_name: 'MiniMax-M2', current_interval_remaining_percent: 10 },
        { model_name: 'general', current_interval_remaining_percent: 50 },
      ],
    }, 'Some-Unknown-Model')!;
    assert.equal(general.windows[0].used_pct, 50);

    const first = parseMinimaxRemains({
      model_remains: [
        { model_name: 'MiniMax-M2', current_interval_remaining_percent: 10 },
        { model_name: 'MiniMax-M2.5', current_interval_remaining_percent: 50 },
      ],
    }, 'Some-Unknown-Model')!;
    assert.equal(first.windows[0].used_pct, 90);
  });

  it('treats a non-zero base_resp status as no data', () => {
    assert.equal(parseMinimaxRemains(remainsBody({
      model_name: 'general',
      current_interval_remaining_percent: 25,
    }, 1002), null), null);
    assert.equal(parseMinimaxRemains({ model_remains: [] }, null), null);
    assert.equal(parseMinimaxRemains(null, null), null);
  });
});

describe('secureOrigin', () => {
  it('accepts https and loopback http, keeping custom ports', () => {
    assert.equal(secureOrigin('https://relay.example.com:8443/api'), 'https://relay.example.com:8443');
    assert.equal(secureOrigin('https://relay.example.com/api'), 'https://relay.example.com');
    assert.equal(secureOrigin('http://localhost:8080/x'), 'http://localhost:8080');
    assert.equal(secureOrigin('http://[::1]:9000/x'), 'http://[::1]:9000');
    assert.equal(secureOrigin('http://127.0.0.1:3000'), 'http://127.0.0.1:3000');
  });

  it('rejects plain HTTP to remote hosts and malformed URLs', () => {
    assert.equal(secureOrigin('http://relay.example.com'), null);
    assert.equal(secureOrigin('ws://relay.example.com'), null);
    assert.equal(secureOrigin('not a url'), null);
  });
});

describe('relay vendor resolve (kimi/minimax end-to-end)', () => {
  it('probes the kimi coding usages endpoint for an api.kimi.com/coding base', async () => {
    const seen: string[] = [];
    const service = makeService(async (url, token) => {
      seen.push(url, token);
      return {
        limits: [{ window: { duration: 300, timeUnit: 'MINUTES' }, detail: { limit: 100, used: 42 } }],
        usage: { limit: 100, used: 5 },
      };
    });

    const payload = await service.resolveViaRelayVendors(
      settingsWithBaseAndToken('https://api.kimi.com/coding', 'kimi-secret'), 1000);

    assert.equal(seen[0], 'https://api.kimi.com/coding/v1/usages');
    assert.equal(seen[1], 'kimi-secret');
    assert.equal(payload!.source, 'kimi-coding-usages');
    assert.equal(payload!.capacity_pct, 42);
  });

  it('probes the minimax remains endpoint, honoring ANTHROPIC_MODEL', async () => {
    const seen: string[] = [];
    const service = makeService(async (url) => {
      seen.push(url);
      return {
        base_resp: { status_code: 0 },
        model_remains: [
          { model_name: 'MiniMax-M2', current_interval_remaining_percent: 40 },
        ],
      };
    });
    const settings = settingsWithBaseAndToken('https://api.minimaxi.com/anthropic', 'mm-secret');
    (settings.env as Record<string, string>).ANTHROPIC_MODEL = 'MiniMax-M2';

    const payload = await service.resolveViaRelayVendors(settings, 1000);

    assert.equal(seen[0], 'https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains');
    assert.equal(payload!.source, 'minimax-coding-plan');
    assert.equal(payload!.capacity_pct, 60);
  });

  it('keys MiniMax cache entries by model (model switch re-probes, switch back hits)', async () => {
    let calls = 0;
    const service = makeService(async () => {
      calls += 1;
      return {
        base_resp: { status_code: 0 },
        model_remains: [{ model_name: 'general', current_interval_remaining_percent: 50 }],
      };
    });
    const base = 'https://api.minimaxi.com/anthropic';
    const withModel = (model: string) => {
      const s = settingsWithBaseAndToken(base, 't');
      (s.env as Record<string, string>).ANTHROPIC_MODEL = model;
      return s;
    };
    const t0 = 1_000_000;

    await service.resolveViaRelayVendors(withModel('MiniMax-M2'), t0);
    assert.equal(calls, 1);
    // Same account but a different active model → different quota selection, re-probe
    await service.resolveViaRelayVendors(withModel('MiniMax-M2.5'), t0 + 1);
    assert.equal(calls, 2);
    // Back to the first model within TTL → cache hit
    await service.resolveViaRelayVendors(withModel('MiniMax-M2'), t0 + 2);
    assert.equal(calls, 2);
  });

  it('canonicalizes base URLs for cache keys (default port and case folded)', async () => {
    let calls = 0;
    const service = makeService(async () => {
      calls += 1;
      return zaiBody(10);
    });
    const t0 = 1_000_000;

    await service.resolveViaRelayVendors(settingsWithBaseAndToken('https://API.Z.AI:443/api/anthropic', 't'), t0);
    assert.equal(calls, 1);
    // Same canonical origin (case/default-port differences only) → cache hit
    await service.resolveViaRelayVendors(settingsWithBaseAndToken('https://api.z.ai/other/path', 't'), t0 + 1);
    assert.equal(calls, 1);
  });

  it('bounds the cache to 16 entries and keeps actively read entries alive (LRU touch-on-hit)', async () => {
    let calls = 0;
    const service = makeService(async () => {
      calls += 1;
      return zaiBody(10);
    });
    const base = 'https://api.z.ai/api/anthropic';
    const t0 = 1_000_000;
    const account = (i: number) => settingsWithBaseAndToken(base, `tok-${i}`);

    // Fill the cache to capacity.
    for (let i = 1; i <= ClaudePlanUsageService.RELAY_CACHE_MAX_ENTRIES; i++) {
      await service.resolveViaRelayVendors(account(i), t0 + i);
    }
    assert.equal(calls, ClaudePlanUsageService.RELAY_CACHE_MAX_ENTRIES);

    // A fresh-cache read refreshes account 1's insertion order…
    await service.resolveViaRelayVendors(account(1), t0 + 100);
    assert.equal(calls, ClaudePlanUsageService.RELAY_CACHE_MAX_ENTRIES);

    // …so a 17th account evicts account 2 (LRU), not the just-read account 1.
    await service.resolveViaRelayVendors(account(17), t0 + 101);
    assert.equal(calls, 17);
    await service.resolveViaRelayVendors(account(1), t0 + 102);
    assert.equal(calls, 17); // survived: cache hit
    await service.resolveViaRelayVendors(account(2), t0 + 103);
    assert.equal(calls, 18); // evicted: re-probe
  });
});

describe('resolvePlanUsagePayload', () => {
  it('serves the cached rate_limit snapshot when no relay vendor matches', async () => {
    const service = makeService();
    service.cacheRateLimitInfo(info(0.42, nowSec() + 3 * 60 * 60, 'allowed'));

    const payload = await service.resolvePlanUsagePayload();
    assert.equal(payload.present, true);
    assert.equal(payload.capacity_pct, 42);
    assert.equal(payload.source, 'sdk-rate-limit');
  });

  it('answers unavailable before any rate_limit_event has arrived', async () => {
    const service = makeService();
    const payload = await service.resolvePlanUsagePayload();
    assert.equal(payload.present, false);
    assert.equal(payload.unavailable, true);
  });
});
