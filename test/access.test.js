'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAccessService, emailAddress, personalPassword } = require('../lib/access');

function fixture(initial = []) {
  const users = structuredClone(initial);
  const calls = [];
  let failUserPassword = false;
  const request = async (endpoint, options = {}) => {
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ endpoint, method, body, headers: options.headers });
    if (endpoint.startsWith('/auth/v1/admin/users?')) return { users: structuredClone(users) };
    if (endpoint === '/auth/v1/user') {
      if (failUserPassword) throw new Error('password update failed');
      return { id: 'account-1' };
    }
    if (endpoint === '/auth/v1/admin/users' && method === 'POST') {
      const created = { id: 'new-account', ...body };
      users.push(created);
      return created;
    }
    const id = endpoint.split('/').pop();
    const index = users.findIndex(user => user.id === id);
    if (method === 'DELETE') { users.splice(index, 1); return null; }
    if (method === 'PUT') {
      users[index] = { ...users[index], ...body,
        app_metadata: { ...users[index].app_metadata, ...body.app_metadata },
        user_metadata: { ...users[index].user_metadata, ...body.user_metadata }
      };
      return structuredClone(users[index]);
    }
    throw new Error('unexpected request ' + endpoint);
  };
  return { service: createAccessService({ request, adminEmail: 'eduardo@example.com' }), users, calls, failPassword: () => { failUserPassword = true; } };
}

test('partner email is required, trimmed and normalized', () => {
  assert.equal(emailAddress('  Reader@Example.com '), 'reader@example.com');
  for (const email of ['', null, undefined, 'invalid', 'invalid@', 'two @example.com']) assert.throws(() => emailAddress(email));
});

test('new partner gets a confirmed read-only account and a server-owned password-change requirement', async () => {
  const { service, users } = fixture();
  const result = await service.provisionPartner({ id: 'partner-1', name: 'Partner One' }, 'reader@example.com');
  assert.equal(result.created, true);
  assert.equal(result.mustChangePassword, true);
  assert.equal(users[0].password, 'inepad123');
  assert.equal(users[0].email_confirm, true);
  assert.deepEqual(users[0].app_metadata, { partner_id: 'partner-1', must_change_password: true });
  assert.equal(users[0].role, undefined);
  await result.rollback();
  assert.equal(users.length, 0);
});

test('existing administrator retains personal password and is never reset to the initial password', async () => {
  const original = { id: 'admin', email: 'eduardo@example.com', password: 'preserved-existing-password', app_metadata: { provider: 'email' } };
  const { service, users, calls } = fixture([original]);
  const result = await service.provisionPartner({ id: 'partner-eduardo', name: 'Eduardo' }, 'eduardo@example.com');
  assert.equal(result.created, false);
  assert.equal(users[0].password, original.password);
  assert.equal(result.mustChangePassword, false);
  assert.ok(calls.filter(call => call.method === 'PUT').every(call => !call.body.password));
});

test('another partner cannot reuse an e-mail associated with a different partner', async () => {
  const { service, calls } = fixture([{ id: 'a', email: 'same@example.com', app_metadata: { partner_id: 'other-partner' } }]);
  await assert.rejects(() => service.provisionPartner({ id: 'partner-1', name: 'A' }, 'same@example.com'), { status: 409 });
  assert.equal(calls.filter(call => call.method !== 'GET').length, 0);
});

test('updating an existing partner e-mail preserves their password and authoritative access flags', async () => {
  const { service, users } = fixture([{ id: 'a', email: 'old@example.com', password: 'personal', app_metadata: { partner_id: 'partner-1', must_change_password: false } }]);
  const result = await service.provisionPartner({ id: 'partner-1', name: 'Partner' }, 'new@example.com');
  assert.equal(users[0].email, 'new@example.com');
  assert.equal(users[0].password, 'personal');
  assert.equal(result.mustChangePassword, false);
});

test('compensation unlinks an existing account when financial persistence fails', async () => {
  const { service, users } = fixture([{ id: 'a', email: 'reader@example.com', app_metadata: { provider: 'email' }, user_metadata: {} }]);
  const result = await service.provisionPartner({ id: 'partner-1', name: 'Partner' }, 'reader@example.com');
  assert.equal(users[0].app_metadata.partner_id, 'partner-1');
  await result.rollback();
  assert.equal(users[0].app_metadata.partner_id, null);
  assert.equal(users[0].app_metadata.provider, 'email');
});

test('first password change must use the user session and only then clear the requirement', async () => {
  const account = { id: 'account-1', app_metadata: { partner_id: 'partner-1', must_change_password: true } };
  const { service, calls, users } = fixture([account]);
  await service.changePassword({ account, token: 'user-token', password: 'personal-password-123' });
  assert.equal(calls[0].endpoint, '/auth/v1/user');
  assert.equal(calls[0].headers.Authorization, 'Bearer user-token');
  assert.equal(calls[1].body.app_metadata.must_change_password, false);
  assert.equal(users[0].app_metadata.must_change_password, false);
});

test('a failed personal password update does not clear first-login protection', async () => {
  const account = { id: 'account-1', app_metadata: { must_change_password: true } };
  const { service, users, calls, failPassword } = fixture([account]);
  failPassword();
  await assert.rejects(() => service.changePassword({ account, token: 'user-token', password: 'personal-password-123' }));
  assert.equal(users[0].app_metadata.must_change_password, true);
  assert.equal(calls.length, 1);
});

test('the default password and weak values cannot complete a first password change', () => {
  for (const password of ['inepad123', ' INEPAD123 ', '', 'short', undefined]) assert.throws(() => personalPassword(password));
});
