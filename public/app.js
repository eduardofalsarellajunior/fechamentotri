'use strict';

const $ = id => document.getElementById(id);
const {roundMoney, normalizeClosing, calculateClosing, calculatePartnerDistribution} = window.INEPADModel;
const currency = new Intl.NumberFormat('pt-BR', {style: 'currency', currency: 'BRL'});
const money = value => value == null ? '—' : currency.format(Number(value));
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[char]));
let state = {banks: [], partners: [], closings: []};
let session = null, authClient = null, authMode = 'login', records = [], saving = false, refreshId = 0;
let recoveryMode = location.hash.includes('type=recovery');

function message(id, text = '', success = false) {
  const element = $(id);
  element.textContent = text;
  element.classList.toggle('message-success', success);
  element.hidden = !text;
}

function toast(text) {
  $('toast').textContent = text;
  $('toast').classList.add('is-visible');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => $('toast').classList.remove('is-visible'), 4500);
}

function errorText(error) {
  const text = error?.message || 'Não foi possível concluir. Tente novamente.';
  if (/invalid login credentials/i.test(text)) return 'E-mail ou senha incorretos. Confira os dados ou recupere sua senha.';
  if (/email not confirmed/i.test(text)) return 'Confirme seu e-mail para acessar o sistema.';
  if (/rate limit|too many requests|security purposes/i.test(text)) return 'Aguarde alguns minutos antes de tentar novamente.';
  if (/same password/i.test(text)) return 'Escolha uma senha diferente da senha atual.';
  if (/fetch|network/i.test(text)) return 'Não foi possível conectar. Verifique sua conexão e tente novamente.';
  return text;
}

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {...options, headers: {'Content-Type': 'application/json', ...(session ? {Authorization: `Bearer ${session.access_token}`} : {}), ...options.headers}});
  let data;
  try { data = await response.json(); } catch { throw new Error('O servidor não respondeu como esperado. Tente novamente.'); }
  if (!response.ok) {
    if (response.status === 401) showAuth('login');
    if (response.status === 403 && data.code === 'PASSWORD_CHANGE_REQUIRED') showAuth('firstAccess');
    throw new Error(data.error || 'Não foi possível concluir a operação.');
  }
  return data;
}

function showAuth(mode = 'login') {
  authMode = mode;
  $('authScreen').hidden = false; $('appShell').hidden = true;
  const changingPassword = mode === 'reset' || mode === 'firstAccess';
  $('email').closest('.field').hidden = changingPassword; $('email').required = !changingPassword;
  $('passwordField').hidden = mode === 'recovery'; $('password').required = mode !== 'recovery';
  $('password').autocomplete = changingPassword ? 'new-password' : 'current-password';
  $('password').minLength = changingPassword ? 8 : 1;
  $('passwordConfirmField').hidden = !changingPassword; $('passwordConfirm').required = changingPassword;
  $('showRecovery').hidden = mode !== 'login'; $('showLogin').hidden = mode === 'login';
  $('showLogin').textContent = mode === 'firstAccess' ? 'Sair e usar outra conta' : 'Voltar para o acesso';
  const content = {
    login: ['Bem-vindo de volta', 'Acesse os fechamentos e acompanhe a evolução do caixa.', 'Entrar na plataforma'],
    recovery: ['Recuperar acesso', 'Informe seu e-mail para receber um link de redefinição de senha.', 'Enviar link de recuperação'],
    reset: ['Crie uma nova senha', 'Use pelo menos 8 caracteres e escolha uma senha que você ainda não utilizou.', 'Salvar nova senha'],
    firstAccess: ['Defina sua senha pessoal', 'Este é seu primeiro acesso. Troque a senha temporária por uma senha pessoal com pelo menos 8 caracteres para continuar.', 'Salvar senha e acessar'],
  }[mode];
  $('authTitle').textContent = content[0]; $('authDescription').textContent = content[1]; $('authSubmit').textContent = content[2];
  message('authMessage');
}

