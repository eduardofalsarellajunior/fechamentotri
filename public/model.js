(function (root, factory) {
  const model = factory();
  if (typeof module === 'object' && module.exports) module.exports = model;
  else root.INEPADModel = model;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const roundMoney = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
  const numeric = value => Number.isFinite(Number(value)) ? Number(value) : 0;

  function parsePeriod(value) {
    const text = String(value || '');
    const year = Number(text.match(/\b(20\d{2})\b/)?.[1]);
    let quarter = Number(text.match(/(?:T|Q)\s*([1-4])/i)?.[1] || text.match(/([1-4])\s*[º°o]?\s*Trimestre/i)?.[1]);
    if (!quarter) {
      const month = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      quarter = month.includes('marco') ? 1 : month.includes('junho') ? 2 : month.includes('setembro') ? 3 : month.includes('dezembro') ? 4 : 0;
    }
    if (!year || !quarter) return null;
    return {year, quarter, key: `${year}-Q${quarter}`, order: year * 4 + quarter, label: `${quarter}º trimestre de ${year}`};
  }

  function normalizeClosing(closing) {
    const details = closing.rows && !Array.isArray(closing.rows) ? closing.rows : {};
    const modern = details.schemaVersion === 2;
    const balances = Object.fromEntries(Object.entries(details.balances || {}).map(([name, value]) => [name, roundMoney(numeric(value))]));
    const currentCash = Object.keys(balances).length ? roundMoney(Object.values(balances).reduce((a, b) => a + b, 0)) : roundMoney(numeric(closing.current_cash));
    const previousCash = modern ? numeric(details.previous_cash) : numeric(closing.previous_distribution);
    const previousDistribution = modern ? numeric(details.previous_distribution ?? closing.previous_distribution) : null;
    const actualDistribution = details.actual_distribution == null ? null : roundMoney(numeric(details.actual_distribution));
    const pending = !modern && Boolean(details.source) && Object.values(balances).every(v => v === 0) && currentCash === 0 && !actualDistribution;
    return {
      ...closing, period: parsePeriod(details.period_key || closing.quarter), balances, currentCash,
      previousCash: roundMoney(previousCash), previousDistribution, actualDistribution,
      distributionPct: numeric(closing.distribution_pct),
      generatedCash: details.generated_cash == null ? null : roundMoney(numeric(details.generated_cash)),
      distributionAmount: details.distribution_amount == null ? null : roundMoney(numeric(details.distribution_amount)),
      reinvestment: details.reinvestment == null ? null : roundMoney(numeric(details.reinvestment)),
      partnerRows: details.partner_rows || (Array.isArray(closing.rows) ? closing.rows : []), pending,
    };
  }

  function calculateClosing({balances, previousCash = 0, previousDistribution = 0, distributionPct = 90, partners = []}) {
    const values = Array.isArray(balances) ? balances : Object.values(balances || {});
    const currentCash = roundMoney(values.reduce((total, value) => total + numeric(value), 0));
    const generatedCash = roundMoney(currentCash - numeric(previousCash) + numeric(previousDistribution));
    const distributionAmount = roundMoney(Math.max(0, generatedCash) * numeric(distributionPct) / 100);
    const reinvestment = roundMoney(generatedCash - distributionAmount);
    const partnerRows = partners.map(partner => {
      const bruto = roundMoney(distributionAmount * numeric(partner.share) / 100);
      const complement = roundMoney(Math.max(0, numeric(partner.minimum) * 3 - bruto));
      const desconto = roundMoney(numeric(partner.discount) * 3);
      return {id: partner.id, name: partner.name, share: numeric(partner.share), bruto, complement, desconto, total: roundMoney(Math.max(0, bruto + complement - desconto))};
    });
    return {
      currentCash, generatedCash, distributionAmount, reinvestment, partnerRows,
      totalComplement: roundMoney(partnerRows.reduce((sum, partner) => sum + partner.complement, 0)),
      totalDiscount: roundMoney(partnerRows.reduce((sum, partner) => sum + partner.desconto, 0)),
      totalPayable: roundMoney(partnerRows.reduce((sum, partner) => sum + partner.total, 0)),
    };
  }

  return {roundMoney, parsePeriod, normalizeClosing, calculateClosing};
});
