/**
 * dsh-magpie-quota: 前端组件 (Client side)
 * 极致轻量设计：完美融入输入框底部状态栏 (conversation.composer.dock)，与上下文占用比例并列。
 * 
 * 深度性能优化版：
 * 1. 单例会话模型探测器 (Singleton Model Tracker)：
 *    - 消除每实例一个 observer/interval 的重复开销。
 *    - 防抖检测 (150ms Debounce)，生成流（Token Streaming）期间静默无感，只有模型发生实质改变才触发 re-render。
 * 2. 全局视角联动 (Global Sync)：切换「已用/剩余」在全会话共享并持久化到 localStorage。
 * 3. 0ms 秒开快照 (Instant Hydration)：开屏直接展示本地缓存，无空白等待与布局跳动。
 * 4. 可见性感知 (Visibility Aware)：页面失焦/后台时暂停所有定时器。
 * 5. 渲染优化：硬件合成层与 GPU 弧线动画 (will-change: stroke-dasharray, transform: translateZ(0))。
 */

window.__ModuleLoader__.load({
  id: 'dsh-magpie-usage',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const PINNED_STORAGE_KEY = 'dsh-magpie-pinned-provider';
    const CACHE_STORAGE_KEY = 'dsh-magpie-quota-cache-v1';
    const MASK_STORAGE_KEY = 'dsh-magpie-mask-enabled';
    const VIEW_MODE_STORAGE_KEY = 'dsh-magpie-view-mode';

    // 圆环几何参数（与原生 ContextMeter 严格一致）
    const RADIUS = 5.5;
    const CIRCUMFERENCE = 2 * Math.PI * RADIUS; // ~34.5575

    // ----------------------------------------------------
    // 主题色彩 Tokens (优先继承 DSH 原生 --dsw-* 变量，暗色/Midnight兜底)
    // ----------------------------------------------------
    const THEME = {
      surface: 'rgba(24, 24, 27, 0.94)',
      cardBg: 'rgba(255, 255, 255, 0.04)',
      cardBgSubtle: 'rgba(255, 255, 255, 0.025)',
      cardHover: 'rgba(255, 255, 255, 0.08)',
      border: 'rgba(255, 255, 255, 0.1)',
      borderSubtle: 'rgba(255, 255, 255, 0.06)',
      textPrimary: 'var(--dsw-alias-label-primary, #f4f4f5)',
      textSecondary: 'var(--dsw-alias-label-secondary, #a1a1aa)',
      textTertiary: 'var(--dsw-alias-label-tertiary, #71717a)',
      trackBg: 'rgba(255, 255, 255, 0.08)',
      brand: '#6366f1',
      brandText: '#c7d2fe',
      shadow: '0 24px 48px rgba(0, 0, 0, 0.65), 0 0 0 1px rgba(255, 255, 255, 0.06)',
    };

    // ----------------------------------------------------
    // 工具函数
    // ----------------------------------------------------
    function maskEmail(email, enabled) {
      if (!enabled || !email || typeof email !== 'string') return email;
      const atIdx = email.indexOf('@');
      if (atIdx <= 1) return email;
      const name = email.slice(0, atIdx);
      const domain = email.slice(atIdx);
      if (name.length <= 2) return `${name[0]}***${domain}`;
      return `${name[0]}***${name[name.length - 1]}${domain}`;
    }

    function formatRelative(targetIso) {
      if (!targetIso) return '';
      try {
        const target = new Date(targetIso).getTime();
        const now = Date.now();
        const diffMs = target - now;
        if (diffMs <= 0) return '已重置';
        const diffMins = Math.floor(diffMs / 60000);
        if (diffMins < 60) return `${diffMins} 分钟后`;
        const diffHours = Math.floor(diffMins / 60);
        if (diffHours < 48) return `${diffHours} 小时后`;
        const diffDays = Math.floor(diffHours / 24);
        return `${diffDays} 天后`;
      } catch {
        return '';
      }
    }

    function formatTime(iso) {
      if (!iso) return '';
      try {
        const d = new Date(iso);
        const m = d.getMonth() + 1;
        const date = d.getDate();
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        return `${m}月${date}日 ${hh}:${mm}`;
      } catch {
        return iso;
      }
    }

    function getBrandColor(provider) {
      const p = String(provider || '').toLowerCase();
      if (p.includes('codex')) return '#10a37f';
      if (p.includes('kiro')) return '#a855f7';
      if (p.includes('workbuddy')) return '#14b8a6';
      if (p.includes('antigravity') || p.includes('gemini') || p.includes('google')) return '#3b82f6';
      if (p.includes('zcode') || p.includes('glm')) return '#6366f1';
      if (p.includes('command')) return '#f97316';
      return '#818cf8';
    }

    // 额度窗口/套餐的中文展示名；服务商与渠道名保持原样。
    const WINDOW_NAME_ZH = {
      credits: '积分',
      'extra credits': '额外积分',
      'total credits': '积分合计',
      'free model tokens': '免费模型额度',
      'add-on credits': '加购积分',
      'dollar usage': '美元用量',
    };
    const PLAN_NAME_ZH = {
      'free plan': '免费版',
      'personal_standard': '个人标准版',
      'personal_pro': '个人专业版',
      team: '团队版',
      enterprise: '企业版',
      credits: '积分套餐',
      subscription: '订阅',
    };
    const UNIT_NAME_ZH = { credits: '积分', usd: '美元', tokens: '词元' };
    const COMPACT_NUMBER_ZH = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 });
    const PLAIN_NUMBER_ZH = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 });
    const PLAIN_NUMBER_ZH_2 = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });

    function displayWindowName(name) {
      const raw = String(name || '').trim();
      const key = raw.toLowerCase();
      if (WINDOW_NAME_ZH[key]) return WINDOW_NAME_ZH[key];
      const m = /^(\d+)\s*[- ]?\s*(hour|day|week|month)s?$/i.exec(raw);
      if (m) {
        const unit = { hour: '小时', day: '天', week: '周', month: '个月' }[m[2].toLowerCase()];
        return `${m[1]} ${unit}`;
      }
      return raw;
    }

    function displayPlanName(plan) {
      const raw = String(plan || '').trim();
      return PLAN_NAME_ZH[raw.toLowerCase()] || raw;
    }

    function formatQuotaNumber(value) {
      if (!Number.isFinite(value)) return '--';
      if (value >= 10000) return COMPACT_NUMBER_ZH.format(value);
      return (value < 100 ? PLAIN_NUMBER_ZH_2 : PLAIN_NUMBER_ZH).format(value);
    }

    // amount 是已用额度，limit 是总额度；上游未给 amount 时按百分比反推。
    function windowAmounts(w) {
      const limit = Number.isFinite(w?.limit) && w.limit > 0 ? w.limit : null;
      let usedAmount = Number.isFinite(w?.amount) ? w.amount : null;
      if (usedAmount == null && limit != null && Number.isFinite(w?.used)) {
        usedAmount = (w.used * limit) / 100;
      }
      const remainingAmount = limit != null && usedAmount != null
        ? Math.max(0, limit - usedAmount)
        : null;
      return { limit, usedAmount, remainingAmount, unit: w?.unit };
    }

    function unitName(unit) {
      return UNIT_NAME_ZH[unit] || '';
    }

    // 状态栏空间有限：积分省略单位，美元/词元保留单位。
    function dockRemainingText(w) {
      const { remainingAmount, unit } = windowAmounts(w);
      if (remainingAmount == null) return '';
      const suffix = unit && unit !== 'credits' ? ` ${unitName(unit)}` : '';
      return `剩余 ${formatQuotaNumber(remainingAmount)}${suffix}`;
    }

    function remainingAmountText(w) {
      const { remainingAmount, unit } = windowAmounts(w);
      if (remainingAmount == null) return '';
      const suffix = unit ? ` ${unitName(unit)}` : '';
      return `剩余 ${formatQuotaNumber(remainingAmount)}${suffix}`;
    }

    function remainingOfTotalText(w) {
      const { remainingAmount, limit, unit } = windowAmounts(w);
      if (remainingAmount == null || limit == null) return '';
      const suffix = unit ? ` ${unitName(unit)}` : '';
      return `剩余 ${formatQuotaNumber(remainingAmount)} / ${formatQuotaNumber(limit)}${suffix}`;
    }

    function isQuotaWindow(w) {
      if (!w || typeof w !== 'object') return false;
      if (typeof w.display === 'string' && /^https?:\/\//i.test(w.display.trim())) return false;
      const name = String(w.name || '').trim();
      if (['代理出口', '管理页', '代理', '管理', '出口'].includes(name)) return false;
      return true;
    }

    function isInfoItem(w) {
      if (!w || typeof w !== 'object') return false;
      if (typeof w.display === 'string' && /^https?:\/\//i.test(w.display.trim())) return true;
      const name = String(w.name || '').trim();
      return ['代理出口', '管理页', '代理', '管理', '出口'].includes(name);
    }

    // ----------------------------------------------------
    // 额度窗口的展示语义（含「上游无额度上报」时的合成窗口）
    // ----------------------------------------------------
    function windowStats(w, viewMode, brandColor) {
      if (w?.synthetic) {
        const avail = Math.round((Number.isFinite(w?.remaining) ? w.remaining : 100) * 10) / 10;
        return {
          cooling: false,
          synthetic: true,
          pct: avail,
          used: Math.round((100 - avail) * 10) / 10,
          rem: avail,
          color: avail < 15 ? '#f87171' : avail < 35 ? '#fbbf24' : '#34d399',
          label: avail >= 99.9 ? '全部可用' : `可用 ${avail}%`,
        };
      }
      // holdsWhy 只表示「窗口总量无法估算的原因」（low/clock/log/none/credits），
      // 与账号是否冷却无关，不能据此渲染冷却态。
      const cooling = w?.display === '冷却中';
      const used = Math.round((Number.isFinite(w?.used) ? w.used : 0) * 10) / 10;
      const rem = Math.round((Number.isFinite(w?.remaining) ? w.remaining : 100 - used) * 10) / 10;
      if (cooling) {
        return {
          cooling: true,
          synthetic: false,
          pct: viewMode === 'used' ? 100 : 0,
          used,
          rem,
          color: '#f87171',
          label: viewMode === 'used' ? '冷却中 · 已用 100%' : '冷却中 · 剩余 0%',
        };
      }
      const pct = viewMode === 'used' ? used : rem;
      const color = viewMode === 'used'
        ? (used > 85 ? '#f87171' : used > 65 ? '#fbbf24' : brandColor)
        : (rem < 15 ? '#f87171' : rem < 35 ? '#fbbf24' : '#34d399');
      return {
        cooling: false,
        synthetic: false,
        pct,
        used,
        rem,
        color,
        label: viewMode === 'used' ? `已用 ${used}%` : `剩余 ${rem}%`,
      };
    }

    // availabilityWindowsFor 合成一条「可用」窗口：Google AI Studio 只在账号被 429 冷却时
    // 才给出额度窗口，正常账号的 windows 里只有服务信息。没有它，卡片中部空白、状态栏误报 0%。
    function availabilityWindowsFor(providerAccounts, item) {
      const list = Array.isArray(providerAccounts) && providerAccounts.length > 0
        ? providerAccounts
        : [item].filter(Boolean);
      const total = list.length || 1;
      const cooling = list.filter((a) => (a.windows || []).some((w) => w.display === '冷却中')).length;
      const usable = Math.max(0, total - cooling);
      const usedPct = Math.round((cooling / total) * 1000) / 10;
      return [{
        name: '账号可用',
        used: usedPct,
        remaining: Math.round((100 - usedPct) * 10) / 10,
        resetsAt: null,
        display: cooling > 0 ? `${usable}/${total} 个账号可用，${cooling} 个冷却中` : `${total}/${total} 个账号可用 · 无冷却`,
        synthetic: true,
      }];
    }

    // ----------------------------------------------------
    // 多账号配额合并算法 (同一 Provider 下多账号配额进度聚合)
    // ----------------------------------------------------
    function mergeProviderWindows(accounts) {
      if (!Array.isArray(accounts) || accounts.length === 0) return [];

      const total = accounts.length;
      // 能参与服务的账号（没有 error 的）：分母用它，才不会把上游没上报的账号算成「已用」。
      const serving = accounts.filter((a) => !a.error).length || total;
      const windowMap = new Map();
      accounts.forEach((acc) => {
        (acc.windows || []).filter(isQuotaWindow).forEach((w) => {
          const key = String(w.name || '').trim();
          if (!windowMap.has(key)) {
            windowMap.set(key, []);
          }
          windowMap.get(key).push(w);
        });
      });

      const merged = [];
      for (const [name, list] of windowMap) {
        if (list.length === 0) continue;

        const allCooling = list.every((w) => w.display === '冷却中');
        // 冷却型窗口（如 Google AI Studio 的 429 冷却）只出现在出问题的账号上，其余账号的
        // windows 里根本没有这一项。分母必须取该 Provider 的全部账号，否则 1/N 个账号冷却
        // 会被算成整池 100% 冷却。
        const coolingOnly = allCooling && list.length < serving;

        let usedPct = 0;
        let remainPct = 0;
        let totalLimit = null;
        let totalAmount = null;
        let mergedUnit;

        if (coolingOnly) {
          usedPct = (list.length / serving) * 100;
          remainPct = 100 - usedPct;
        } else {
          const hasLimits = list.every((w) => Number.isFinite(w.limit) && w.limit > 0);
          if (hasLimits) {
            totalLimit = list.reduce((sum, w) => sum + w.limit, 0);
            totalAmount = list.reduce((sum, w) => {
              if (Number.isFinite(w.amount)) return sum + w.amount;
              if (Number.isFinite(w.used)) return sum + (w.used * w.limit) / 100;
              return sum;
            }, 0);
            usedPct = totalLimit > 0 ? (totalAmount / totalLimit) * 100 : 0;
            remainPct = 100 - usedPct;
            const units = [...new Set(list.map((w) => w.unit).filter(Boolean))];
            mergedUnit = units.length === 1 ? units[0] : undefined;
          } else {
            const validUsed = list.filter((w) => Number.isFinite(w.used));
            usedPct = validUsed.length > 0 ? validUsed.reduce((sum, w) => sum + w.used, 0) / validUsed.length : 0;
            const validRemain = list.filter((w) => Number.isFinite(w.remaining));
            remainPct = validRemain.length > 0 ? validRemain.reduce((sum, w) => sum + w.remaining, 0) / validRemain.length : 100 - usedPct;
          }
        }

        const validResets = list
          .map((w) => w.resetsAt)
          .filter((iso) => Boolean(iso) && !isNaN(new Date(iso).getTime()))
          .sort((a, b) => new Date(a).getTime() - new Date(b).getTime());

        const fullyCooling = allCooling && list.length >= serving;

        merged.push({
          name,
          used: usedPct,
          remaining: remainPct,
          resetsAt: validResets[0] || null,
          display: fullyCooling ? '冷却中' : undefined,
          limit: totalLimit,
          amount: totalAmount,
          unit: mergedUnit,
          accountCount: list.length,
        });
      }

      // 上游完全不提供百分比额度时（AI Studio 正常状态下只有「代理出口」「管理页」），
      // 用可用账号数合成一条可用度窗口，避免状态栏空白或误报 0%。
      if (merged.length === 0) {
        const reported = accounts.filter((a) => Array.isArray(a.windows) && a.windows.length > 0);
        if (reported.length > 0) {
          merged.push({
            name: '账号可用',
            used: 0,
            remaining: 100,
            resetsAt: null,
            display: `${total}/${total} 个账号可用 · 无冷却`,
            accountCount: total,
            synthetic: true,
          });
        }
      }

      return merged;
    }

    // 状态栏优先展示汇总窗口，避免 Base/Extra 这类子额度先耗尽时把总额度盖掉。
    function isTotalWindow(w) {
      const name = String(w?.name || '');
      return /(^|\s)(total|overall|combined)(\s|$)|总计|合计|总积分|总额/i.test(name);
    }

    function pickPrimaryWindow(windows) {
      if (!Array.isArray(windows) || windows.length === 0) return null;
      return windows.find(isTotalWindow) ||
        [...windows].sort((a, b) => (b.used || 0) - (a.used || 0))[0];
    }

    // ----------------------------------------------------
    // 单例会话模型嗅探 (带快速缓存与防抖过滤)
    // ----------------------------------------------------
    function readActiveModelContext() {
      if (typeof document === 'undefined') return { modelId: '', labelText: '' };

      let modelId = '';
      let labelText = '';
      const modelSpan = document.querySelector('[data-model-id]');
      if (modelSpan) {
        modelId = modelSpan.getAttribute('data-model-id') || '';
      }

      const triggerBtn = document.querySelector('button[aria-haspopup="menu"][title*="·"]') ||
                         document.querySelector('button[data-selection-focus]') ||
                         document.querySelector('[class*="trigger"][title*="·"]');
      if (triggerBtn) {
        labelText = (triggerBtn.getAttribute('title') || '') + ' ' + (triggerBtn.textContent || '');
      }

      return { modelId, labelText };
    }

    function detectActiveSessionProvider(data, context) {
      if (!Array.isArray(data) || data.length === 0) return null;

      const { modelId = '', labelText = '' } = context || readActiveModelContext();
      const m = modelId.toLowerCase();
      const t = labelText.toLowerCase();

      // group/auto-* 是 Magpie 的动态路由分组，不能当作 Provider；交给请求日志解析。
      if (m.startsWith('group/')) return null;

      // A. 按 modelId 前缀精准匹配（如 "kiro/claude-opus-5.5" -> "kiro"）
      const prefix = m.split('/')[0];
      if (prefix) {
        const byPrefix = data.find((d) => d.provider?.toLowerCase() === prefix);
        if (byPrefix) return byPrefix;
      }

      // B. 全文匹配 Provider ID 或名称（如 "Kiro", "Codex", "WorkBuddy"）
      for (const item of data) {
        const p = String(item.provider || '').toLowerCase().replace('-ai', '').replace('-plan', '');
        const n = String(item.name || '').toLowerCase();
        if ((p && p.length > 2 && (m.includes(p) || t.includes(p))) ||
            (n && n.length > 2 && (m.includes(n) || t.includes(n)))) {
          return item;
        }
      }

      // C. 常见族谱回退匹配
      if (m.includes('claude') || t.includes('claude')) {
        const found = data.find((d) => d.provider?.toLowerCase() === 'kiro');
        if (found) return found;
      }
      if (m.includes('gemini') || t.includes('gemini')) {
        const found = data.find((d) => d.provider?.toLowerCase() === 'antigravity') ||
                      data.find((d) => d.provider?.toLowerCase() === 'ai-studio');
        if (found) return found;
      }
      if (m.includes('gpt') || t.includes('gpt')) {
        const found = data.find((d) => d.provider?.toLowerCase() === 'codex');
        if (found) return found;
      }
      if (m.includes('glm') || t.includes('glm')) {
        const found = data.find((d) => d.provider?.toLowerCase() === 'zcode');
        if (found) return found;
      }

      return null;
    }

    // 手动选择的直连模型可能带 provider 前缀；自动分组只能靠 Magpie 的请求日志映射。
    function findProviderByRoute(data, route) {
      if (!Array.isArray(data) || !route) return null;
      const provider = String(route.provider || '').toLowerCase();
      const name = String(route.providerName || '').toLowerCase();

      if (provider) {
        const exact = data.find((d) => String(d.provider || '').toLowerCase() === provider);
        if (exact) return exact;
      }
      if (name) {
        const byName = data.find((d) => String(d.name || '').toLowerCase() === name);
        if (byName) return byName;
      }
      if (provider) {
        const byPrefix = data.find((d) => {
          const id = String(d.provider || '').toLowerCase();
          return id && (id.startsWith(provider) || provider.startsWith(id));
        });
        if (byPrefix) return byPrefix;
      }
      return null;
    }

    // ----------------------------------------------------
    // 数据共享中心 (全单例调度，避免重复开销)
    // ----------------------------------------------------
    const initialCache = (() => {
      try {
        const raw = localStorage.getItem(CACHE_STORAGE_KEY);
        if (raw) return JSON.parse(raw);
      } catch {}
      return null;
    })();

    let sharedState = {
      loading: false,
      data: Array.isArray(initialCache?.data) ? initialCache.data : [],
      error: null,
      updatedAt: initialCache?.updatedAt || null,
      viewMode: (() => {
        try { return localStorage.getItem(VIEW_MODE_STORAGE_KEY) || 'used'; } catch { return 'used'; }
      })(),
      pinnedProvider: (() => {
        try { return localStorage.getItem(PINNED_STORAGE_KEY) || ''; } catch { return ''; }
      })(),
      activeSessionProviderId: null,
      activeSessionSource: null,
      listeners: new Set(),
    };

    function notify() {
      for (const listener of sharedState.listeners) {
        try { listener(sharedState); } catch {}
      }
    }

    function setGlobalViewMode(nextMode) {
      if (sharedState.viewMode === nextMode) return;
      sharedState.viewMode = nextMode;
      try {
        localStorage.setItem(VIEW_MODE_STORAGE_KEY, nextMode);
      } catch {}
      notify();
    }

    function setGlobalPinnedProvider(providerId) {
      const next = sharedState.pinnedProvider === providerId ? '' : providerId;
      sharedState.pinnedProvider = next;
      try {
        if (next) localStorage.setItem(PINNED_STORAGE_KEY, next);
        else localStorage.removeItem(PINNED_STORAGE_KEY);
      } catch {}
      notify();
    }

    // ----------------------------------------------------
    // 全局单例模型追踪器 (带 150ms 防抖，Token 生成流期间 0% 开销)
    // ----------------------------------------------------
    const ROUTE_REFRESH_MS = 10_000;
    let debounceTimer = null;
    let lastRouteReq = '';
    let lastRouteAt = 0;
    let lastRouteResult = null;
    let routeAbortController = null;
    let routeSeq = 0;

    function updateActiveSession(providerId, source) {
      const nextId = providerId || null;
      const nextSource = nextId ? source : null;
      if (nextId === sharedState.activeSessionProviderId && nextSource === sharedState.activeSessionSource) return;
      sharedState.activeSessionProviderId = nextId;
      sharedState.activeSessionSource = nextSource;
      notify();
    }

    // 自动分组没有稳定的 Provider，只能查 Magpie 最近一次实际路由。
    async function resolveRouteProvider(modelId, force = false) {
      const req = String(modelId || '').trim();
      if (!req) return;

      const now = Date.now();
      if (!force && req === lastRouteReq && now - lastRouteAt < ROUTE_REFRESH_MS) return;

      lastRouteReq = req;
      lastRouteAt = now;

      if (routeAbortController) routeAbortController.abort();
      const controller = new AbortController();
      routeAbortController = controller;
      const seq = ++routeSeq;

      try {
        const res = await fetch(`/api/magpie-quota/last-route?req=${encodeURIComponent(req)}`, {
          signal: controller.signal,
        });
        const json = await res.json();
        if (seq !== routeSeq) return;
        lastRouteResult = json?.ok ? json : null;

        const currentModel = readActiveModelContext().modelId;
        if (currentModel !== req) return;

        const item = json?.ok ? findProviderByRoute(sharedState.data, json) : null;
        updateActiveSession(item ? (item.provider || item.name) : null, 'route');
      } catch (err) {
        if (err?.name !== 'AbortError') {
          // 路由查询只是尽力而为，失败时保留上一次已解析的 Provider。
        }
      } finally {
        if (seq === routeSeq) routeAbortController = null;
      }
    }

    function checkActiveSessionModelNow() {
      if (typeof document === 'undefined' || document.hidden) return;

      const context = readActiveModelContext();
      const detected = detectActiveSessionProvider(sharedState.data, context);
      if (detected) {
        updateActiveSession(detected.provider || detected.name, 'model');
        return;
      }

      const cachedItem = context.modelId && lastRouteResult?.req === context.modelId
        ? findProviderByRoute(sharedState.data, lastRouteResult)
        : null;
      updateActiveSession(cachedItem ? (cachedItem.provider || cachedItem.name) : null, 'route');

      // 展示同一模型的缓存，同时让查询函数检查 TTL，避免一次命中后永不刷新。
      // 模型切换或会话为空时，先清除不属于当前模型的 Provider。
      if (context.modelId) {
        resolveRouteProvider(context.modelId, false);
      }
    }

    function scheduleModelCheck() {
      if (debounceTimer) return;
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        checkActiveSessionModelNow();
      }, 150);
    }

    let globalWatcherInstalled = false;
    function ensureGlobalModelWatcher() {
      if (globalWatcherInstalled || typeof window === 'undefined') return;
      globalWatcherInstalled = true;

      // 仅监听关键属性，防抖 150ms 触发
      const observer = typeof MutationObserver !== 'undefined' ? new MutationObserver((mutations) => {
        for (const m of mutations) {
          // 如果只是聊天消息滚动或普通流式文本追加，不触发检查
          if (m.type === 'childList' && m.target?.id?.includes?.('message')) continue;
          scheduleModelCheck();
          break;
        }
      }) : null;

      if (observer && typeof document !== 'undefined') {
        observer.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['data-model-id', 'title'],
        });
      }

      // 1秒轻量保护心跳，只有模型发生实质变动才 re-render
      setInterval(checkActiveSessionModelNow, 1000);
    }

    let activeAbortController = null;

    async function refreshQuotaData(force = false) {
      if (sharedState.loading && !force) return;

      if (activeAbortController) {
        activeAbortController.abort();
      }
      activeAbortController = new AbortController();

      sharedState.loading = true;
      notify();
      try {
        const url = force ? '/api/magpie-quota/quotas?force=1' : '/api/magpie-quota/quotas';
        const res = await fetch(url, { signal: activeAbortController.signal });
        const json = await res.json();
        if (json.ok) {
          sharedState.data = Array.isArray(json.data) ? json.data : [];
          sharedState.error = null;
          sharedState.updatedAt = json.updatedAt;
          try {
            localStorage.setItem(CACHE_STORAGE_KEY, JSON.stringify({
              data: sharedState.data,
              updatedAt: sharedState.updatedAt,
            }));
          } catch {}
          checkActiveSessionModelNow();
        } else {
          sharedState.error = json.error || '获取失败';
          if (json.data) sharedState.data = json.data;
        }
      } catch (err) {
        if (err.name !== 'AbortError') {
          sharedState.error = err instanceof Error ? err.message : String(err);
        }
      } finally {
        sharedState.loading = false;
        notify();
      }
    }

    // 智能前台感知轮询机制 (30 秒一次，页面挂起时暂停)
    let autoPollTimer = null;
    function ensureAutoPoll() {
      if (autoPollTimer || typeof window === 'undefined') return;
      autoPollTimer = setInterval(() => {
        if (typeof document !== 'undefined' && document.hidden) return;
        refreshQuotaData(false);
      }, 30_000);

      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
          refreshQuotaData(false);
          checkActiveSessionModelNow();
        }
      });
    }

    function useMagpieQuotas() {
      const [state, setState] = React.useState(sharedState);

      React.useEffect(() => {
        const handler = (next) => setState({ ...next });
        sharedState.listeners.add(handler);
        ensureAutoPoll();
        ensureGlobalModelWatcher();

        if (!sharedState.updatedAt && !sharedState.loading) {
          refreshQuotaData(false);
        } else {
          scheduleModelCheck();
        }

        return () => {
          sharedState.listeners.delete(handler);
        };
      }, []);

      return {
        ...state,
        setViewMode: setGlobalViewMode,
        setPinned: setGlobalPinnedProvider,
        refresh: (force = true) => refreshQuotaData(force),
      };
    }

    // ----------------------------------------------------
    // SVG 图标
    // ----------------------------------------------------
    function MagpieIcon({ size = 16, style = {} }) {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: '1.8',
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        style,
        'aria-hidden': 'true',
      },
        h('path', { d: 'M21.21 15.89A10 10 0 1 1 8 2.83' }),
        h('path', { d: 'M22 12A10 10 0 0 0 12 2v10z' })
      );
    }

    function PinIcon({ size = 12, filled = false, style = {} }) {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: filled ? 'currentColor' : 'none',
        stroke: 'currentColor',
        strokeWidth: '2',
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        style,
        'aria-hidden': 'true',
      },
        h('line', { x1: '12', y1: '17', x2: '12', y2: '22' }),
        h('path', { d: 'M5 17h14v-2l-2-2V5a1 1 0 0 0-1-1h-8a1 1 0 0 0-1 1v8l-2 2v2z' })
      );
    }

    function BoltIcon({ size = 12, style = {} }) {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'currentColor',
        stroke: 'none',
        style,
      },
        h('polygon', { points: '13 2 3 14 12 14 11 22 21 10 12 10 13 2' })
      );
    }

    function RefreshIcon({ size = 13, spinning = false }) {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: '2',
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        style: {
          transition: 'transform 0.5s ease',
          animation: spinning ? 'dsh-spin 1s linear infinite' : 'none',
        },
      },
        h('path', { d: 'M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.19' })
      );
    }

    // ----------------------------------------------------
    // 底部状态栏圆环组件 (位于 ContextMeter 旁边)
    // ----------------------------------------------------
    function QuotaDockItem() {
      const { data, loading, error, updatedAt, viewMode, setViewMode, pinnedProvider, setPinned, refresh, activeSessionProviderId, activeSessionSource } = useMagpieQuotas();
      const sessionLabel = activeSessionSource === 'route' ? '最近路由' : '当前会话';
      const [open, setOpen] = React.useState(false);
      const [showHoverTip, setShowHoverTip] = React.useState(false);
      const hoverTimerRef = React.useRef(null);
      const [maskEnabled, setMaskEnabled] = React.useState(() => {
        try { return localStorage.getItem(MASK_STORAGE_KEY) !== '0'; } catch { return true; }
      });
      const popoverRef = React.useRef(null);

      const handleMouseEnter = () => {
        if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = setTimeout(() => {
          setShowHoverTip(true);
        }, 350); // 鼠标悬停 0.35 秒即开，极度轻巧敏捷
      };

      const handleMouseLeave = () => {
        if (hoverTimerRef.current) {
          clearTimeout(hoverTimerRef.current);
          hoverTimerRef.current = null;
        }
        setShowHoverTip(false);
      };

      const toggleMask = () => {
        const next = !maskEnabled;
        setMaskEnabled(next);
        try { localStorage.setItem(MASK_STORAGE_KEY, next ? '1' : '0'); } catch {}
      };

      // 点击外部关闭 Popover
      React.useEffect(() => {
        if (!open) return;
        const onDocClick = (e) => {
          if (popoverRef.current && !popoverRef.current.contains(e.target)) {
            setOpen(false);
          }
        };
        window.addEventListener('mousedown', onDocClick);
        return () => window.removeEventListener('mousedown', onDocClick);
      }, [open]);

      // 辅助判断：忽略大小写精准比对 Provider
      const isProviderMatch = (item, target) => {
        if (!item || !target) return false;
        const t = String(target).toLowerCase();
        return String(item.provider || '').toLowerCase() === t || String(item.name || '').toLowerCase() === t;
      };

      // 1. 真实当前会话模型 Provider（不受置顶影响！）
      const sessionProviderItem = React.useMemo(() => {
        if (activeSessionProviderId) {
          const found = data.find((d) => isProviderMatch(d, activeSessionProviderId));
          if (found) return found;
        }
        return detectActiveSessionProvider(data);
      }, [data, activeSessionProviderId]);

      // 2. 状态栏圆环所展示的目标账号（置顶优先，无置顶时跟随当前会话模型）
      const { activeItem, activeWindow, isPinned, accountCount, allMergedWindows } = React.useMemo(() => {
        let item = null;
        let pinned = false;

        if (pinnedProvider) {
          item = data.find((d) => isProviderMatch(d, pinnedProvider));
          if (item) pinned = true;
        }

        if (!item && sessionProviderItem) {
          item = sessionProviderItem;
        }

        if (!item) {
          const sorted = data
            .filter((d) => d.windows && d.windows.length > 0)
            .sort((a, b) => {
              if (a.last && !b.last) return -1;
              if (!a.last && b.last) return 1;
              const tA = a.lastServedAt ? new Date(a.lastServedAt).getTime() : 0;
              const tB = b.lastServedAt ? new Date(b.lastServedAt).getTime() : 0;
              return tB - tA;
            });
          item = sorted[0];
        }

        if (!item) {
          item = data.find((d) => d.windows && d.windows.length > 0) || data[0];
        }

        // 核心优化：汇总属于该 Provider 的所有账号，合并计算综合配额进度
        const providerAccounts = item ? data.filter((d) => isProviderMatch(d, item.provider || item.name)) : [];
        const mergedWindows = mergeProviderWindows(providerAccounts);

        let win = null;
        if (mergedWindows.length > 0) {
          win = pickPrimaryWindow(mergedWindows);
        }

        return {
          activeItem: item,
          activeWindow: win,
          isPinned: pinned,
          accountCount: providerAccounts.length,
          allMergedWindows: mergedWindows,
        };
      }, [data, pinnedProvider, sessionProviderItem]);

      // 卡片列表排序：置顶项排第一，真实会话模型排第二，其余在后
      const sortedCards = React.useMemo(() => {
        if (!Array.isArray(data)) return [];
        const list = [...data];
        list.sort((a, b) => {
          const aPinned = isProviderMatch(a, pinnedProvider);
          const bPinned = isProviderMatch(b, pinnedProvider);
          if (aPinned && !bPinned) return -1;
          if (!aPinned && bPinned) return 1;

          const aSession = sessionProviderItem && isProviderMatch(a, sessionProviderItem.provider || sessionProviderItem.name);
          const bSession = sessionProviderItem && isProviderMatch(b, sessionProviderItem.provider || sessionProviderItem.name);
          if (aSession && !bSession) return -1;
          if (!aSession && bSession) return 1;

          return 0;
        });
        return list;
      }, [data, pinnedProvider, sessionProviderItem]);

      const isCooling = activeWindow?.display === '冷却中';
      const isSynthetic = Boolean(activeWindow?.synthetic);
      const usedPct = activeWindow && Number.isFinite(activeWindow.used) ? Math.round(activeWindow.used) : 0;
      const remainPct = activeWindow && Number.isFinite(activeWindow.remaining) ? Math.round(activeWindow.remaining) : 0;

      // 合成窗口代表「可用度」：条长与颜色都按剩余可用账号算，绝不因为没额度数据就掉到 0%。
      const barPct = isCooling
        ? (viewMode === 'used' ? 100 : 0)
        : isSynthetic
          ? remainPct
          : (viewMode === 'used' ? usedPct : remainPct);

      const barColor = isCooling
        ? '#f87171'
        : isSynthetic
          ? (remainPct < 15 ? '#f87171' : remainPct < 35 ? '#fbbf24' : '#34d399')
          : (viewMode === 'used'
              ? (usedPct > 85 ? '#f87171' : usedPct > 65 ? '#fbbf24' : getBrandColor(activeItem?.provider))
              : (remainPct < 15 ? '#f87171' : remainPct < 35 ? '#fbbf24' : '#34d399'));

      const amountText = activeWindow && !isCooling && !isSynthetic
        ? dockRemainingText(activeWindow)
        : '';
      const textValue = !activeWindow
        ? '--'
        : isCooling
          ? '冷却'
          : isSynthetic
            ? (remainPct >= 99.9 ? '可用' : `可用 ${remainPct}%`)
            : (amountText ? `${barPct}% · ${amountText}` : `${barPct}%`);
      // 合成窗口说的是「可用度」，标题里不再套「已用/剩余」前缀，避免出现「已用 可用」。
      const titleDetail = !activeWindow
        ? '无可用额度窗口'
        : isSynthetic
          ? (remainPct >= 99.9 ? '全部账号可用' : `可用 ${remainPct}%`)
          : `(${viewMode === 'used' ? '已用' : '剩余'} ${barPct}%${amountText ? ` · ${remainingOfTotalText(activeWindow)}` : ''})`;

      const strokeDash = `${(CIRCUMFERENCE * Math.min(100, Math.max(0, barPct))) / 100} ${CIRCUMFERENCE}`;

      return h('span', {
        ref: popoverRef,
        style: {
          position: 'relative',
          display: 'inline-flex',
          alignItems: 'center',
          userSelect: 'none',
          flex: 'none',
        },
      },
        // 底部圆环按钮 (与 ContextMeter 规格完全对齐，鼠标悬停 2 秒展示重置时间)
        h('button', {
          type: 'button',
          onClick: () => {
            setShowHoverTip(false);
            setOpen(!open);
          },
          onMouseEnter: handleMouseEnter,
          onMouseLeave: handleMouseLeave,
          title: isPinned
            ? `[固定置顶] ${activeItem?.name}${accountCount > 1 ? ` (${accountCount}账号合并)` : ''}: ${titleDetail}`
            : `[${sessionLabel}] ${activeItem?.name}${accountCount > 1 ? ` (${accountCount}账号合并)` : ''}: ${titleDetail}`,
          style: {
            border: 'none',
            background: open ? 'var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, 0.08))' : 'transparent',
            color: open ? 'var(--dsw-alias-label-primary, #f4f4f5)' : 'var(--dsw-alias-label-tertiary, #a1a1aa)',
            borderRadius: 'var(--dsw-radius-sm, 6px)',
            fontFamily: 'inherit',
            fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
            fontVariantNumeric: 'tabular-nums',
            lineHeight: 'calc(20px + var(--dsh-content-font-delta-secondary, 0px))',
            whiteSpace: 'nowrap',
            cursor: 'pointer',
            flex: 'none',
            alignItems: 'center',
            gap: '6px',
            padding: '1px 8px',
            display: 'inline-flex',
            transition: 'background 0.15s ease, color 0.15s ease',
          },
        },
          // 极简圆环 SVG (开启硬件加速 willChange)
          h('svg', {
            viewBox: '0 0 14 14',
            width: '14',
            height: '14',
            style: { flex: 'none', display: 'inline-block' },
            'aria-hidden': 'true',
          },
            h('circle', {
              cx: '7',
              cy: '7',
              r: RADIUS,
              fill: 'none',
              stroke: 'var(--dsw-alias-border-l3, rgba(255, 255, 255, 0.16))',
              strokeWidth: '1.8',
            }),
            h('circle', {
              cx: '7',
              cy: '7',
              r: RADIUS,
              fill: 'none',
              stroke: barColor,
              strokeWidth: '1.8',
              strokeDasharray: strokeDash,
              strokeLinecap: 'round',
              transform: 'rotate(-90 7 7)',
              style: {
                transition: 'stroke-dasharray 0.35s ease, stroke 0.35s ease',
                willChange: 'stroke-dasharray',
              },
            })
          ),
          h('span', {
            style: {
              color: open ? 'var(--dsw-alias-label-primary, #f4f4f5)' : 'inherit',
              transition: 'color 0.15s ease',
            },
          }, `${activeItem ? activeItem.name + ' ' : ''}${textValue}`)
        ),

        // 鼠标悬停 1 秒后浮出的简洁重置进度微型面板
        showHoverTip && !open && h('div', {
          style: {
            position: 'absolute',
            bottom: '28px',
            right: 0,
            background: 'rgba(20, 20, 24, 0.95)',
            border: '1px solid rgba(255, 255, 255, 0.14)',
            color: '#f4f4f5',
            padding: '7px 10px',
            borderRadius: '8px',
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.04)',
            pointerEvents: 'none',
            zIndex: 99999,
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            animation: 'dsh-fade-in 0.16s cubic-bezier(0.16, 1, 0.3, 1)',
            minWidth: '230px',
          },
        },
          (() => {
            const brandColor = getBrandColor(activeItem?.provider);
            const windowsToDisplay = allMergedWindows?.length > 0 ? allMergedWindows : (activeItem?.windows?.filter(isQuotaWindow) || []);
            const fiveHourWin = windowsToDisplay.find((w) => {
              const n = String(w.name || '').toLowerCase();
              return n.includes('5 hour') || n.includes('5小时') || n.includes('5h');
            });
            const longerWin = windowsToDisplay.find((w) => w !== fiveHourWin) || activeWindow;

            const renderRow = (w, defaultLabel) => {
              if (!w) return null;
              const st = windowStats(w, viewMode, brandColor);
              const isCool = st.cooling;
              const pct = st.pct;
              const color = st.color;

              const cleanName = defaultLabel || (w.synthetic ? '可用' : displayWindowName(w.name));
              const amountText = remainingAmountText(w);
              const timeStr = isCool ? '冷却中' : (w.resetsAt ? `${formatRelative(w.resetsAt)}重置` : '长期');

              return h('div', {
                key: w.name,
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '8px',
                  fontSize: '11px',
                  lineHeight: '1.4',
                },
              },
                h('span', { style: { color: THEME.textSecondary, minWidth: '36px' } }, cleanName),
                h('span', {
                  style: {
                    color,
                    fontWeight: 600,
                    fontVariantNumeric: 'tabular-nums',
                  },
                }, isCool ? '冷却' : (w.synthetic ? '可用' : `${pct}%`)),
                amountText && h('span', {
                  style: { color: THEME.textSecondary, fontSize: '10px', fontVariantNumeric: 'tabular-nums' },
                }, amountText),
                h('span', { style: { color: THEME.textTertiary, fontSize: '10px', textAlign: 'right' } }, timeStr)
              );
            };

            return h('div', {
              style: {
                display: 'flex',
                flexDirection: 'column',
                gap: '4px',
              },
            },
              // 微型标题
              h('div', {
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  gap: '5px',
                  fontSize: '11px',
                  fontWeight: 600,
                  color: THEME.textPrimary,
                  borderBottom: `1px solid ${THEME.borderSubtle}`,
                  paddingBottom: '4px',
                  marginBottom: '2px',
                },
              },
                h('span', {
                  style: {
                    width: '6px',
                    height: '6px',
                    borderRadius: '50%',
                    background: brandColor,
                    display: 'inline-block',
                  },
                }),
                h('span', null, `${activeItem?.name || '额度'}${accountCount > 1 ? ` (${accountCount}账号合并)` : ''}`)
              ),
              // 数据行
              fiveHourWin ? [
                renderRow(fiveHourWin, '5小时'),
                longerWin && longerWin !== fiveHourWin && renderRow(longerWin, longerWin.name.includes('7') ? '7天' : displayWindowName(longerWin.name)),
              ] : [
                renderRow(activeWindow, activeWindow ? displayWindowName(activeWindow.name) : undefined),
              ]
            );
          })()
        ),

        // 向上弹出卡片 (开启 translateZ GPU 合成层)
        open && h('div', {
          className: 'dsh-magpie-scroll',
          style: {
            position: 'absolute',
            bottom: '30px',
            right: 0,
            width: 'min(360px, calc(100vw - 24px))',
            maxHeight: '520px',
            background: THEME.surface,
            border: `1px solid ${THEME.border}`,
            borderRadius: '12px',
            boxShadow: THEME.shadow,
            backdropFilter: 'blur(28px)',
            WebkitBackdropFilter: 'blur(28px)',
            transform: 'translateZ(0)',
            padding: '14px',
            zIndex: 9999,
            display: 'flex',
            flexDirection: 'column',
            gap: '12px',
            overflowY: 'auto',
            color: THEME.textPrimary,
            boxSizing: 'border-box',
          },
        },
          // 悬浮层 Header
          h('div', {
            style: {
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              borderBottom: `1px solid ${THEME.borderSubtle}`,
              paddingBottom: '10px',
            },
          },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '7px' } },
              h(MagpieIcon, { size: 17, style: { color: THEME.brand } }),
              h('span', { style: { fontWeight: 600, fontSize: '14px', color: THEME.textPrimary } }, 'Magpie 额度摘要')
            ),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
              h('div', {
                style: {
                  display: 'inline-flex',
                  background: THEME.cardBgSubtle,
                  border: `1px solid ${THEME.borderSubtle}`,
                  borderRadius: '6px',
                  padding: '2px',
                  fontSize: '11px',
                },
              },
                h('button', {
                  onClick: () => setViewMode('used'),
                  style: {
                    border: 'none',
                    background: viewMode === 'used' ? THEME.brand : 'transparent',
                    color: viewMode === 'used' ? '#ffffff' : THEME.textSecondary,
                    borderRadius: '4px',
                    padding: '2px 7px',
                    cursor: 'pointer',
                    fontWeight: viewMode === 'used' ? 600 : 400,
                    transition: 'all 0.15s ease',
                  },
                }, '已用'),
                h('button', {
                  onClick: () => setViewMode('remaining'),
                  style: {
                    border: 'none',
                    background: viewMode === 'remaining' ? THEME.brand : 'transparent',
                    color: viewMode === 'remaining' ? '#ffffff' : THEME.textSecondary,
                    borderRadius: '4px',
                    padding: '2px 7px',
                    cursor: 'pointer',
                    fontWeight: viewMode === 'remaining' ? 600 : 400,
                    transition: 'all 0.15s ease',
                  },
                }, '剩余')
              ),
              h('button', {
                onClick: () => refresh(true),
                title: '立即刷新',
                disabled: loading,
                style: {
                  border: `1px solid ${THEME.borderSubtle}`,
                  background: THEME.cardBgSubtle,
                  color: THEME.textPrimary,
                  cursor: 'pointer',
                  padding: '4px 6px',
                  borderRadius: '6px',
                  display: 'flex',
                  alignItems: 'center',
                  opacity: loading ? 0.5 : 0.9,
                },
              }, h(RefreshIcon, { size: 13, spinning: loading }))
            )
          ),

          // 提示条
          isPinned ? h('div', {
            style: {
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '6px 10px',
              background: 'rgba(99, 102, 241, 0.12)',
              border: '1px solid rgba(99, 102, 241, 0.25)',
              borderRadius: '6px',
              fontSize: '11px',
            },
          },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '5px', color: THEME.brandText } },
              h(PinIcon, { size: 12, filled: true }),
              h('span', null, `已置顶显示: ${activeItem?.name}`),
              sessionProviderItem && (sessionProviderItem.provider !== activeItem?.provider) && h('span', {
                style: { opacity: 0.65, fontSize: '10px', color: THEME.textTertiary, marginLeft: '4px' },
              }, `(${sessionLabel}为 ${sessionProviderItem.name})`)
            ),
            h('button', {
              onClick: () => setPinned(pinnedProvider),
              style: {
                border: 'none',
                background: 'transparent',
                color: THEME.textSecondary,
                cursor: 'pointer',
                fontSize: '11px',
                textDecoration: 'underline',
              },
            }, '恢复自动跟随')
          ) : h('div', {
            style: {
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '5px 10px',
              background: THEME.cardBgSubtle,
              border: `1px solid ${THEME.borderSubtle}`,
              borderRadius: '6px',
              fontSize: '11px',
              color: THEME.textSecondary,
            },
          },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
              h(BoltIcon, { size: 12, style: { color: '#34d399' } }),
              h('span', null, `跟随${sessionLabel}: ${activeItem?.name || '自动'}`)
            ),
            h('span', { style: { opacity: 0.6, fontSize: '10px' } }, '点卡片 📌 可固定置顶')
          ),

          // 错误提示条
          error && h('div', {
            style: {
              padding: '8px 10px',
              background: 'rgba(239, 68, 68, 0.15)',
              border: '1px solid rgba(239, 68, 68, 0.3)',
              borderRadius: '6px',
              color: '#f87171',
              fontSize: '11px',
            },
          }, error),

          // 账号额度条列表 (置顶项排在顶端)
          h('div', {
            className: 'dsh-magpie-scroll',
            style: {
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
              maxHeight: '340px',
              overflowY: 'auto',
            },
          },
            sortedCards.length === 0 ? h('div', {
              style: {
                padding: '24px 12px',
                textAlign: 'center',
                color: THEME.textTertiary,
                fontSize: '12px',
              },
            },
              h('p', { style: { margin: '0 0 8px 0' } }, '未检测到 Magpie 额度信息'),
              h('p', { style: { margin: 0, fontSize: '11px', opacity: 0.7 } }, '请确认 Magpie 网关已启动并在 127.0.0.1:3425 运行')
            ) : sortedCards.map((item, idx) => {
              const brandColor = getBrandColor(item.provider);
              const hasWindows = Array.isArray(item.windows) && item.windows.length > 0;
              const thisIsPinned = isProviderMatch(item, pinnedProvider);
              // 关键修复：当前会话标签必须只绑定真实会话模型 (sessionProviderItem)，绝不随置顶项漂移！
              const thisIsSessionModel = Boolean(
                sessionProviderItem && isProviderMatch(item, sessionProviderItem.provider || sessionProviderItem.name)
              );

              return h('div', {
                key: item.provider + (item.user || '') + idx,
                style: {
                  padding: '10px 12px',
                  background: THEME.cardBg,
                  border: `1px solid ${thisIsPinned ? 'rgba(99, 102, 241, 0.4)' : THEME.border}`,
                  borderRadius: '8px',
                  transition: 'border-color 0.15s ease',
                },
              },
                // 卡片标题栏
                h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
                  h('div', { style: { display: 'flex', alignItems: 'center', gap: '7px' } },
                    h('span', {
                      style: {
                        width: '8px',
                        height: '8px',
                        borderRadius: '50%',
                        background: brandColor,
                        display: 'inline-block',
                      },
                    }),
                    h('b', { style: { fontSize: '13px', color: THEME.textPrimary } }, item.name || item.provider)
                  ),
                  // 右侧操作项: 当前会话使用标签 + 置顶按钮 + 套餐标签
                  h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
                    thisIsSessionModel && h('span', {
                      title: activeSessionSource === 'route' ? '最近一次请求路由到的 Provider' : '当前会话模型使用的 Provider',
                      style: {
                        fontSize: '10px',
                        color: '#34d399',
                        background: 'rgba(52, 211, 153, 0.12)',
                        border: '1px solid rgba(52, 211, 153, 0.25)',
                        padding: '1px 5px',
                        borderRadius: '4px',
                        fontWeight: 500,
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '3px',
                      },
                    },
                      h('span', { style: { width: '4px', height: '4px', borderRadius: '50%', background: '#34d399' } }),
                      h('span', null, sessionLabel)
                    ),
                    // 置顶按钮
                    h('button', {
                      onClick: (e) => {
                        e.stopPropagation();
                        setPinned(item.provider || item.name);
                      },
                      title: thisIsPinned ? '点击取消置顶 (恢复自动跟随当前会话模型)' : '置顶此 Provider 到状态栏',
                      style: {
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '3px',
                        border: `1px solid ${thisIsPinned ? 'rgba(99, 102, 241, 0.5)' : THEME.borderSubtle}`,
                        background: thisIsPinned ? 'rgba(99, 102, 241, 0.2)' : 'transparent',
                        color: thisIsPinned ? THEME.brandText : THEME.textTertiary,
                        padding: '2px 6px',
                        borderRadius: '4px',
                        cursor: 'pointer',
                        fontSize: '11px',
                        transition: 'all 0.15s ease',
                      },
                    },
                      h(PinIcon, { size: 11, filled: thisIsPinned }),
                      h('span', null, thisIsPinned ? '已置顶' : '置顶')
                    ),
                    // 套餐标签
                    h('span', {
                      style: {
                        fontSize: '11px',
                        color: THEME.textSecondary,
                        background: THEME.cardBgSubtle,
                        border: `1px solid ${THEME.borderSubtle}`,
                        padding: '2px 6px',
                        borderRadius: '4px',
                      },
                    }, displayPlanName(item.plan || item.kind))
                  )
                ),

                // 账号行
                (item.alias || item.user) && h('div', {
                  style: {
                    fontSize: '11px',
                    color: THEME.textSecondary,
                    marginTop: '4px',
                    fontFamily: 'ui-monospace, SFMono-Regular, monospace',
                  },
                }, maskEmail(item.alias || item.user, true)),

                // 进度条渲染
                hasWindows ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
                  (() => {
                    const quotaWindows = item.windows.filter(isQuotaWindow);
                    const infoWindows = item.windows.filter(isInfoItem);
                    // 上游不提供百分比额度时（Google AI Studio 正常状态下只有服务信息），
                    // 用该 Provider 的可用账号数合成一条状态行，避免卡片中部空白。
                    const providerAccounts = data.filter((d) => isProviderMatch(d, item.provider || item.name));
                    const statusWindows = quotaWindows.length > 0
                      ? quotaWindows
                      : availabilityWindowsFor(providerAccounts, item);

                    return [
                      ...statusWindows.map((w, wIdx) => {
                        const st = windowStats(w, viewMode, brandColor);
                        const isCooling = st.cooling;
                        const pct = st.pct;
                        const label = st.label;
                        const barColor = st.color;
                        const amountText = remainingAmountText(w);
                        const amountDetail = remainingOfTotalText(w);

                        return h('div', {
                          key: w.name + wIdx,
                          title: amountDetail,
                          style: { marginTop: '4px' },
                        },
                          h('div', {
                            style: {
                              display: 'flex',
                              justifyContent: 'space-between',
                              alignItems: 'baseline',
                              gap: '6px',
                              flexWrap: 'wrap',
                              fontSize: '11px',
                              marginBottom: '4px',
                            },
                          },
                            h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
                              h('span', { style: { color: THEME.textPrimary, fontWeight: 500 } }, displayWindowName(w.name)),
                              isCooling && h('span', {
                                style: {
                                  fontSize: '10px',
                                  color: '#f59e0b',
                                  background: 'rgba(245, 158, 11, 0.15)',
                                  border: '1px solid rgba(245, 158, 11, 0.3)',
                                  padding: '0 4px',
                                  borderRadius: '3px',
                                },
                              }, '冷却中')
                            ),
                            h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '6px' } },
                              h('b', { style: { color: barColor, fontVariantNumeric: 'tabular-nums' } }, label),
                              amountText && h('span', {
                                style: {
                                  fontSize: '10px',
                                  color: THEME.textSecondary,
                                  fontVariantNumeric: 'tabular-nums',
                                },
                              }, amountText)
                            )
                          ),
                          // 进度条槽
                          h('div', {
                            style: {
                              height: '6px',
                              borderRadius: '3px',
                              background: THEME.trackBg,
                              overflow: 'hidden',
                            },
                          },
                            h('div', {
                              style: {
                                width: `${Math.min(100, Math.max(0, pct))}%`,
                                height: '100%',
                                background: barColor,
                                borderRadius: '3px',
                                transition: 'width 0.3s ease',
                              },
                            })
                          ),
                          // 倒计时信息
                          w.resetsAt && h('div', {
                            style: {
                              fontSize: '10px',
                              color: THEME.textTertiary,
                              marginTop: '3px',
                              textAlign: 'right',
                            },
                          }, `重置于 ${formatTime(w.resetsAt)} · ${formatRelative(w.resetsAt)}`)
                        );
                      }),
                      // 链接与配置信息展示
                      infoWindows.length > 0 && h('div', {
                        key: 'info-footer',
                        style: {
                          borderTop: `1px solid ${THEME.borderSubtle}`,
                          paddingTop: '6px',
                          marginTop: '6px',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '3px',
                        },
                      },
                        infoWindows.map((info) => h('div', {
                          key: info.name,
                          title: info.display,
                          style: {
                            display: 'flex',
                            gap: '6px',
                            fontSize: '11px',
                            alignItems: 'baseline',
                            minWidth: 0,
                          },
                        },
                          h('span', { style: { color: THEME.textSecondary, fontWeight: 500, flex: 'none' } }, `${info.name}:`),
                          h('span', {
                            style: {
                              fontFamily: 'ui-monospace, monospace',
                              color: THEME.textTertiary,
                              fontSize: '10px',
                              minWidth: 0,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            },
                          }, info.display)
                        ))
                      ),
                    ];
                  })()
                ) : h('div', {
                  style: {
                    fontSize: '11px',
                    color: THEME.textTertiary,
                    marginTop: '6px',
                    fontStyle: 'italic',
                  },
                }, item.error || '暂无可用额度窗口')
              );
            })
          ),

          // 底部工具条：更新时间 + 隐私打码开关
          h('div', {
            style: {
              borderTop: `1px solid ${THEME.borderSubtle}`,
              paddingTop: '10px',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            },
          },
            h('span', { style: { fontSize: '11px', color: THEME.textTertiary } },
              updatedAt ? `更新于 ${formatTime(updatedAt)}` : ''
            ),
            h('button', {
              onClick: toggleMask,
              title: '切换邮箱脱敏状态',
              style: {
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                border: `1px solid ${THEME.borderSubtle}`,
                background: maskEnabled ? THEME.cardBg : 'transparent',
                color: maskEnabled ? THEME.textPrimary : THEME.textTertiary,
                fontSize: '11px',
                fontWeight: 500,
                cursor: 'pointer',
                padding: '3px 8px',
                borderRadius: '5px',
                transition: 'all 0.15s ease',
              },
            },
              h('span', null, maskEnabled ? '👁 已打码' : '👁‍🗨 明文')
            )
          )
        )
      );
    }

    // ----------------------------------------------------
    // 全局基础样式注入
    // ----------------------------------------------------
    function ensureStyles() {
      if (typeof document === 'undefined') return;
      if (document.getElementById('dsh-magpie-quota-style')) return;
      const s = document.createElement('style');
      s.id = 'dsh-magpie-quota-style';
      s.textContent = `
        @keyframes dsh-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes dsh-fade-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
        .dsh-magpie-scroll::-webkit-scrollbar { width: 5px; height: 5px; }
        .dsh-magpie-scroll::-webkit-scrollbar-track { background: transparent; }
        .dsh-magpie-scroll::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.15); border-radius: 3px; }
        .dsh-magpie-scroll::-webkit-scrollbar-thumb:hover { background: rgba(255, 255, 255, 0.28); }
      `;
      (document.head || document.documentElement)?.appendChild?.(s);
    }

    // ----------------------------------------------------
    // 插件装配导出 (精准挂载至输入框底部状态栏与上下文占用比例并列)
    // ----------------------------------------------------
    return {
      inject: ['slots'],
      apply(ctx) {
        ensureStyles();

        // 挂载至会话 composer.dock，order: 2 排在 token 统计之后，上下文比例环之前
        ctx.slots.inject('conversation.composer.dock', () => {
          ctx.slots.register({
            name: 'conversation.composer.dock',
            id: 'magpie-quota',
            order: 2,
            label: () => 'Magpie 额度',
          }, QuotaDockItem);
        });
      },
    };
  },
});