function normalizeHistory() {
  records = state.closings.map(normalizeClosing).sort((a, b) => (a.period?.order || 0) - (b.period?.order || 0));
  const byPeriod = new Map(records.filter(c => c.period).map(c => [c.period.order, c]));
  records = records.map(record => {
    const previous = byPeriod.get(record.period?.order - 1);
    if (record.previousDistribution == null && previous && !previous.pending) record.previousDistribution = previous.actualDistribution;
    if (record.generatedCash == null && record.previousDistribution != null && !record.pending) record.generatedCash = roundMoney(record.currentCash - record.previousCash + record.previousDistribution);
    const savedParameters = record.rows?.distribution_basis === 'actual_distribution' && record.rows?.partner_parameters?.length ? record.rows.partner_parameters : null;
    const partners = savedParameters || state.partners;
    record.partnerRows = [];
    if (!record.pending && record.actualDistribution != null && partners.length) {
      record.partnerDistribution = calculatePartnerDistribution({actualDistribution: record.actualDistribution, partners});
      record.partnerRows = record.partnerDistribution.partnerRows;
      record.distributionSaved = Boolean(savedParameters);
    }
    return record;
  });
}

async function load() {
  const id = ++refreshId;
  const access = await api('/session');
  if (access.user.mustChangePassword) { showAuth('firstAccess'); return; }
  const data = await api('/bootstrap');
  if (id !== refreshId) return;
  state = data; normalizeHistory();
  $('authScreen').hidden = true; $('appShell').hidden = false;
  $('userName').textContent = state.user.name || state.user.email;
  $('userRole').textContent = state.user.role === 'admin' ? 'Administrador' : 'Acesso aos relatórios';
  document.querySelectorAll('.adminOnly').forEach(element => { element.hidden = state.user.role !== 'admin'; });
  renderOverview(); renderSettings();
}

function setPage(page) {
  if (page === 'settings' && state.user.role !== 'admin') return;
  $('overviewPage').hidden = page !== 'overview'; $('settingsPage').hidden = page !== 'settings';
  $('pageTitle').textContent = page === 'overview' ? 'Fechamento de caixa' : 'Parametrização';
  $('pageSubtitle').textContent = page === 'overview' ? 'Uma visão clara do caixa, da distribuição e de cada trimestre.' : 'Organize as contas e os parâmetros de distribuição dos sócios.';
  if ($('breadcrumbCurrent')) $('breadcrumbCurrent').textContent = page === 'overview' ? 'Visão geral' : 'Parametrização';
  document.querySelectorAll('[data-page]').forEach(button => {
    const active = button.dataset.page === page;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  });
}

function renderOverview() {
  const completed = records.filter(record => !record.pending), latest = completed.at(-1);
  $('latestCash').textContent = latest ? money(latest.currentCash) : '—';
  $('latestPeriod').textContent = latest?.period?.label || 'Aguardando o primeiro fechamento';
  $('latestDistribution').textContent = latest ? money(latest.actualDistribution) : '—';
  $('latestDistributionPeriod').textContent = latest?.period?.label || 'Nenhuma distribuição registrada';
  $('historyCount').textContent = String(completed.length); $('bankCount').textContent = String(state.banks.length);
  const selectedYear = $('historyYear').value;
  $('historyYear').innerHTML = '<option value="">Todos os anos</option>' + [...new Set(records.map(c => c.period?.year).filter(Boolean))].sort((a, b) => b - a).map(year => `<option value="${year}">${year}</option>`).join('');
  $('historyYear').value = selectedYear;
  renderChart(completed); renderHistory();
}

function renderChart(completed) {
  const compact = window.matchMedia('(max-width: 640px)').matches;
  const data = completed.slice(compact ? -4 : -8);
  if (!data.length) { $('cashChart').innerHTML = '<div class="empty-state"><strong>Seu histórico começa aqui</strong><p>Os próximos fechamentos mostrarão a evolução do caixa.</p></div>'; return; }
  const maximum = Math.max(...data.map(c => c.currentCash), 1);
  const chartMoney = value => compact ? new Intl.NumberFormat('pt-BR', {style: 'currency', currency: 'BRL', notation: 'compact', maximumFractionDigits: 2}).format(value) : money(value);
  $('cashChart').innerHTML = `<div class="chart-bars" role="img" aria-label="Evolução do caixa nos últimos ${data.length} trimestres">${data.map((record, index) => `<div class="chart-column"><div class="chart-value" title="${esc(money(record.currentCash))}">${esc(chartMoney(record.currentCash))}</div><div class="chart-track"><div class="chart-bar${index === data.length - 1 ? ' is-latest' : ''}" style="height:${Math.max(2, record.currentCash / maximum * 100)}%"><span class="sr-only">${esc(record.period?.label)}: ${esc(money(record.currentCash))}</span></div></div><span class="chart-label">${record.period?.quarter}T <span>${record.period?.year}</span></span></div>`).join('')}</div>`;
}

