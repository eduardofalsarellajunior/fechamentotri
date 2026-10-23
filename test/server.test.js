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

function fixture({ admin = true, confirmed = true, failure = false, mustChangePassword = false, failPartnerWrite = false, initial = {} } = {}) {
  const database = {
    banks: [{ id: 'bank-1', name: 'Itaú' }, { id: 'bank-2', name: 'XP' }],
    partners: [{ id: 'partner-1', name: 'Eduardo', share: 100, minimum: 100, discount: 10, password_hash: 'never-expose' }],
    closings: [],
    ...structuredClone(initial)
  };
  const authUsers = [{ id: 'user-1', email: admin ? 'eduardo@example.com' : 'reader@example.com', email_confirmed_at: confirmed ? '2026-01-01' : null, app_metadata: { partner_id: 'partner-1', must_change_password: mustChangePassword }, user_metadata: {} }];
  const calls = [];
  const mockFetch = async (input, options = {}) => {
    const url = new URL(input);
    calls.push({ url, method: options.method || 'GET', body: options.body });
    if (url.pathname === '/auth/v1/user') {
      return Response.json(authUsers[0]);
    }
    if (failure) return Response.json({ message: 'private backend exception' }, { status: 500 });
    if (url.pathname === '/auth/v1/admin/users') {
      if (!options.method || options.method === 'GET') return Response.json({ users: authUsers });
      const created = { id: 'auth-created', ...JSON.parse(options.body) };
      authUsers.push(created);
      return Response.json(created, { status: 201 });
    }
    if (url.pathname.startsWith('/auth/v1/admin/users/')) {
      const authId = url.pathname.split('/').pop();
      const accountIndex = authUsers.findIndex(account => account.id === authId);
      if (options.method === 'DELETE') {
        if (accountIndex >= 0) authUsers.splice(accountIndex, 1);
        return new Response(null, { status: 204 });
      }
      const update = JSON.parse(options.body);
      authUsers[accountIndex] = { ...authUsers[accountIndex], ...update };
      return Response.json(authUsers[accountIndex]);
    }
    const table = url.pathname.split('/').pop();
    const method = options.method || 'GET';
    if (failPartnerWrite && table === 'partners' && method !== 'GET') return Response.json({ error: 'database write failed' }, { status: 500 });
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
  return { handler: createHandler({ env, fetchImpl: mockFetch }), database, calls, authUsers };
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
  const update = await request('/api/partners/partner-1', { method: 'PUT', data: { name: 'Eduardo atualizado', email: 'eduardo@example.com', share: 100, minimum: 1000, discount: 25, role: 'admin', password_hash: 'hijacked' } });
  assert.equal(update.response.status, 200);
  assert.equal(database.partners[0].minimum, 1000);
  assert.equal(database.partners[0].password_hash, 'never-expose');
  assert.equal(update.body.password_hash, undefined);
  const invalid = await request('/api/partners', { method: 'POST', data: { name: 'Other', email: 'other@example.com', share: 1, minimum: 0, discount: 0 } });
  assert.equal(invalid.response.status, 400);
});

function closingInput(overrides = {}) {
  return { year: 2027, quarter: 1, balances: [{ bankId: 'bank-1', value: 900 }, { bankId: 'bank-2', value: 600 }], previousCash: 1000, previousDistribution: 100, distributionPct: 90, actualDistribution: 0, ...overrides };
}

