'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createHandler } = require('../server');

const env = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'server-only-secret',
  SUPABASE_ANON_KEY: 'public-key',
  ADMIN_EMAIL: 'EDUARDO@example.com'
};

function fixture({ admin = true, confirmed = true, failure = false, initial = {} } = {}) {
  const database = {
    banks: [{ id: 'bank-1', name: 'Itaú' }, { id: 'bank-2', name: 'XP' }],
    partners: [{ id: 'partner-1', name: 'Eduardo', share: 100, minimum: 100, discount: 10, password_hash: 'never-expose' }],
    closings: [],
    ...structuredClone(initial)
  };
  const calls = [];
  const mockFetch = async (input, options = {}) => {
    const url = new URL(input);
    calls.push({ url, method: options.method || 'GET', body: options.body });
    if (url.pathname === '/auth/v1/user') {
      return Response.json({ id: 'user-1', email: admin ? 'eduardo@example.com' : 'reader@example.com', email_confirmed_at: confirmed ? '2026-01-01' : null });
    }
    if (failure) return Response.json({ message: 'private backend exception' }, { status: 500 });
    const table = url.pathname.split('/').pop();
    const method = options.method || 'GET';
    if (method === 'GET') {
      const fields = url.searchParams.get('select');
      const idFilter = url.searchParams.get('id');
      const selected = database[table].filter(item => !idFilter || item.id === idFilter.slice(3)).map(item => fields === '*' ? item : Object.fromEntries(fields.split(',').map(field => [field, item[field]])));
      return Response.json(selected);
    }
    if (method === 'POST') {
      const row = { id: 'created-' + table, ...JSON.parse(options.body) };
      database[table].push(row);
      return Response.json([row], { status: 201 });
    }
    const id = url.searchParams.get('id').slice(3);
    const index = database[table].findIndex(item => item.id === id);
    if (method === 'DELETE') {
      const result = index < 0 ? [] : database[table].splice(index, 1);
      return Response.json(result);
    }
    if (method === 'PATCH') {
      if (index < 0) return Response.json([]);
      database[table][index] = { ...database[table][index], ...JSON.parse(options.body) };
      return Response.json([database[table][index]]);
    }
    throw new Error('Unexpected mocked operation');
  };
  return { handler: createHandler({ env, fetchImpl: mockFetch }), database, calls };
}

async function withServer(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return async (pathname, { method = 'GET', data, authenticated = true } = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, {
      method,
      headers: { ...(authenticated ? { Authorization: 'Bearer test-user-token' } : {}), ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: data === undefined ? undefined : JSON.stringify(data)
    });
    const body = response.headers.get('Content-Type')?.includes('application/json') ? await response.json() : await response.text();
    return { response, body };
  };
}

test('public configuration never exposes the service key; CSS uses the correct MIME', async t => {
  const { handler } = fixture();
  const request = await withServer(t, handler);
  const config = await request('/api/config', { authenticated: false });
  assert.equal(config.response.status, 200);
  assert.deepEqual(config.body, { url: env.SUPABASE_URL, anonKey: env.SUPABASE_ANON_KEY });
  assert.equal(config.response.headers.get('Cache-Control'), 'no-store');
  const css = await request('/public/style.css', { authenticated: false });
  assert.equal(css.response.status, 200);
  assert.match(css.response.headers.get('Content-Type'), /^text\/css/);
  const traversal = await request('/public/%2f..%2fserver.js', { authenticated: false });
  assert.equal(traversal.response.status, 404);
});

test('unauthenticated requests and default-password login cannot read data', async t => {
  const { handler, calls } = fixture();
  const request = await withServer(t, handler);
  assert.equal((await request('/api/bootstrap', { authenticated: false })).response.status, 401);
  assert.equal((await request('/api/login', { method: 'POST', data: { username: 'admin', password: 'inepad2024' }, authenticated: false })).response.status, 401);
  assert.equal(calls.length, 0);
});

test('readers can view history but cannot mutate bank data', async t => {
  const { handler, database } = fixture({ admin: false });
  const request = await withServer(t, handler);
  const bootstrap = await request('/api/bootstrap');
  assert.equal(bootstrap.response.status, 200);
  assert.equal(bootstrap.body.user.role, 'partner');
  assert.equal(bootstrap.body.partners[0].password_hash, undefined);
  assert.equal((await request('/api/banks', { method: 'POST', data: { name: 'New Bank' } })).response.status, 403);
  assert.equal((await request('/api/banks/bank-1', { method: 'DELETE' })).response.status, 403);
  assert.equal(database.banks.length, 2);
});

test('an unconfirmed email cannot acquire administrator access', async t => {
  const { handler } = fixture({ confirmed: false });
  const request = await withServer(t, handler);
  assert.equal((await request('/api/bootstrap')).response.status, 401);
});

test('administrator creates persisted banks, rejects duplicates and preserves historical snapshots on deletion', async t => {
  const snapshot = { id: 'closing-1', quarter: '2025 1º Trimestre', rows: { balances: { Itaú: 400 } } };
  const { handler, database } = fixture({ initial: { closings: [snapshot] } });
  const request = await withServer(t, handler);
  assert.equal((await request('/api/banks', { method: 'POST', data: { name: '  BTG  ' } })).response.status, 201);
  assert.equal(database.banks.at(-1).name, 'BTG');
  assert.equal((await request('/api/banks', { method: 'POST', data: { name: 'btg' } })).response.status, 409);
  assert.equal((await request('/api/banks/bank-1', { method: 'DELETE' })).response.status, 200);
  assert.deepEqual(database.closings[0], snapshot);
});

