'use strict';

const INITIAL_PASSWORD = 'inepad123';

class AccessError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function emailAddress(value) {
  if (typeof value !== 'string' || value.trim().length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) {
    throw new AccessError(400, 'Informe um e-mail válido para o sócio.', 'INVALID_EMAIL');
  }
  return value.trim().toLowerCase();
}

function personalPassword(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128) {
    throw new AccessError(400, 'Sua senha pessoal deve ter entre 8 e 128 caracteres.', 'INVALID_PASSWORD');
  }
  if (value.trim().toLowerCase() === INITIAL_PASSWORD) {
    throw new AccessError(400, 'Escolha uma senha pessoal diferente da senha inicial.', 'INITIAL_PASSWORD_NOT_ALLOWED');
  }
  return value;
}

function createAccessService({ request, adminEmail = '' }) {
  const administrator = String(adminEmail).trim().toLowerCase();

  async function listUsers() {
    const all = [];
    for (let page = 1; ; page++) {
      const result = await request(`/auth/v1/admin/users?page=${page}&per_page=200`);
      if (!Array.isArray(result?.users)) throw new AccessError(502, 'Não foi possível consultar os acessos dos sócios.');
      all.push(...result.users);
      if (result.users.length < 200) return all;
    }
  }

  async function emailsForPartners(partners) {
    const users = await listUsers();
    return partners.map(partner => {
      const account = users.find(user => user.app_metadata?.partner_id === partner.id);
      return {
        ...partner,
        email: account?.email || '',
        accessCreated: Boolean(account),
        mustChangePassword: Boolean(account?.app_metadata?.must_change_password)
      };
    });
  }

  async function provisionPartner(partner, rawEmail) {
    const email = emailAddress(rawEmail);
    const users = await listUsers();
    const linked = users.find(account => account.app_metadata?.partner_id === partner.id);
    const matching = users.find(account => String(account.email).toLowerCase() === email);
    if (linked && matching && linked.id !== matching.id) {
      throw new AccessError(409, 'Este e-mail já pertence a outro usuário. Use o e-mail do sócio.', 'EMAIL_IN_USE');
    }
    if (matching?.app_metadata?.partner_id && matching.app_metadata.partner_id !== partner.id) {
      throw new AccessError(409, 'Este e-mail já está vinculado a outro sócio.', 'EMAIL_IN_USE');
    }
    if (linked && String(linked.email).toLowerCase() === administrator && email !== administrator) {
      throw new AccessError(400, 'O e-mail do administrador não pode ser alterado por este cadastro.', 'ADMIN_EMAIL_PROTECTED');
    }

    const current = linked || matching;
    let account;
    if (current) {
      const appMetadata = { ...current.app_metadata, partner_id: partner.id };
      // Updating a financial record never resets an existing user's password.
      if (email === administrator) appMetadata.must_change_password = false;
      const updated = await request('/auth/v1/admin/users/' + encodeURIComponent(current.id), {
        method: 'PUT',
        body: JSON.stringify({
          ...(String(current.email).toLowerCase() === email ? {} : { email, email_confirm: true }),
          app_metadata: appMetadata,
          user_metadata: { ...current.user_metadata, full_name: partner.name }
        })
      });
      account = updated?.user || updated;
    } else {
      const created = await request('/auth/v1/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          email,
          password: INITIAL_PASSWORD,
          email_confirm: true,
          app_metadata: { partner_id: partner.id, must_change_password: true },
          user_metadata: { full_name: partner.name }
        })
      });
      account = created?.user || created;
    }
    if (!account?.id) throw new AccessError(502, 'Não foi possível confirmar o acesso do sócio.');

    return {
      email,
      authUserId: account.id,
      created: !current,
      mustChangePassword: Boolean(account.app_metadata?.must_change_password),
      async rollback() {
        if (!current) {
          await request('/auth/v1/admin/users/' + encodeURIComponent(account.id), { method: 'DELETE' });
        } else {
          await request('/auth/v1/admin/users/' + encodeURIComponent(current.id), {
            method: 'PUT',
            body: JSON.stringify({
              ...(String(current.email).toLowerCase() === email ? {} : { email: current.email, email_confirm: true }),
              app_metadata: { ...current.app_metadata, partner_id: current.app_metadata?.partner_id ?? null, must_change_password: current.app_metadata?.must_change_password ?? false },
              user_metadata: { ...current.user_metadata, full_name: current.user_metadata?.full_name ?? null }
            })
          });
        }
      }
    };
  }

  async function changePassword({ account, token, password }) {
    personalPassword(password);
    await request('/auth/v1/user', {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + token },
      body: JSON.stringify({ password })
    });
    // Only a successful authenticated password update can clear the server-owned flag.
    await request('/auth/v1/admin/users/' + encodeURIComponent(account.id), {
      method: 'PUT',
      body: JSON.stringify({ app_metadata: { ...account.app_metadata, must_change_password: false } })
    });
  }

  return { listUsers, emailsForPartners, provisionPartner, changePassword };
}

module.exports = { INITIAL_PASSWORD, AccessError, emailAddress, personalPassword, createAccessService };
