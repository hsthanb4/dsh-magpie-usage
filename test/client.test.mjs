import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const clientPath = fileURLToPath(new URL('../client.js', import.meta.url));
const source = readFileSync(clientPath, 'utf8');
const exposure = `globalThis.review = {
  windowStats, mergeProviderWindows, windowAmounts, pickPrimaryWindow, displayWindowName,
  checkActiveSessionModelNow, resolveRouteProvider,
  parseRgb, detectLightTheme, getBrandColor, QuotaDockItem,
  palettes: () => ({ light: LIGHT_THEME, dark: DARK_THEME }),
  get state() { return sharedState; },
};\n`;
const marker = "    return {\n      inject: ['slots'],";
assert.equal(source.split(marker).length, 2, 'expose original functions only at the plugin export');

function harness() {
  let now = 1_000_000;
  let model = 'group/auto-coding';
  let response = { ok: true, req: model, provider: 'kiro' };
  const requests = [];
  let releaseResponse = null;
  let responseGate = null;
  class Clock extends Date { static now() { return now; } }
  const context = {
    Date: Clock, Intl, AbortController, console,
    localStorage: { getItem: () => null },
    document: { querySelector: (selector) => selector === '[data-model-id]'
      ? { getAttribute: () => model } : null },
    fetch: async (url) => {
      requests.push(url);
      const payload = response;
      if (responseGate) await responseGate;
      return { ok: true, json: async () => payload };
    },
    window: { __ModuleLoader__: { load: ({ factory }) => factory(() => ({ createElement() {} })) } },
  };
  vm.runInNewContext(source.replace(marker, exposure + marker), context, { filename: clientPath });
  context.review.state.data = [
    { provider: 'kiro', name: 'Kiro', windows: [] },
    { provider: 'codex', name: 'Codex', windows: [] },
  ];
  return {
    api: context.review, requests,
    advance: (ms) => { now += ms; },
    model: (value) => { model = value; },
    response: (value) => { response = value; },
    hidden: (value) => { context.document.hidden = value; },
    deferResponse: () => { responseGate = new Promise((resolve) => { releaseResponse = resolve; }); },
    releaseResponse: () => { releaseResponse(); responseGate = null; },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('daily pool window name is translated', () => {
  const { api } = harness();
  assert.equal(api.displayWindowName('Daily pool'), '日池');
  assert.equal(api.displayWindowName('Chat requests'), '聊天请求');
});

test('primary window combines equal-unit quota pools', () => {
  const { api } = harness();
  const primary = api.pickPrimaryWindow([
    { name: 'Daily pool', used: 86.95238095238095, remaining: 13.047619047619051, amount: 1826, limit: 2100, unit: 'credits' },
    { name: 'Credits', used: 0.4126984126984127, remaining: 99.58730158730158, amount: 26, limit: 6300, unit: 'credits' },
  ]);
  assert.equal(primary.name, '积分合计');
  assert.equal(primary.limit, 8400);
  assert.equal(primary.amount, 1852);
  assert.equal(api.windowAmounts(primary).remainingAmount, 6548);
  assert.ok(Math.abs(primary.used - 22.047619047619047) < 0.0001);
});

test('holdsWhy=clock describes estimation, not cooling (also aggregated)', () => {
  const { api } = harness();
  const w = { name: '5-hour', holdsWhy: 'clock', used: 25, remaining: 75 };
  assert.equal(api.windowStats(w, 'used', 'brand').cooling, false);
  const merged = api.mergeProviderWindows([{ windows: [w] }, { windows: [w] }]);
  assert.equal(merged[0].display, undefined);
  assert.equal(merged[0].used, 25);
});

test('an explicitly cooling window still renders as cooling', () => {
  const { api } = harness();
  assert.equal(api.windowStats({ display: '冷却中', holdsWhy: 'none' }, 'used', 'brand').cooling, true);
});

test('absolute remaining quota is computed from amount or a known percentage', () => {
  const { api } = harness();
  assert.equal(api.windowAmounts({ limit: 200, amount: 50, unit: 'credits' }).remainingAmount, 150);
  assert.equal(api.windowAmounts({ limit: 200, used: 25, unit: 'credits' }).remainingAmount, 150);
});

test('a real per-window balance renders as 余额 (TeleAgent)', () => {
  const { api } = harness();
  const wallet = { name: '积分余额', used: 0, remaining: 100, unit: '积分',
    runsOutAt: '2026-11-30T15:59:59Z', balance: 6076.94, spent: 0.02,
    spentSince: '2026-11-20T13:10:01.110546+08:00' };
  const merged = api.mergeProviderWindows([{ provider: 'teleagent', name: 'TeleAgent', windows: [wallet] }]);
  assert.equal(merged.length, 1);
  assert.ok(Math.abs(merged[0].balance - 6076.94) < 1e-9, 'wallet balance passes through the merge');
  assert.equal(merged[0].unit, '积分');
  const st = api.windowStats(merged[0], 'used', 'brand');
  assert.equal(st.balance, true);
  assert.equal(st.pct, null, 'wallet windows carry no percentage');
  assert.ok(st.label.includes('6,076.9'), `label shows the wallet balance: ${st.label}`);
  assert.equal(api.windowAmounts(merged[0]).remainingAmount, 6076.94);
});

test('the wallet balance window outranks sign-in text windows', () => {
  const { api } = harness();
  const primary = api.pickPrimaryWindow([
    { name: '每日签到', used: 0, remaining: 100, display: '今日已签 ✓ +400', text: true },
    { name: '积分余额', used: 0, remaining: 100, unit: '积分', balance: 20282 },
    { name: '活动积分', used: 0, remaining: 100, display: '剩 19,482', text: true },
  ]);
  assert.equal(primary.name, '积分余额');
  assert.equal(api.pickPrimaryWindow([
    { name: 'Credits', used: 10, amount: 100, limit: 1000, unit: 'credits' },
    { name: '积分余额', used: 0, unit: '积分', balance: 20282 },
  ]).name, 'Credits');
});

test('a group route refreshes after its 10-second client TTL', async () => {
  const h = harness();
  h.api.checkActiveSessionModelNow();
  await settle();
  assert.equal(h.api.state.activeSessionProviderId, 'kiro');
  assert.equal(h.requests.length, 1);
  h.advance(60_000);
  h.response({ ok: true, req: 'group/auto-coding', provider: 'codex' });
  h.api.checkActiveSessionModelNow();
  await settle();
  assert.equal(h.requests.length, 2, 'cached route bypasses resolveRouteProvider forever');
  assert.equal(h.api.state.activeSessionProviderId, 'codex');
});

test('switching to a model with no route clears the previous provider', async () => {
  const h = harness();
  h.api.checkActiveSessionModelNow();
  await settle();
  h.model('group/auto-research');
  h.response({ ok: true, req: 'group/auto-research', provider: null });
  h.api.checkActiveSessionModelNow();
  await settle();
  assert.equal(h.api.state.activeSessionProviderId, null, 'new group inherits the previous provider');
});

test('removing the active model clears the previous provider', async () => {
  const h = harness();
  h.api.checkActiveSessionModelNow();
  await settle();
  h.model('');
  h.api.checkActiveSessionModelNow();
  assert.equal(h.api.state.activeSessionProviderId, null, 'empty session keeps a previous route');
});

test('same-group heartbeats reuse the route within its TTL', async () => {
  const h = harness();
  h.api.checkActiveSessionModelNow();
  await settle();
  h.advance(9_000);
  for (let i = 0; i < 5; i++) h.api.checkActiveSessionModelNow();
  await settle();
  assert.equal(h.requests.length, 1);
  assert.equal(h.api.state.activeSessionProviderId, 'kiro');
});

test('background heartbeats do not start route requests', () => {
  const h = harness();
  h.hidden(true);
  h.api.checkActiveSessionModelNow();
  assert.equal(h.requests.length, 0);
});

test('a late route response cannot restore a provider into an empty session', async () => {
  const h = harness();
  h.deferResponse();
  h.api.checkActiveSessionModelNow();
  h.model('');
  h.api.checkActiveSessionModelNow();
  h.releaseResponse();
  await settle();
  assert.equal(h.api.state.activeSessionProviderId, null);
});

test('a refreshed group with no matching route clears its old provider', async () => {
  const h = harness();
  h.api.checkActiveSessionModelNow();
  await settle();
  h.advance(60_000);
  h.response({ ok: true, req: 'group/auto-coding', provider: null });
  h.api.checkActiveSessionModelNow();
  await settle();
  assert.equal(h.api.state.activeSessionProviderId, null);
});

test('theme detection parses host label colors and defaults to dark', () => {
  const { api } = harness();
  assert.deepEqual([...api.parseRgb('#0f1115')], [15, 17, 21]);
  assert.deepEqual([...api.parseRgb(' rgb(249, 250, 251) ')], [249, 250, 251]);
  assert.equal(api.parseRgb('var(--x)'), null);
  assert.equal(api.detectLightTheme(null), false, 'no computed style available');
});

// WCAG 对比度（相对白底）：只接受 #rrggbb 字面量
const contrastOnWhite = (hex) => {
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 1.05 / (0.2126 * r + 0.7152 * g + 0.0722 * b + 0.05);
};

test('light palette remaps every status/brand color to an AA-readable shade', () => {
  const { api } = harness();
  const colors = new Set();
  const windows = [
    { synthetic: true, remaining: 90 }, { synthetic: true, remaining: 25 }, { synthetic: true, remaining: 8 },
    { display: '冷却中' },
    { name: '5h', used: 30, remaining: 70 }, { name: '5h', used: 70, remaining: 30 }, { name: '5h', used: 95, remaining: 5 },
  ];
  for (const w of windows) {
    for (const mode of ['used', 'remaining']) colors.add(api.windowStats(w, mode, '#10a37f').color);
  }
  for (const provider of ['codex', 'kiro', 'workbuddy', 'gemini', 'zcode', 'command', 'unknown']) {
    colors.add(api.getBrandColor(provider));
  }
  const { light } = api.palettes();
  for (const color of colors) {
    assert.match(color, /^#[0-9a-f]{6}$/i, `windowStats/getBrandColor 只能产出 6 位 hex: ${color}`);
    const mapped = light.tones[color] || color;
    const ratio = contrastOnWhite(mapped);
    assert.ok(ratio >= 4.5, `浅色主题 ${color} -> ${mapped} 白底对比度 ${ratio.toFixed(2)} 低于 AA 4.5`);
  }
});

test('popover renders with a matching palette on light and dark hosts', () => {
  function renderHost(labelColor) {
    let hookIdx = 0;
    const created = [];
    const React = {
      createElement: (type, props, ...children) => { created.push(props); return { type, props, children }; },
      // useState 序：0=共享状态, 1=open（强制 true 让弹层进树）, 其余原样
      useState: (init) => { const i = hookIdx++; const v = typeof init === 'function' ? init() : init; return [i === 1 ? true : v, () => {}]; },
      useEffect: () => {}, useRef: () => ({ current: null }), useCallback: (fn) => fn, useMemo: (fn) => fn(),
    };
    const context = {
      Date, Intl, AbortController, console,
      localStorage: { getItem: () => null },
      document: { querySelector: () => null, body: {} },
      getComputedStyle: () => ({ getPropertyValue: (n) => (n === '--dsw-alias-label-primary' ? labelColor : '') }),
      fetch: async () => ({ ok: true, json: async () => ({}) }),
      setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {},
      window: { __ModuleLoader__: { load: ({ factory }) => factory(() => React) }, addEventListener() {}, removeEventListener() {} },
    };
    vm.runInNewContext(source.replace(marker, exposure + marker), context, { filename: clientPath });
    context.review.state.data = [{ provider: 'kiro', name: 'Kiro', windows: [
      { name: '5-hour', used: 90, remaining: 10 }, { name: '7-day', used: 20, remaining: 80 }] }];
    context.review.QuotaDockItem();
    return JSON.stringify(created);
  }

  const light = renderHost('#0f1115');
  assert.ok(light.includes('rgba(255, 255, 255, 0.97)'), 'light host: popover uses light surface');
  assert.ok(!light.includes('rgba(24, 24, 27'), 'light host: no dark surface left');
  for (const bright of ['#34d399', '#fbbf24', '#f87171', '#10a37f', '#a855f7', '#14b8a6', '#3b82f6', '#f97316', '#818cf8']) {
    assert.ok(!light.includes(bright), `light host: ${bright} must be remapped for readability`);
  }

  const dark = renderHost('#f9fafb');
  assert.ok(dark.includes('rgba(24, 24, 27, 0.94)'), 'dark host: popover keeps dark surface');
  assert.ok(!dark.includes('rgba(255, 255, 255, 0.97)'), 'dark host: no light surface');
  assert.ok(dark.includes('#34d399') || dark.includes('#dc2626'), 'dark host: status colors stay vivid');
});

test('a balance-only provider synthesizes a 余额 window (QwenWork)', () => {
  const { api } = harness();
  const merged = api.mergeProviderWindows([
    { provider: 'qwenwork', windows: [], balance: '2019.97 credits (monthly 100 · long-term 1924.97)' },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].balance, true);
  assert.equal(merged[0].limit, 2019.97);
  assert.equal(merged[0].unit, 'credits');
  assert.equal(merged[0].balanceDetail, 'monthly 100 · long-term 1924.97');
  const st = api.windowStats(merged[0], 'used', 'brand');
  assert.equal(st.balance, true);
  assert.equal(st.pct, null, 'balance has no percentage');
  assert.ok(st.label.includes('余额'));
});

test('balance strings parse commas, dollars and raw units', () => {
  const { api } = harness();
  const merged = api.mergeProviderWindows([
    { provider: 'wps', windows: [], balance: '3,376 智点' },
    { provider: 'wps', windows: [], balance: '100 智点' },
  ]);
  assert.equal(merged[0].limit, 3476);
  assert.equal(merged[0].unit, '智点');
  const usd = api.mergeProviderWindows([{ windows: [], balance: '$0.00' }]);
  assert.equal(usd[0].limit, 0);
  assert.equal(usd[0].unit, 'usd');
});

test('providers with real windows ignore the balance string', () => {
  const { api } = harness();
  const merged = api.mergeProviderWindows([
    { windows: [{ name: '智点', used: 0.7, remaining: 99.3, amount: 24, limit: 3400, unit: '智点' }], balance: '3,376 智点' },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].name, '智点');
  assert.equal(merged[0].balance, undefined);
});
