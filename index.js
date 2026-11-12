/**
 * dsh-magpie-usage: Magpie 额度与用量监控插件 (Host/Node side)
 * 代理并缓存本地 Magpie (127.0.0.1:3425) 配额接口，提供同源 API 供前端消费。
 * 
 * 性能与健壮性：
 * 1. 10s 内存 TTL 缓存 + 并发请求合并 (In-flight Promise de-duplication)。
 * 2. 失败智能指数退避 (Backoff)，避免 Magpie 网关离线时的高频空轮询。
 * 3. 严格超时控制 (AbortSignal.timeout 3000ms)，杜绝阻塞 Node 事件循环。
 */

export const name = 'dsh-magpie-usage';
export const inject = ['webServer'];

const MAGPIE_BASE = process.env.MAGPIE_BASE_URL || 'http://127.0.0.1:3425';
const CACHE_TTL_MS = 10_000;
const ROUTE_CACHE_TTL_MS = 5_000;
const ROUTE_CACHE_MAX_ENTRIES = 50;

let quotaCache = {
  timestamp: 0,
  payload: null,
};

let inflightQuotas = null;
let consecutiveFailures = 0;
let nextRetryAfter = 0;
let lastRouteCache = new Map();

async function getMagpieQuotas(force = false) {
  const now = Date.now();
  if (!force && quotaCache.payload && now - quotaCache.timestamp < CACHE_TTL_MS) {
    return quotaCache.payload;
  }

  // 离线退避保护：如果连续连接失败，在退避期内直接返回上次缓存或轻量错误，不频繁打断网络
  if (!force && now < nextRetryAfter && quotaCache.payload) {
    return quotaCache.payload;
  }

  // 并发请求合并：多个并发调用复用单笔 In-flight Promise
  if (inflightQuotas) {
    return inflightQuotas;
  }

  inflightQuotas = (async () => {
    try {
      const res = await fetch(`${MAGPIE_BASE}/v1/magpie/quotas`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) {
        throw new Error(`Magpie 响应码: ${res.status}`);
      }
      const json = await res.json();
      const payload = {
        ok: true,
        data: Array.isArray(json?.data) ? json.data : [],
        updatedAt: new Date().toISOString(),
        magpieBase: MAGPIE_BASE,
      };
      quotaCache = { timestamp: Date.now(), payload };
      consecutiveFailures = 0;
      nextRetryAfter = 0;
      return payload;
    } catch (error) {
      consecutiveFailures += 1;
      // 失败退避：5s, 10s, 最多 30s
      const delay = Math.min(30_000, 5_000 * Math.pow(1.5, consecutiveFailures - 1));
      nextRetryAfter = Date.now() + delay;

      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        error: `连接 Magpie 失败 (${MAGPIE_BASE}): ${message}`,
        data: quotaCache.payload?.data ?? [],
        updatedAt: quotaCache.payload?.updatedAt ?? null,
        magpieBase: MAGPIE_BASE,
      };
    } finally {
      inflightQuotas = null;
    }
  })();

  return inflightQuotas;
}

/**
 * 查询某个 DSH 模型/分组最近一次实际路由到的 Provider。
 * Magpie 的自动分组是动态路由，DSH DOM 里只有分组 ID，只有请求日志知道真实 Provider。
 */
async function getLastRoute(reqModel) {
  const key = String(reqModel || '');
  const now = Date.now();
  const cached = lastRouteCache.get(key);
  if (cached && now - cached.timestamp < ROUTE_CACHE_TTL_MS) {
    return cached.payload;
  }

  try {
    const url = new URL(`${MAGPIE_BASE}/v1/magpie/usage/requests`);
    url.searchParams.set('agent', 'dsh');
    url.searchParams.set('limit', '100');
    const res = await fetch(url, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      throw new Error(`Magpie 请求日志响应码: ${res.status}`);
    }
    const json = await res.json();
    const rows = Array.isArray(json?.rows) ? json.rows : [];
    const dshRows = rows.filter((row) => !row?.agent || row.agent === 'dsh');
    const match = key
      ? dshRows.find((row) => String(row?.req || '') === key)
      : dshRows[0];

    const payload = {
      ok: true,
      req: key || null,
      provider: match?.provider ?? null,
      providerName: match?.providerName ?? null,
      model: match?.model ?? null,
      served: match?.served ?? null,
      at: match?.t ?? null,
      updatedAt: new Date().toISOString(),
    };

    if (lastRouteCache.size > ROUTE_CACHE_MAX_ENTRIES) {
      lastRouteCache.clear();
    }
    lastRouteCache.set(key, { timestamp: Date.now(), payload });
    return payload;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const payload = {
      ok: false,
      req: key || null,
      provider: null,
      providerName: null,
      model: null,
      served: null,
      at: null,
      error: `查询 Magpie 最近路由失败 (${MAGPIE_BASE}): ${message}`,
      updatedAt: new Date().toISOString(),
    };
    lastRouteCache.set(key, { timestamp: Date.now(), payload });
    return payload;
  }
}

function sendJson(res, statusCode, data) {
  try {
    const body = JSON.stringify(data);
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(500);
      res.end('{"error":"internal_error"}');
    }
  }
}

export function apply(ctx) {
  const server = ctx.get('webServer');
  if (!server || typeof server.register !== 'function') {
    return;
  }

  const disposers = [];

  // 1. Quota 列表接口
  try {
    const disposeQuotas = server.register({
      kind: 'exact',
      path: '/api/magpie-quota/quotas',
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          return sendJson(res, 405, { error: 'Method Not Allowed' });
        }
        const url = new URL(req.url ?? '/', 'http://localhost');
        const force = url.searchParams.get('force') === '1' || url.searchParams.get('refresh') === '1';
        const result = await getMagpieQuotas(force);
        sendJson(res, 200, result);
      },
    });
    if (typeof disposeQuotas === 'function') disposers.push(disposeQuotas);
  } catch (err) {
    console.error('[dsh-magpie-quota] 注册 /api/magpie-quota/quotas 失败:', err);
  }

  // 2. 最近路由接口：把分组 ID 映射到 Magpie 实际路由的 Provider
  try {
    const disposeLastRoute = server.register({
      kind: 'exact',
      path: '/api/magpie-quota/last-route',
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          return sendJson(res, 405, { error: 'Method Not Allowed' });
        }
        const url = new URL(req.url ?? '/', 'http://localhost');
        const routeReq = url.searchParams.get('req') || '';
        const result = await getLastRoute(routeReq);
        sendJson(res, 200, result);
      },
    });
    if (typeof disposeLastRoute === 'function') disposers.push(disposeLastRoute);
  } catch (err) {
    console.error('[dsh-magpie-quota] 注册 /api/magpie-quota/last-route 失败:', err);
  }

  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {}
    }
  };
}