function renderHistory() {
  const query = $('historySearch').value.trim().toLocaleLowerCase('pt-BR'), year = $('historyYear').value;
  const filtered = records.filter(record => (!year || String(record.period?.year) === year) && (!query || `${record.quarter} ${record.period?.label}`.toLocaleLowerCase('pt-BR').includes(query))).reverse();
  $('historyEmpty').hidden = Boolean(filtered.length);
  $('historySummary').textContent = `${filtered.length} ${filtered.length === 1 ? 'trimestre' : 'trimestres'} · Clique no caixa apurado para ver as contas.`;
  $('historyBody').innerHTML = filtered.map(record => {
    const id = esc(record.id);
    return `<tr class="${record.pending ? 'is-pending' : ''}">
      <td><strong>${record.period ? `${record.period.quarter}º trimestre` : esc(record.quarter)}</strong><span class="period-year">${record.period?.year || ''}</span>${record.pending ? '<span class="badge badge-neutral">A preencher</span>' : ''}</td>
      <td><button type="button" class="history-toggle" data-expand="${id}" aria-expanded="false" aria-controls="details-${id}" aria-label="Abrir contas de ${esc(record.period?.label || record.quarter)}"><span class="toggle-symbol" aria-hidden="true">+</span><span class="amount">${record.pending ? 'Sem saldos' : money(record.currentCash)}</span></button></td>
      <td class="amount">${record.pending ? '—' : money(record.previousDistribution)}</td>
      <td class="amount ${record.generatedCash < 0 ? 'negative' : ''}">${record.pending ? '—' : money(record.generatedCash)}</td>
      <td class="amount">${record.pending ? '—' : money(record.actualDistribution)}</td>
      <td><span class="badge badge-neutral">${record.pending || (record === records[0] && !record.distributionPct) ? '—' : `${new Intl.NumberFormat('pt-BR', {maximumFractionDigits: 2}).format(record.distributionPct)}%`}</span></td>
      <td><button class="icon-button" data-expand="${id}" type="button" aria-expanded="false" aria-controls="details-${id}" aria-label="Ver detalhes de ${esc(record.period?.label || record.quarter)}"><svg class="icon" aria-hidden="true"><use href="#icon-chevron"/></svg></button></td>
    </tr><tr class="detail-row" id="details-${id}" hidden><td colspan="7">${renderBreakdown(record)}</td></tr>`;
  }).join('');
}

function renderBreakdownContent(record) {
  const balances = Object.entries(record.balances), rows = record.partnerRows || [];
  return `<div class="breakdown-panel">
    <div class="breakdown-grid">
      <div><p class="eyebrow">Composição do caixa</p><h3>${esc(record.period?.label || record.quarter)}</h3>
        <div class="account-breakdown">${balances.length ? balances.map(([name, value]) => `<div class="account-row"><span>${esc(name)}</span><b class="amount">${record.pending ? '—' : money(value)}</b></div>`).join('') : '<p class="muted">Este fechamento não contém saldos por conta.</p>'}
          <div class="account-row account-total"><strong>Caixa apurado</strong><strong class="amount">${record.pending ? '—' : money(record.currentCash)}</strong></div>
        </div>
      </div>
      <div class="calculation-explainer"><p class="eyebrow">Memória de cálculo</p>
        <div class="formula-line"><span>Caixa apurado</span><b>${record.pending ? '—' : money(record.currentCash)}</b></div>
        <div class="formula-line"><span>− Caixa do trimestre anterior</span><b>${record.pending ? '—' : money(record.previousCash)}</b></div>
        <div class="formula-line"><span>+ Distribuição efetiva anterior</span><b>${record.pending ? '—' : money(record.previousDistribution)}</b></div>
        <div class="formula-line preview-total"><strong>Caixa gerado</strong><strong>${record.pending ? '—' : money(record.generatedCash)}</strong></div>
        <p class="muted">${record.pending ? 'Período reservado na planilha. Informe os saldos no novo fechamento.' : record.rows?.schemaVersion === 2 ? 'Calculado com os saldos e a distribuição do período anterior.' : 'Cálculo reconstituído dos saldos históricos. Os pagamentos efetivos são os registrados na planilha.'}</p>
      </div>
    </div>
    ${rows.length ? `<div class="distribution-detail"><h3>Distribuição por sócio</h3>${distributionSummary(record.partnerDistribution, record.distributionSaved)}${partnerTable(rows)}</div>` : '<p class="muted history-note">Cadastre os sócios para calcular o rateio a partir da distribuição efetiva deste trimestre.</p>'}
  </div>`;
}