test('saving a closing recomputes cash while partner payouts use the actual distribution', async t => {
  const { handler, database } = fixture();
  const request = await withServer(t, handler);
  const saved = await request('/api/closings', { method: 'POST', data: closingInput({ actualDistribution: 200, current_cash: 999999, rows: { generated_cash: 999999 } }) });
  assert.equal(saved.response.status, 201);
  const record = database.closings[0];
  assert.equal(record.current_cash, 1500);
  assert.equal(record.previous_distribution, 100);
  assert.equal(record.rows.previous_cash, 1000);
  assert.equal(record.rows.generated_cash, 600);
  assert.equal(record.rows.distribution_amount, 540);
  assert.equal(record.rows.reinvestment, 60);
  assert.deepEqual(record.rows.balances, { Itaú: 900, XP: 600 });
  assert.equal(record.rows.distribution_basis, 'actual_distribution');
  assert.equal(record.rows.partner_rows[0].bruto, 200);
  assert.equal(record.rows.partner_rows[0].complement, 100);
  assert.equal(record.rows.partner_rows[0].total, 270);
  assert.deepEqual(record.rows.partner_distribution, { baseDistribution: 200, totalComplement: 100, totalDiscount: 30, totalGross: 300, totalPayable: 270 });
  assert.deepEqual(record.rows.partner_parameters, [{ id: 'partner-1', name: 'Eduardo', share: 100, minimum: 100, discount: 10 }]);
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

test('recording an actual payout recalculates partners and preserves the imported financial data', async t => {
  const original = { id: 'closing-history', quarter: '2026 3º Trimestre', current_cash: 1500, previous_distribution: 1000, distribution_pct: 90, created_at: '2026-10-01', rows: { balances: { Itaú: 1000, XP: 500 }, actual_distribution: 0, source: 'original.xlsx', partner_rows: [{ name: 'Ana', total: 50 }] } };
  const { handler, database } = fixture({ initial: { closings: [original] } });
  const request = await withServer(t, handler);
  const saved = await request('/api/closings/closing-history', { method: 'PATCH', data: { actualDistribution: 350.55, current_cash: 0, quarter: '2027 1º Trimestre', rows: { balances: {} } } });
  assert.equal(saved.response.status, 200);
  const updated = database.closings[0];
  const { rows: originalRows, ...originalFields } = original;
  const { rows: updatedRows, ...updatedFields } = updated;
  assert.deepEqual(updatedFields, originalFields);
  assert.deepEqual(updatedRows.balances, originalRows.balances);
  assert.equal(updatedRows.source, originalRows.source);
  assert.equal(updatedRows.actual_distribution, 350.55);
  assert.equal(updatedRows.partner_rows[0].bruto, 350.55);
  assert.equal(updatedRows.partner_rows[0].total, 320.55);
  assert.equal(updatedRows.distribution_basis, 'actual_distribution');
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

test('minimum complements are extra company funds and do not reduce other partner shares', async t => {
  const partners = [
    { id: 'partner-a', name: 'A', share: 20, minimum: 100, discount: 10 },
    { id: 'partner-b', name: 'B', share: 80, minimum: 0, discount: 0 }
  ];
  const { handler, database } = fixture({ initial: { partners } });
  const request = await withServer(t, handler);
  const saved = await request('/api/closings', { method: 'POST', data: closingInput({ actualDistribution: 1000 }) });
  assert.equal(saved.response.status, 201);
  const payout = database.closings[0].rows;
  assert.deepEqual(payout.partner_rows.map(partner => [partner.bruto, partner.complement, partner.desconto, partner.total]), [[200, 100, 30, 270], [800, 0, 0, 800]]);
  assert.deepEqual(payout.partner_distribution, { baseDistribution: 1000, totalComplement: 100, totalDiscount: 30, totalGross: 1100, totalPayable: 1070 });
});

test('changing actual distribution uses saved partner parameters rather than later parameter edits', async t => {
  const parameters = [
    { id: 'partner-a', name: 'A', share: 70, minimum: 400, discount: 50 },
    { id: 'partner-b', name: 'B', share: 30, minimum: 0, discount: 0 }
  ];
  const closing = { id: 'saved', quarter: '2026 3º Trimestre', current_cash: 1500, previous_distribution: 1000, distribution_pct: 90, rows: { balances: { Itaú: 1000, XP: 500 }, actual_distribution: 0, partner_parameters: parameters, generated_cash: 600, distribution_amount: 540 } };
  const { handler, database } = fixture({ initial: { closings: [closing] } });
  const request = await withServer(t, handler);
  const saved = await request('/api/closings/saved', { method: 'PATCH', data: { actualDistribution: 1000 } });
  assert.equal(saved.response.status, 200);
  const payout = database.closings[0].rows;
  assert.deepEqual(payout.partner_parameters, parameters);
  assert.deepEqual(payout.partner_rows.map(partner => [partner.share, partner.bruto, partner.complement, partner.desconto, partner.total]), [[70, 700, 500, 150, 1050], [30, 300, 0, 0, 300]]);
  assert.equal(payout.partner_distribution.totalPayable, 1350);
  assert.deepEqual(payout.balances, closing.rows.balances);
  assert.equal(payout.generated_cash, 600);
  assert.equal(payout.distribution_amount, 540);
});

test('initial-password accounts can inspect their session but cannot access financial data before changing it', async t => {
  const { handler, calls } = fixture({ admin: false, mustChangePassword: true });
  const request = await withServer(t, handler);
  const session = await request('/api/session');
  assert.equal(session.response.status, 200);
  assert.equal(session.body.user.mustChangePassword, true);
  assert.equal(session.body.user.role, 'partner');
  const blocked = await request('/api/bootstrap');
  assert.equal(blocked.response.status, 403);
  assert.equal(blocked.body.code, 'PASSWORD_CHANGE_REQUIRED');
  assert.equal(calls.filter(call => call.url.pathname.startsWith('/rest/')).length, 0);
  assert.equal((await request('/api/closings', { method: 'POST', data: closingInput() })).response.status, 403);
});

test('changing the initial password unlocks only ordinary reader access', async t => {
  const { handler, authUsers, calls } = fixture({ admin: false, mustChangePassword: true });
  const request = await withServer(t, handler);
  assert.equal((await request('/api/password-change', { method: 'POST', data: { password: 'inepad123' } })).response.status, 400);
  assert.equal(authUsers[0].app_metadata.must_change_password, true);
  const changed = await request('/api/password-change', { method: 'POST', data: { password: 'new-personal-password' } });
  assert.equal(changed.response.status, 200);
  assert.equal(changed.body.user.mustChangePassword, false);
  assert.equal(authUsers[0].app_metadata.must_change_password, false);
  assert.equal(calls.some(call => call.url.pathname === '/auth/v1/user' && call.method === 'PUT'), true);
  assert.equal((await request('/api/bootstrap')).response.status, 200);
  assert.equal((await request('/api/closings', { method: 'POST', data: closingInput() })).response.status, 403);
  assert.equal((await request('/api/partners', { method: 'POST', data: {} })).response.status, 403);
});

test('partner creation requires e-mail and provisions a first-login account without storing passwords in financial data', async t => {
  const { handler, database, authUsers } = fixture({ initial: { partners: [] } });
  const request = await withServer(t, handler);
  const partner = { name: 'Novo sócio', share: 100, minimum: 1000, discount: 25 };
  assert.equal((await request('/api/partners', { method: 'POST', data: partner })).response.status, 400);
  const saved = await request('/api/partners', { method: 'POST', data: { ...partner, email: 'new@example.com' } });
  assert.equal(saved.response.status, 201);
  assert.equal(saved.body.email, 'new@example.com');
  const account = authUsers.find(user => user.email === 'new@example.com');
  assert.equal(account.password, 'inepad123');
  assert.equal(account.app_metadata.must_change_password, true);
  assert.equal(account.app_metadata.partner_id, database.partners[0].id);
  assert.equal(database.partners[0].password_hash, '!SUPABASE_AUTH_MANAGED!');
  const bootstrap = await request('/api/bootstrap');
  assert.equal(bootstrap.body.partners[0].email, 'new@example.com');
});

test('financial persistence failure compensates only the account created by that request', async t => {
  const { handler, database, authUsers } = fixture({ failPartnerWrite: true, initial: { partners: [] } });
  const request = await withServer(t, handler);
  const failed = await request('/api/partners', { method: 'POST', data: { name: 'Novo', email: 'new@example.com', share: 100, minimum: 0, discount: 0 } });
  assert.equal(failed.response.status, 502);
  assert.equal(database.partners.length, 0);
  assert.equal(authUsers.length, 1);
  assert.equal(authUsers[0].email, 'eduardo@example.com');
});
