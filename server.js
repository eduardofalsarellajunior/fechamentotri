'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createAccessService, emailAddress } = require('./lib/access.js');

const publicRoot = path.join(__dirname, 'public');
const partnerFields = 'id,name,share,minimum,discount';
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function json(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(payload));
}

async function readBody(req) {
  // Vercel may already have parsed the JSON body before invoking the handler.
  if (req.body !== undefined) {
    let parsed = req.body;
    try { if (typeof parsed === 'string') parsed = JSON.parse(parsed); } catch { throw new HttpError(400, 'Envie os dados em um formato válido.'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, 'Envie os dados em um formato válido.');
    if (Buffer.byteLength(JSON.stringify(parsed)) > 262144) throw new HttpError(413, 'Os dados enviados excedem o tamanho permitido.');
    return parsed;
  }
  let length = 0;
  const chunks = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 262144) throw new HttpError(413, 'Os dados enviados excedem o tamanho permitido.');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new HttpError(400, 'Envie os dados em um formato válido.');
  }
}

function text(value, label, maxLength = 120) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) {
    throw new HttpError(400, `Informe ${label} com até ${maxLength} caracteres.`);
  }
  return value.trim();
}

function number(value, label, { min = 0, max = 1e12, decimals = 2 } = {}) {
  if ((typeof value !== 'number' && typeof value !== 'string') || value === '' || String(value).trim() === '') {
    throw new HttpError(400, `Informe ${label}.`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new HttpError(400, `O valor de ${label} é inválido.`);
  }
  const scale = 10 ** decimals;
  if (Math.abs(parsed * scale - Math.round(parsed * scale)) > 0.001) {
    throw new HttpError(400, `Use até ${decimals} casas decimais em ${label}.`);
  }
  return Math.round(parsed * scale) / scale;
}

function normalizeName(name) {
  return String(name).trim().normalize('NFKC').toLocaleLowerCase('pt-BR');
}

function distributionSnapshot(actualDistribution, partners) {
  const { calculatePartnerDistribution } = require('./public/model.js');
  const parameters = partners.map(({ id, name, share, minimum, discount }) => ({
    id, name, share: Number(share), minimum: Number(minimum), discount: Number(discount)
  }));
  const distribution = calculatePartnerDistribution({ actualDistribution, partners: parameters });
  const { baseDistribution, totalComplement, totalDiscount, totalGross, totalPayable } = distribution;
  return {
    distribution_basis: 'actual_distribution',
    partner_parameters: parameters,
    partner_distribution: { baseDistribution, totalComplement, totalDiscount, totalGross, totalPayable },
    partner_rows: distribution.partnerRows
  };
}

function createHandler({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  function configuration() {
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new HttpError(503, 'O banco de dados ainda não está configurado.');
    }
    let base;
    try { base = new URL(env.SUPABASE_URL); } catch { throw new HttpError(503, 'A conexão com o banco precisa ser configurada.'); }
    if (base.protocol !== 'https:') throw new HttpError(503, 'A conexão segura com o banco precisa ser configurada.');
    return base.origin;
  }

  async function request(endpoint, options = {}) {
    const base = configuration();
    let response;
    try {
      response = await fetchImpl(base + endpoint, {
        ...options,
        signal: AbortSignal.timeout(20000),
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
          'Content-Type': 'application/json',
          ...options.headers
        }
      });
    } catch {
      throw new HttpError(503, 'Não foi possível conectar ao banco. Tente novamente em instantes.');
    }
    if (!response.ok) {
      const failure = await response.json().catch(() => ({}));
      if (failure.code === '23505') throw new HttpError(409, 'Este registro já existe. Atualize a página para conferi-lo.');
      if (['email_exists', 'user_already_exists'].includes(failure.code)) throw new HttpError(409, 'Este e-mail já está cadastrado. Confira os acessos existentes.');
      if (failure.code === 'weak_password') throw new HttpError(400, 'A senha não atende à política de segurança configurada no Supabase.');
      throw new HttpError(502, 'Não foi possível concluir a operação no banco de dados.');
    }
    if (response.status === 204) return null;
    return response.json().catch(() => null);
  }

  const access = createAccessService({ request, adminEmail: env.ADMIN_EMAIL });

  async function rows(table, fields = '*') {
    const all = [];
    // Explicit pages avoid silently dropping records at the PostgREST row limit.
    for (let offset = 0; ; offset += 500) {
      const page = await request(`/rest/v1/${table}?select=${fields}&order=id.asc&offset=${offset}&limit=500`);
      if (!Array.isArray(page)) throw new HttpError(502, 'A resposta do banco de dados é inválida.');
      all.push(...page);
      if (page.length < 500) return all;
    }
  }

  async function authenticate(req) {
    const bearer = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization || '');
    if (!bearer) throw new HttpError(401, 'Sua sessão terminou. Entre novamente para continuar.');
    const base = configuration();
    let response;
    try {
      response = await fetchImpl(base + '/auth/v1/user', {
        signal: AbortSignal.timeout(15000),
        headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + bearer[1] }
      });
    } catch {
      throw new HttpError(503, 'Não foi possível validar sua sessão. Tente novamente.');
    }
    if (response.status === 401 || response.status === 403) throw new HttpError(401, 'Sua sessão terminou. Entre novamente para continuar.');
    if (!response.ok) throw new HttpError(503, 'O serviço de acesso está temporariamente indisponível.');
    const account = await response.json();
    if (!account.id || !account.email || !account.email_confirmed_at) {
      throw new HttpError(401, 'Confirme seu e-mail para acessar o sistema.');
    }
    const isAdmin = Boolean(env.ADMIN_EMAIL) && account.email.trim().toLowerCase() === env.ADMIN_EMAIL.trim().toLowerCase();
    return { account, token: bearer[1], user: {
      id: account.id,
      name: isAdmin ? 'Eduardo' : (account.user_metadata?.full_name || account.email.split('@')[0]),
      email: account.email,
      role: isAdmin ? 'admin' : 'partner',
      mustChangePassword: Boolean(account.app_metadata?.must_change_password)
    } };
  }

  async function api(req, res, pathname) {
    if (req.method === 'GET' && pathname === '/api/config') {
      return json(res, 200, { url: env.SUPABASE_URL || '', anonKey: env.SUPABASE_ANON_KEY || '' });
    }
    const { user, account, token } = await authenticate(req);
    if (req.method === 'GET' && pathname === '/api/session') return json(res, 200, { user });
    if (req.method === 'POST' && pathname === '/api/password-change') {
      const body = await readBody(req);
      await access.changePassword({ account, token, password: body.password });
      return json(res, 200, { user: { ...user, mustChangePassword: false } });
    }
    if (user.mustChangePassword) throw new HttpError(403, 'Troque sua senha inicial antes de acessar o sistema.', 'PASSWORD_CHANGE_REQUIRED');
    if (req.method === 'GET' && pathname === '/api/bootstrap') {
      const [partners, banks, closings] = await Promise.all([
        rows('partners', partnerFields), rows('banks', 'id,name'), rows('closings')
      ]);
      const partnerRecords = user.role === 'admin' ? await access.emailsForPartners(partners) : partners;
      return json(res, 200, { user, partners: partnerRecords, banks, closings });
    }

    if (user.role !== 'admin') throw new HttpError(403, 'Somente o administrador pode alterar os dados.');

    if (req.method === 'POST' && pathname === '/api/banks') {
      const body = await readBody(req);
      const name = text(body.name, 'o nome da conta');
      const banks = await rows('banks', 'id,name');
      if (banks.some(bank => normalizeName(bank.name) === normalizeName(name))) throw new HttpError(409, 'Já existe uma conta com este nome.');
      const created = await request('/rest/v1/banks', {
        method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ name })
      });
      return json(res, 201, created[0]);
    }

    const bankRoute = /^\/api\/banks\/([\w-]+)$/.exec(pathname);
    if (req.method === 'DELETE' && bankRoute) {
      const deleted = await request(`/rest/v1/banks?id=eq.${encodeURIComponent(bankRoute[1])}`, {
        method: 'DELETE', headers: { Prefer: 'return=representation' }
      });
      if (!deleted?.length) throw new HttpError(404, 'Esta conta não foi encontrada.');
      // Closing snapshots retain bank names and balances after the active account is removed.
      return json(res, 200, { ok: true });
    }

    const partnerRoute = /^\/api\/partners\/([\w-]+)$/.exec(pathname);
    if ((req.method === 'POST' && pathname === '/api/partners') || (req.method === 'PUT' && partnerRoute)) {
      const body = await readBody(req);
      const email = emailAddress(body.email);
      const partner = {
        name: text(body.name, 'o nome do sócio'),
        share: number(body.share, 'participação', { max: 100, decimals: 4 }),
        minimum: number(body.minimum, 'mínimo mensal'),
        discount: number(body.discount, 'desconto mensal')
      };
      const partners = await rows('partners', partnerFields);
      const partnerId = partnerRoute?.[1];
      if (partnerId && !partners.some(item => item.id === partnerId)) throw new HttpError(404, 'Este sócio não foi encontrado.');
      const totalShare = partners.filter(item => item.id !== partnerId).reduce((sum, item) => sum + Number(item.share), partner.share);
      if (totalShare > 100.00001) throw new HttpError(400, 'A soma das participações não pode ultrapassar 100%.');
      const endpoint = '/rest/v1/partners' + (partnerId ? '?id=eq.' + encodeURIComponent(partnerId) : '');
      const persisted = partnerId ? partner : {
        ...partner, id: randomUUID(), role: 'partner', password_hash: '!SUPABASE_AUTH_MANAGED!'
      };
      const login = await access.provisionPartner({ ...partner, id: partnerId || persisted.id }, email);
      let created;
      try {
        created = await request(endpoint, {
          method: partnerId ? 'PATCH' : 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(persisted)
        });
      } catch (error) {
        try { await login.rollback(); } catch { throw new HttpError(502, 'Não foi possível concluir o cadastro e reverter o acesso. Contate o administrador.', 'ACCESS_ROLLBACK_FAILED'); }
        throw error;
      }
      const { id, name, share, minimum, discount } = created[0];
      return json(res, partnerId ? 200 : 201, { id, name, share, minimum, discount, email: login.email, accessCreated: true, mustChangePassword: login.mustChangePassword });
    }

    const closingRoute = /^\/api\/closings\/([\w-]+)$/.exec(pathname);
    if (req.method === 'PATCH' && closingRoute) {
      const body = await readBody(req);
      const actualDistribution = number(body.actualDistribution, 'distribuição efetivamente realizada');
      const endpoint = '/rest/v1/closings?id=eq.' + encodeURIComponent(closingRoute[1]);
      const existing = await request(endpoint + '&select=*');
      if (!existing?.length) throw new HttpError(404, 'Este fechamento não foi encontrado.');
      const snapshot = existing[0];
      const details = Array.isArray(snapshot.rows) ? { partner_rows: snapshot.rows } : (snapshot.rows || {});
      // Existing snapshots retain the parameters used for that closing. Imported
      // historical records do not have them and use the currently registered partners.
      const partners = Array.isArray(details.partner_parameters) && details.partner_parameters.length
        ? details.partner_parameters
        : await rows('partners', partnerFields);
      const distribution = distributionSnapshot(actualDistribution, partners);
      const updated = await request(endpoint, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ rows: { ...details, actual_distribution: actualDistribution, ...distribution } })
      });
      if (!updated?.length) throw new HttpError(404, 'Este fechamento não foi encontrado.');
      return json(res, 200, updated[0]);
    }

    if (req.method === 'POST' && pathname === '/api/closings') {
      const { calculateClosing, parsePeriod, normalizeClosing } = require('./public/model.js');
      const body = await readBody(req);
      const year = number(body.year, 'ano', { min: 2000, max: 2099, decimals: 0 });
      const quarter = number(body.quarter, 'trimestre', { min: 1, max: 4, decimals: 0 });
      const previousCash = number(body.previousCash, 'saldo do trimestre anterior', { min: -1e12 });
      const previousDistribution = number(body.previousDistribution, 'distribuição do trimestre anterior');
      const distributionPct = number(body.distributionPct, 'percentual de distribuição', { max: 100, decimals: 6 });
      const actualDistribution = number(body.actualDistribution, 'distribuição efetivamente realizada');
      const [banks, partners, closings] = await Promise.all([
        rows('banks', 'id,name'), rows('partners', partnerFields), rows('closings')
      ]);
      const periodKey = `${year}-Q${quarter}`;
      const existing = closings.filter(closing => parsePeriod(closing.rows?.period_key || closing.quarter)?.key === periodKey);
      if (existing.length > 1 || (existing.length === 1 && !normalizeClosing(existing[0]).pending)) {
        throw new HttpError(409, 'Já existe um fechamento para este trimestre. Consulte o histórico.');
      }
      if (!banks.length) throw new HttpError(400, 'Cadastre uma conta bancária antes de fechar o trimestre.');
      if (!Array.isArray(body.balances) || body.balances.length !== banks.length) {
        throw new HttpError(400, 'Informe o saldo de todas as contas cadastradas.');
      }
      const inputBalances = new Map();
      for (const input of body.balances) {
        if (!input || typeof input.bankId !== 'string' || inputBalances.has(input.bankId)) {
          throw new HttpError(400, 'Cada conta deve ser informada uma única vez.');
        }
        inputBalances.set(input.bankId, number(input.value, 'saldo da conta', { min: -1e12 }));
      }
      const bankBalances = banks.map(bank => {
        if (!inputBalances.has(bank.id)) throw new HttpError(400, 'A lista de contas mudou. Atualize a página e confira os saldos.');
        return { id: bank.id, name: bank.name, balance: inputBalances.get(bank.id) };
      });
      const totalShare = partners.reduce((sum, partner) => sum + Number(partner.share), 0);
      if (partners.length && Math.abs(totalShare - 100) > 0.00001) {
        throw new HttpError(400, 'A soma das participações dos sócios deve ser 100% para salvar o fechamento.');
      }
      const balances = Object.fromEntries(bankBalances.map(bank => [bank.name, bank.balance]));
      const result = calculateClosing({ balances: bankBalances.map(bank => bank.balance), previousCash, previousDistribution, distributionPct, partners });
      const distribution = distributionSnapshot(actualDistribution, partners);
      const closing = {
        quarter: `${year} ${quarter}º Trimestre`,
        current_cash: result.currentCash,
        previous_distribution: previousDistribution,
        distribution_pct: distributionPct,
        rows: {
          schemaVersion: 2,
          period_key: periodKey,
          balances,
          bank_balances: bankBalances,
          previous_cash: previousCash,
          previous_distribution: previousDistribution,
          actual_distribution: actualDistribution,
          generated_cash: result.generatedCash,
          distribution_amount: result.distributionAmount,
          reinvestment: result.reinvestment,
          ...distribution
        }
      };
      const endpoint = '/rest/v1/closings' + (existing.length ? '?id=eq.' + encodeURIComponent(existing[0].id) : '');
      const created = await request(endpoint, {
        method: existing.length ? 'PATCH' : 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(closing)
      });
      return json(res, existing.length ? 200 : 201, created[0]);
    }

    throw new HttpError(404, 'Esta operação não foi encontrada.');
  }

  return async function handler(req, res) {
    try {
      const parsed = new URL(req.url, 'http://localhost');
      const pathname = decodeURIComponent(parsed.pathname);
      if (pathname.startsWith('/api/')) return await api(req, res, pathname);
      if (!['GET', 'HEAD'].includes(req.method)) throw new HttpError(405, 'Método não permitido.');
      const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/public\//, '');
      if (pathname !== '/' && !pathname.startsWith('/public/')) throw new HttpError(404, 'Página não encontrada.');
      const filename = path.resolve(publicRoot, relative);
      if (!filename.startsWith(publicRoot + path.sep)) throw new HttpError(404, 'Página não encontrada.');
      let data;
      try { data = await fs.readFile(filename); } catch { throw new HttpError(404, 'Página não encontrada.'); }
      res.writeHead(200, {
        'Content-Type': mimeTypes[path.extname(filename)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'strict-origin-when-cross-origin'
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch (error) {
      if (!res.headersSent) {
        const status = error.status || (error instanceof URIError ? 400 : 500);
        json(res, status, { error: error.status ? error.message : 'Não foi possível concluir a operação. Tente novamente.', ...(error.code ? { code: error.code } : {}) });
      } else {
        res.end();
      }
    }
  };
}

const handler = createHandler();
if (require.main === module) {
  http.createServer(handler).listen(process.env.PORT || 3000, () => {
    console.log('Fechamento INEPAD: servidor iniciado na porta ' + (process.env.PORT || 3000));
  });
}
module.exports = handler;
module.exports.createHandler = createHandler;