function renderBreakdown(record) {
  const content = renderBreakdownContent(record);
  if (record.pending || state.user.role !== 'admin') return content;
  return content + `<form class="history-payment" data-payment-id="${esc(record.id)}"><div class="field"><label for="payment-${esc(record.id)}">Atualizar distribuição efetiva</label><input id="payment-${esc(record.id)}" name="actualDistribution" type="number" inputmode="decimal" min="0" step="0.01" value="${Number(record.actualDistribution || 0).toFixed(2)}" required></div><button type="submit" class="button button-secondary">Salvar pagamento</button><p class="muted">Atualize o total após o pagamento. Os saldos bancários deste fechamento são preservados.</p><p class="form-message" role="status" hidden></p></form>`;
}

function partnerTable(rows) {
  return `<div class="table-scroll"><table><thead><tr><th>Sócio</th><th>Participação</th><th>Base proporcional</th><th>Mínimo trimestral</th><th>Extra do INEPAD</th><th>Desconto trimestral</th><th>Total líquido</th></tr></thead><tbody>${rows.map(partner => `<tr><td>${esc(partner.name)}</td><td>${Number(partner.share)}%</td><td class="amount">${money(partner.bruto)}</td><td class="amount">${money(partner.minimumQuarterly)}</td><td class="amount">${money(partner.complement)}</td><td class="amount">${money(partner.desconto)}</td><td class="amount"><strong>${money(partner.total)}</strong></td></tr>`).join('')}</tbody></table></div>`;
}

function distributionSummary(distribution, saved = false) {
  return `<div class="distribution-totals"><div><span>Distribuição efetiva usada no rateio</span><strong>${money(distribution.baseDistribution)}</strong></div><div><span>Complemento extra do INEPAD</span><strong>${money(distribution.totalComplement)}</strong></div><div><span>Total bruto com complementos</span><strong>${money(distribution.totalGross)}</strong></div><div><span>Descontos trimestrais</span><strong>${money(distribution.totalDiscount)}</strong></div><div class="net-distribution"><span>Total líquido aos sócios</span><strong>${money(distribution.totalPayable)}</strong></div></div><p class="muted distribution-note">Mínimo mensal × 3 e desconto mensal × 3. O complemento é pago como extra pelo INEPAD e não reduz a parcela dos demais sócios. ${saved ? 'Parâmetros registrados neste fechamento.' : 'Rateio calculado com os parâmetros atuais dos sócios.'}</p>`;
}

function beginClosing() {
  setPage('overview');
  const latest = records.filter(c => !c.pending).at(-1);
  const pending = records.find(c => c.pending && (!latest || c.period?.order > latest.period?.order));
  const now = new Date();
  const next = pending?.period || (latest?.period ? {year: latest.period.year + (latest.period.quarter === 4 ? 1 : 0), quarter: latest.period.quarter % 4 + 1} : {year: now.getFullYear(), quarter: Math.floor(now.getMonth() / 3) + 1});
  const years = new Set([next.year, now.getFullYear(), ...records.map(c => c.period?.year).filter(Boolean)]);
  $('closingYear').innerHTML = [...years, Math.max(...years) + 1].sort((a, b) => b - a).map(y => `<option value="${y}">${y}</option>`).join('');
  $('closingYear').value = String(next.year); $('closingQuarter').value = String(next.quarter);
  $('distributionPct').value = '90'; $('actualDistribution').value = '0';
  renderBankFields(); updatePreviousPeriod();
  $('closingEditor').hidden = false; $('newClosingButton').hidden = true;
  message('closingMessage');
  $('closingEditor').scrollIntoView({behavior: 'smooth', block: 'start'}); $('closingQuarter').focus({preventScroll: true});
}

function renderBankFields(preserve = false) {
  const values = preserve ? new Map([...document.querySelectorAll('[data-bank-id]')].map(input => [input.dataset.bankId, input.value])) : new Map();
  $('bankFields').innerHTML = state.banks.length ? state.banks.map(bank => `<label class="account-field"><span><span class="bank-initial" aria-hidden="true">${esc(bank.name.slice(0, 1))}</span>${esc(bank.name)}</span><span class="currency-input"><span aria-hidden="true">R$</span><input data-bank-id="${esc(bank.id)}" name="bank-${esc(bank.id)}" type="number" inputmode="decimal" step="0.01" required placeholder="0,00" aria-label="Saldo de ${esc(bank.name)}" value="${esc(values.get(bank.id) || '')}"></span></label>`).join('') : '<div class="empty-state"><strong>Cadastre sua primeira conta</strong><p>Adicione as contas em Parametrização antes de registrar o fechamento.</p></div>';
}