test('partner updates persist and cannot elevate roles or allocate over 100%', async t => {
  const { handler, database } = fixture();
  const request = await withServer(t, handler);
  const update = await request('/api/partners/partner-1', { method: 'PUT', data: { name: 'Eduardo atualizado', share: 100, minimum: 1000, discount: 25, role: 'admin', password_hash: 'hijacked' } });
  assert.equal(update.response.status, 200);
  assert.equal(database.partners[0].minimum, 1000);
  assert.equal(database.partners[0].password_hash, 'never-expose');
  assert.equal(update.body.password_hash, undefined);
  const invalid = await request('/api/partners', { method: 'POST', data: { name: 'Other', share: 1, minimum: 0, discount: 0 } });
  assert.equal(invalid.response.status, 400);
});

function closingInput(overrides = {}) {
  return { year: 2027, quarter: 1, balances: [{ bankId: 'bank-1', value: 900 }, { bankId: 'bank-2', value: 600 }], previousCash: 1000, previousDistribution: 100, distributionPct: 90, actualDistribution: 0, ...overrides };
}

test('saving a closing recomputes totals on server and persists individual balances', async t => {
  const { handler, database } = fixture();
  const request = await withServer(t, handler);
  const saved = await request('/api/closings', { method: 'POST', data: closingInput({ current_cash: 999999, rows: { generated_cash: 999999 } }) });
  assert.equal(saved.response.status, 201);
  const record = database.closings[0];
  assert.equal(record.current_cash, 1500);
  assert.equal(record.previous_distribution, 100);
  assert.equal(record.rows.previous_cash, 1000);
  assert.equal(record.rows.generated_cash, 600);
  assert.equal(record.rows.distribution_amount, 540);
  assert.equal(record.rows.reinvestment, 60);
  assert.deepEqual(record.rows.balances, { Itaú: 900, XP: 600 });
  assert.equal(record.rows.partner_rows[0].total, 510);
  assert.equal((await request('/api/closings', { method: 'POST', data: closingInput() })).response.status, 409);
});

test('closing validation requires every active bank exactly once and preserves valid zero balances', async t => {
  const { handler, database } = fixture();
  const request = await withServer(t, handler);
  const missing = await request('/api/closings', { method: 'POST', data: closingInput({ balances: [{ bankId: 'bank-1', value: 900 }] }) });
  assert.equal(missing.response.status, 400);
  const duplicate = await request('/api/closings', { method: 'POST', data: closingInput({ balances: [{ bankId: 'bank-1', value: 900 }, { bankId: 'bank-1', value: 0 }] }) });
  assert.equal(duplicate.response.status, 400);
  const zero = await request('/api/closings', { method: 'POST', data: closingInput({ balances: [{ bankId: 'bank-1', value: 0 }, { bankId: 'bank-2', value: 0 }] }) });
  assert.equal(zero.response.status, 201);
  assert.equal(database.closings[0].current_cash, 0);
});

test('pending imported placeholders are completed rather than duplicated', async t => {
  const pending = { id: 'pending-1', quarter: '2027 1º Trimestre', current_cash: 0, previous_distribution: 1500, rows: { source: 'history.xlsx', balances: { Itaú: 0, XP: 0 }, actual_distribution: 0 } };
  const { handler, database, calls } = fixture({ initial: { closings: [pending] } });
  const request = await withServer(t, handler);
  const saved = await request('/api/closings', { method: 'POST', data: closingInput() });
  assert.equal(saved.response.status, 200);
  assert.equal(saved.body.id, 'pending-1');
  assert.equal(database.closings.length, 1);
  assert.equal(database.closings[0].rows.schemaVersion, 2);
  assert.equal(calls.at(-1).method, 'PATCH');
});

test('database errors are surfaced without exposing provider internals', async t => {
  const { handler } = fixture({ failure: true });
  const request = await withServer(t, handler);
  const failed = await request('/api/bootstrap');
  assert.equal(failed.response.status, 502);
  assert.doesNotMatch(failed.body.error, /private backend exception/);
});

test('recording an actual payout changes only the distribution and preserves imported snapshots', async t => {
  const original = { id: 'closing-history', quarter: '2026 3º Trimestre', current_cash: 1500, previous_distribution: 1000, distribution_pct: 90, created_at: '2026-10-01', rows: { balances: { Itaú: 1000, XP: 500 }, actual_distribution: 0, source: 'original.xlsx', partner_rows: [{ name: 'Ana', total: 50 }] } };
  const { handler, database } = fixture({ initial: { closings: [original] } });
  const request = await withServer(t, handler);
  const saved = await request('/api/closings/closing-history', { method: 'PATCH', data: { actualDistribution: 350.55, current_cash: 0, quarter: '2027 1º Trimestre', rows: { balances: {} } } });
  assert.equal(saved.response.status, 200);
  assert.deepEqual(database.closings[0], { ...original, rows: { ...original.rows, actual_distribution: 350.55 } });
  assert.equal((await request('/api/closings/closing-history', { method: 'PATCH', data: { actualDistribution: -1 } })).response.status, 400);
  assert.equal((await request('/api/closings/closing-history', { method: 'PATCH', data: { actualDistribution: 1.001 } })).response.status, 400);
  assert.equal((await request('/api/closings/missing', { method: 'PATCH', data: { actualDistribution: 100 } })).response.status, 404);
});

test('readers cannot record payouts', async t => {
  const { handler, calls } = fixture({ admin: false });
  const request = await withServer(t, handler);
  const response = await request('/api/closings/closing-history', { method: 'PATCH', data: { actualDistribution: 10 } });
  assert.equal(response.response.status, 403);
  assert.equal(calls.filter(call => call.url.pathname.startsWith('/rest/')).length, 0);
});
