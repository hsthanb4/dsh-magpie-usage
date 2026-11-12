import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const clientPath = fileURLToPath(new URL('../client.js', import.meta.url));
const source = readFileSync(clientPath, 'utf8');
const exposure = `globalThis.review = {
  windowStats, mergeProviderWindows, windowAmounts,
  checkActiveSessionModelNow, resolveRouteProvider,
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