function updatePreviousPeriod() {
  const order = Number($('closingYear').value) * 4 + Number($('closingQuarter').value);
  const previous = records.find(c => c.period?.order === order - 1 && !c.pending);
  $('previousCash').value = previous ? previous.currentCash.toFixed(2) : '0.00';
  $('previousDistribution').value = previous?.actualDistribution != null ? previous.actualDistribution.toFixed(2) : '0.00';
  updatePreview();
}

function closingValues() {
  return {year: Number($('closingYear').value), quarter: Number($('closingQuarter').value), balances: [...document.querySelectorAll('[data-bank-id]')].map(input => ({bankId: input.dataset.bankId, value: Number(input.value)})), previousCash: Number($('previousCash').value), previousDistribution: Number($('previousDistribution').value), distributionPct: Number($('distributionPct').value), actualDistribution: $('actualDistribution').value === '' ? null : Number($('actualDistribution').value)};
}

function updatePreview() {
  const values = closingValues();
  const effective = calculatePartnerDistribution({actualDistribution: values.actualDistribution ?? 0, partners: state.partners});
  const result = {...calculateClosing({...values, balances: values.balances.map(b => b.value), partners: state.partners}), totalComplement: effective.totalComplement, totalPayable: effective.totalPayable};
  const share = roundMoney(state.partners.reduce((sum, p) => sum + Number(p.share), 0));
  const entered = [...document.querySelectorAll('[data-bank-id]')].filter(input => input.value !== '').length;
  $('closingPreview').innerHTML = `<div class="preview-heading"><p class="eyebrow">Prévia do fechamento</p><span class="badge badge-neutral">${entered}/${state.banks.length} contas preenchidas</span></div><div class="formula-line"><span>Soma das contas</span><b>${money(result.currentCash)}</b></div><div class="formula-line"><span>− Caixa anterior</span><b>${money(values.previousCash)}</b></div><div class="formula-line"><span>+ Distribuição anterior</span><b>${money(values.previousDistribution)}</b></div><div class="formula-line preview-total"><strong>Caixa gerado</strong><strong>${money(result.generatedCash)}</strong></div><div class="preview-stat"><span>Distribuição · ${values.distributionPct}%</span><strong>${money(result.distributionAmount)}</strong></div><div class="preview-stat"><span>${result.reinvestment < 0 ? 'Variação negativa do caixa' : 'Reinvestimento'}</span><strong>${money(result.reinvestment)}</strong></div>${result.totalComplement ? `<div class="formula-line"><span>Complementos mínimos</span><b>${money(result.totalComplement)}</b></div>` : ''}${state.partners.length ? `<div class="formula-line"><span>Total líquido aos sócios</span><b>${money(result.totalPayable)}</b></div>` : ''}${!state.partners.length ? '<p class="muted">Cadastre os sócios para calcular o rateio individual.</p>' : share !== 100 ? `<p class="field-error">As participações somam ${share}%. Ajuste para 100% em Parametrização antes de salvar.</p>` : ''}`;
  $('distributionRows').innerHTML = effective.partnerRows.length ? `${distributionSummary(effective)}${partnerTable(effective.partnerRows)}` : '<p class="empty-state">Cadastre os sócios em Parametrização para visualizar o rateio. Você pode salvar os saldos e a distribuição total enquanto isso.</p>';
  $('saveClosing').disabled = saving || !state.banks.length || (state.partners.length > 0 && share !== 100);
}

async function saveClosing(event) {
  event.preventDefault();
  if (!$('closingForm').reportValidity() || saving) return;
  const values = closingValues();
  if (values.actualDistribution == null) return message('closingMessage', 'Informe o valor efetivamente distribuído. Use zero se ainda não houve pagamento.');
  saving = true; $('saveClosing').disabled = true; $('saveClosing').textContent = 'Salvando…'; message('closingMessage');
  try {
    await api('/closings', {method: 'POST', body: JSON.stringify(values)}); await load();
    $('closingEditor').hidden = true; $('newClosingButton').hidden = false;
    $('historyYear').value = String(values.year); $('historySearch').value = ''; renderHistory();
    toast('Fechamento salvo. Os saldos e o rateio já estão no histórico.');
  } catch (error) { message('closingMessage', errorText(error)); }
  finally { saving = false; $('saveClosing').textContent = 'Salvar fechamento'; updatePreview(); }
}

