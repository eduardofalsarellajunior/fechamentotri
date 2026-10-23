'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {parsePeriod, normalizeClosing, calculateClosing} = require('../public/model');

test('historical dates and current quarter keys sort chronologically', () => {
  assert.equal(parsePeriod('2026 30-Junho').key, '2026-Q2');
  assert.equal(parsePeriod('2026 4º Trimestre').quarter, 4);
  assert.equal(parsePeriod('2026-Q3').year, 2026);
  assert.ok(parsePeriod('2026 1º Trimestre').order < parsePeriod('2026 4º Trimestre').order);
});

test('cash includes every bank, the prior balance and actual prior payout', () => {
  const result = calculateClosing({balances: [250000.10, 100000.20, 0], previousCash: 300000, previousDistribution: 50000, distributionPct: 90});
  assert.equal(result.currentCash, 350000.30);
  assert.equal(result.generatedCash, 100000.30);
  assert.equal(result.distributionAmount, 90000.27);
  assert.equal(result.reinvestment, 10000.03);
});

test('minimum supplement comes from company cash without reducing another partner', () => {
  const result = calculateClosing({balances: [10000], distributionPct: 90, partners: [
    {id: 'a', name: 'Sócio A', share: 10, minimum: 1000, discount: 100},
    {id: 'b', name: 'Sócio B', share: 90, minimum: 0, discount: 0},
  ]});
  assert.deepEqual(result.partnerRows.map(p => p.total), [2700, 8100]);
  assert.equal(result.totalComplement, 2100);
  assert.equal(result.totalDiscount, 300);
});

test('zero and negative cash are valid, with no negative distribution to partners', () => {
  const result = calculateClosing({balances: [0, -100], previousCash: 100, distributionPct: 90, partners: [{id:'a',name:'A',share:100,minimum:100,discount:200}]});
  assert.equal(result.generatedCash, -200);
  assert.equal(result.distributionAmount, 0);
  assert.equal(result.reinvestment, -200);
  assert.equal(result.partnerRows[0].total, 0);
});

test('legacy historical cash is recalculated from account snapshots, no incorrect field interpretation', () => {
  const record = normalizeClosing({quarter:'2026 3º Trimestre', current_cash:999, previous_distribution:100, rows:{balances:{Itaú:120,XP:30}, actual_distribution:20}});
  assert.equal(record.currentCash,150);
  assert.equal(record.previousCash,100);
  assert.equal(record.previousDistribution,null);
  assert.equal(record.pending,false);
});

test('empty imported future is pending; a saved all-zero closing remains completed', () => {
  const original = {quarter:'2026 4º Trimestre',current_cash:0,rows:{source:'history.xlsx',balances:{Itaú:0},actual_distribution:0}};
  assert.equal(normalizeClosing(original).pending,true);
  assert.equal(normalizeClosing({...original, rows:{...original.rows,schemaVersion:2,previous_cash:100,previous_distribution:20}}).pending,false);
});
