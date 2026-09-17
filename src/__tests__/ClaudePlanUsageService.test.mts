import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ClaudePlanUsageService,
  buildCapacityPayload,
  clampPct,
  isZaiBackend,
  monitorUrl,
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
});

describe('resolveViaZaiMonitor (transport injected)', () => {
  it('sends the Bearer token to the derived monitor URL', async () => {
    const seen: string[] = [];
    const service = makeService(async (url, token) => {
      seen.push(url, token);
      return zaiBody(42);
    });

    const payload = await service.resolveViaZaiMonitor(
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
    await service.resolveViaZaiMonitor(settings, 1000);

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

    await service.resolveViaZaiMonitor(settings, t0);
    assert.equal(calls, 1);
    // Within TTL → served from cache, no second probe
    await service.resolveViaZaiMonitor(settings, t0 + ClaudePlanUsageService.ZAI_CACHE_TTL_MS - 1);
    assert.equal(calls, 1);
    // TTL expired → probes again
    await service.resolveViaZaiMonitor(settings, t0 + ClaudePlanUsageService.ZAI_CACHE_TTL_MS + 1);
    assert.equal(calls, 2);
  });

  it('keys the cache by url + token (account switch re-probes)', async () => {
    let calls = 0;
    const service = makeService(async () => {
      calls += 1;
      return zaiBody(10);
    });
    const t0 = 1_000_000;

    await service.resolveViaZaiMonitor(settingsWithBaseAndToken('https://api.z.ai/api/anthropic', 'account-a'), t0);
    assert.equal(calls, 1);
    // Same URL but a different token (account switch) must not reuse the cache
    await service.resolveViaZaiMonitor(settingsWithBaseAndToken('https://api.z.ai/api/anthropic', 'account-b'), t0 + 1);
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

    await service.resolveViaZaiMonitor(settings, t0);

    fail = true;
    // Probe fails with an expired-but-recent cache → stale payload
    const stale = await service.resolveViaZaiMonitor(settings, t0 + ClaudePlanUsageService.ZAI_CACHE_TTL_MS + 1);
    assert.equal(stale!.capacity_pct, 33);
    assert.equal(stale!.stale, true);

    // Cache older than the stale cap → give up (null → caller falls back)
    assert.equal(await service.resolveViaZaiMonitor(settings, t0 + ClaudePlanUsageService.ZAI_STALE_MAX_MS + 1), null);
  });
});

describe('resolvePlanUsagePayload', () => {
  it('serves the cached rate_limit snapshot when no z.ai backend is configured', async () => {
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