function renderSettings() {
  $('banksList').innerHTML = state.banks.length ? state.banks.map(bank => `<div class="bank-item"><span class="bank-initial" aria-hidden="true">${esc(bank.name.slice(0, 1))}</span><div><strong>${esc(bank.name)}</strong><p class="muted">Disponível para os próximos fechamentos</p></div><button class="icon-button delete-button" data-delete-bank="${esc(bank.id)}" type="button" aria-label="Excluir conta ${esc(bank.name)}"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M3 6h18M9 6V4h6v2M6 6l1 14h10l1-14M10 10v6M14 10v6"/></svg></button></div>`).join('') : '<div class="empty-state"><strong>Nenhuma conta cadastrada</strong><p>Adicione as contas que compõem o caixa do INEPAD.</p></div>';
  $('partnersList').innerHTML = state.partners.length ? state.partners.map(partner => `
    <div class="partner-item"><div class="partner-top"><div><strong>${esc(partner.name)}</strong><span class="partner-email">${partner.email ? esc(partner.email) : '<span class="badge badge-neutral">E-mail pendente</span>'}</span>${partner.mustChangePassword ? '<span class="badge badge-neutral">Troca de senha no primeiro acesso</span>' : ''}</div><button type="button" class="small-button" data-edit-partner="${esc(partner.id)}">Editar</button></div>
      <div class="partner-facts"><span>Participação<b>${Number(partner.share)}%</b></span><span>Mínimo mensal<b>${money(partner.minimum)}</b></span><span>Desconto mensal<b>${money(partner.discount)}</b></span></div>
    </div>`).join('') : '<div class="empty-state"><strong>Quem participa da distribuição?</strong><p>Cadastre os sócios e suas participações para calcular os próximos fechamentos.</p></div>';
  const total = roundMoney(state.partners.reduce((sum, partner) => sum + Number(partner.share), 0));
  if ($('shareTotal')) { $('shareTotal').textContent = `${total}% de 100% cadastrados`; $('shareTotal').classList.toggle('negative', total !== 100); }
  if (!$('closingEditor').hidden) { renderBankFields(true); updatePreview(); }
}

function editPartner(id) {
  const partner = state.partners.find(p => p.id === id);
  if (!partner) return;
  $('partnerEmail').value = partner.email || '';
  $('partnerId').value = id; $('partnerName').value = partner.name; $('partnerShare').value = partner.share; $('partnerMinimum').value = partner.minimum; $('partnerDiscount').value = partner.discount;
  $('cancelPartnerEdit').hidden = false; $('partnerForm').querySelector('[type="submit"]').textContent = 'Salvar alterações'; $('partnerName').focus();
}

function resetPartnerForm() {
  $('partnerForm').reset(); $('partnerId').value = ''; $('cancelPartnerEdit').hidden = true; $('partnerForm').querySelector('[type="submit"]').textContent = 'Adicionar sócio';
}

function confirmAction(title, description) {
  return new Promise(resolve => {
    const dialog = $('confirmDialog'); $('confirmTitle').textContent = title; $('confirmDescription').textContent = description;
    const done = result => { dialog.close(); dialog.oncancel = null; $('confirmAccept').onclick = null; $('confirmCancel').onclick = null; resolve(result); };
    $('confirmAccept').onclick = () => done(true); $('confirmCancel').onclick = () => done(false);
    dialog.oncancel = event => { event.preventDefault(); done(false); };
    dialog.showModal(); $('confirmCancel').focus();
  });
}

function exportHistory() {
  const names = [...new Set(records.flatMap(record => Object.keys(record.balances)))];
  const headers = ['Ano', 'Trimestre', 'Caixa apurado', 'Distribuição anterior', 'Caixa gerado', 'Distribuição efetiva', 'Percentual', ...names];
  const data = records.map(record => [record.period?.year, record.period?.quarter, record.pending ? '' : record.currentCash, record.previousDistribution, record.pending ? '' : record.generatedCash, record.pending ? '' : record.actualDistribution, record.distributionPct, ...names.map(name => record.pending ? '' : record.balances[name] ?? '')]);
  const cell = value => { const text = typeof value === 'number' ? String(value).replace('.', ',') : String(value ?? ''); return `"${(/^[=+@\-]/.test(text) && typeof value !== 'number' ? "'" + text : text).replace(/"/g, '""')}"`; };
  const blob = new Blob(['\uFEFF' + [headers, ...data].map(row => row.map(cell).join(';')).join('\r\n')], {type: 'text/csv;charset=utf-8'});
  const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = 'inepad-historico-trimestral.csv'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); toast('Histórico exportado com os saldos individuais das contas.');
}

document.querySelectorAll('[data-page]').forEach(button => button.addEventListener('click', () => setPage(button.dataset.page)));
document.querySelectorAll('[data-setting]').forEach(button => button.addEventListener('click', () => {
  const name = button.dataset.setting; $('banksPanel').hidden = name !== 'banks'; $('partnersPanel').hidden = name !== 'partners';
  document.querySelectorAll('[data-setting]').forEach(tab => { tab.classList.toggle('active', tab === button); tab.setAttribute('aria-selected', String(tab === button)); }); message('settingsMessage');
}));
$('historySearch').addEventListener('input', renderHistory); $('historyYear').addEventListener('change', renderHistory);
$('newClosingButton').addEventListener('click', beginClosing);
$('cancelClosing').addEventListener('click', async () => {
  const changed = [...document.querySelectorAll('[data-bank-id]')].some(input => input.value !== '');
  if (changed && !await confirmAction('Descartar este lançamento?', 'Os saldos ainda não salvos serão descartados. Seu histórico permanece preservado.')) return;
  $('closingEditor').hidden = true; $('newClosingButton').hidden = false;
});
$('closingYear').addEventListener('change', updatePreviousPeriod); $('closingQuarter').addEventListener('change', updatePreviousPeriod);
$('closingForm').addEventListener('input', updatePreview); $('closingForm').addEventListener('submit', saveClosing);
$('historyExport')?.addEventListener('click', exportHistory); $('printReportButton')?.addEventListener('click', () => window.print());
$('cancelPartnerEdit').addEventListener('click', resetPartnerForm);

$('historyBody').addEventListener('click', event => {
  const button = event.target.closest('[data-expand]'); if (!button) return;
  const row = $(`details-${button.dataset.expand}`), expanded = row.hidden; row.hidden = !expanded;
  $('historyBody').querySelectorAll(`[data-expand="${CSS.escape(button.dataset.expand)}"]`).forEach(toggle => { toggle.setAttribute('aria-expanded', String(expanded)); const symbol = toggle.querySelector('.toggle-symbol'); if (symbol) symbol.textContent = expanded ? '−' : '+'; });
});
$('historyBody').addEventListener('submit', async event => {
  const form = event.target.closest('[data-payment-id]');
  if (!form) return;
  event.preventDefault();
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await api(`/closings/${encodeURIComponent(form.dataset.paymentId)}`, {method: 'PATCH', body: JSON.stringify({actualDistribution: Number(form.elements.actualDistribution.value)})});
    await load();
    toast('Distribuição efetiva atualizada.');
  } catch (error) {
    const feedback = form.querySelector('[role="status"]');
    feedback.textContent = errorText(error); feedback.hidden = false; button.disabled = false;
  }
});
$('banksList').addEventListener('click', async event => {
  const button = event.target.closest('[data-delete-bank]'); if (!button) return;
  const bank = state.banks.find(bank => bank.id === button.dataset.deleteBank);
  if (!bank || !await confirmAction(`Excluir ${bank.name}?`, 'A conta será removida dos próximos lançamentos. Os saldos dos fechamentos anteriores continuarão no histórico.')) return;
  button.disabled = true;
  try { await api(`/banks/${encodeURIComponent(bank.id)}`, {method: 'DELETE'}); await load(); toast('Conta excluída. O histórico foi preservado.'); }
  catch (error) { message('settingsMessage', errorText(error)); button.disabled = false; }
});
$('partnersList').addEventListener('click', event => { const button = event.target.closest('[data-edit-partner]'); if (button) editPartner(button.dataset.editPartner); });
$('bankForm').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.currentTarget.querySelector('[type="submit"]'); button.disabled = true; message('settingsMessage');
  try { await api('/banks', {method: 'POST', body: JSON.stringify({name: $('bankName').value.trim()})}); $('bankForm').reset(); await load(); toast('Conta adicionada aos próximos fechamentos.'); }
  catch (error) { message('settingsMessage', errorText(error)); } finally { button.disabled = false; }
});
$('partnerForm').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.currentTarget.querySelector('[type="submit"]'), id = $('partnerId').value;
  const data = {name: $('partnerName').value.trim(), email: $('partnerEmail').value.trim().toLowerCase(), share: Number($('partnerShare').value), minimum: Number($('partnerMinimum').value), discount: Number($('partnerDiscount').value)};
  button.disabled = true; message('settingsMessage');
  try { await api(`/partners${id ? '/' + encodeURIComponent(id) : ''}`, {method: id ? 'PUT' : 'POST', body: JSON.stringify(data)}); resetPartnerForm(); await load(); toast(id ? 'Parâmetros atualizados para os próximos fechamentos.' : 'Sócio cadastrado.'); }
  catch (error) { message('settingsMessage', errorText(error)); } finally { button.disabled = false; }
});

$('showRecovery').addEventListener('click', () => showAuth('recovery'));
$('showLogin').addEventListener('click', async () => {
  if (authMode === 'firstAccess') {
    try { const {error} = await authClient.auth.signOut({scope: 'local'}); if (error) throw error; session = null; }
    catch (error) { return message('authMessage', errorText(error)); }
  }
  recoveryMode = false; showAuth('login');
});
$('togglePassword').addEventListener('click', () => {
  const reveal = $('password').type === 'password'; $('password').type = reveal ? 'text' : 'password';
  $('togglePassword').setAttribute('aria-label', reveal ? 'Ocultar senha' : 'Mostrar senha'); $('togglePassword').setAttribute('aria-pressed', String(reveal));
});
$('logoutButton').addEventListener('click', async () => {
  try {
    if (!$('closingEditor').hidden && !await confirmAction('Sair da plataforma?', 'O lançamento aberto ainda não foi salvo.')) return;
    const {error} = await authClient.auth.signOut({scope: 'local'}); if (error) throw error;
    session = null; refreshId++; state = {banks: [], partners: [], closings: []}; records = [];
    $('password').value = ''; $('closingEditor').hidden = true; $('historyBody').replaceChildren(); $('banksList').replaceChildren(); $('partnersList').replaceChildren(); $('newClosingButton').hidden = false;
    document.cookie = 'sb-token=; Max-Age=0; Path=/; SameSite=Lax'; document.cookie = 'sid=; Max-Age=0; Path=/; SameSite=Lax';
    showAuth('login'); setPage('overview');
  } catch (error) { toast(errorText(error)); }
});
$('authForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!authClient) return message('authMessage', 'A conexão de acesso está indisponível. Recarregue a página para tentar novamente.');
  const button = $('authSubmit'), label = button.textContent; button.disabled = true; button.textContent = 'Aguarde…'; message('authMessage');
  try {
    if (authMode === 'recovery') {
      const {error} = await authClient.auth.resetPasswordForEmail($('email').value.trim(), {redirectTo: location.origin + '/'}); if (error) throw error;
      message('authMessage', 'Se este e-mail estiver cadastrado, você receberá um link de recuperação. Confira também o spam.', true);
    } else if (authMode === 'reset' || authMode === 'firstAccess') {
      if ($('password').value !== $('passwordConfirm').value) throw new Error('As senhas não conferem. Digite a mesma senha nos dois campos.');
      if ($('password').value === 'inepad123') throw new Error('Escolha uma senha pessoal diferente da senha temporária.');
      await api('/password-change', {method: 'POST', body: JSON.stringify({password: $('password').value})});
      const {data, error} = await authClient.auth.refreshSession(); if (error) throw error;
      session = data.session;
      recoveryMode = false; history.replaceState({}, '', location.pathname); $('password').value = ''; $('passwordConfirm').value = ''; await load(); toast('Senha atualizada com sucesso.');
    } else {
      const {data, error} = await authClient.auth.signInWithPassword({email: $('email').value.trim(), password: $('password').value}); if (error) throw error;
      session = data.session; await load(); $('password').value = '';
    }
  } catch (error) { message('authMessage', errorText(error)); } finally { button.disabled = false; button.textContent = label; }
});

async function initializeAuth() {
  showAuth('login'); $('authSubmit').disabled = true;
  try {
    const config = await api('/config');
    if (!config.url || !config.anonKey || !window.supabase) throw new Error('O acesso ainda não está configurado. Contate o administrador.');
    authClient = window.supabase.createClient(config.url, config.anonKey);
    authClient.auth.onAuthStateChange((event, nextSession) => {
      session = nextSession;
      if (event === 'PASSWORD_RECOVERY') { recoveryMode = true; showAuth('reset'); }
      if (event === 'SIGNED_OUT') { refreshId++; showAuth('login'); }
    });
    const {data, error} = await authClient.auth.getSession(); if (error) throw error; session = data.session;
    if (recoveryMode && session) showAuth('reset'); else if (session) await load();
  } catch (error) { message('authMessage', errorText(error)); } finally { $('authSubmit').disabled = false; }
}

initializeAuth();

window.matchMedia('(max-width: 640px)').addEventListener('change', () => {
  if (session) renderChart(records.filter(record => !record.pending));
});
