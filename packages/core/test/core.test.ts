import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  cashPlan, classifySizeTier, computeCustomsFees, computeDropship, computeDuty, computeFbaFees, computeFreight,
  computeLandedCost, deMinimisAvailable, evaluateCompliance, isEffective, latestSafeOrderDate, underwrite,
} from '../src/index.ts';
import type { DealInput, Ruleset } from '../src/index.ts';
import { rules } from '../../rules/src/index.ts';

const fixture = (name: string): DealInput => JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8'));
const clone = <T>(x: T): T => structuredClone(x);
const near = (a: number, b: number, tol = 0.01) => assert.ok(Math.abs(a - b) <= tol, `${a} ≉ ${b} (±${tol})`);

// ─── dated rules ───
test('isEffective: inclusive start, exclusive end, open-ended', () => {
  const r = { effectiveFrom: '2026-02-24', effectiveTo: '2026-07-24' };
  assert.equal(isEffective(r, '2026-02-23'), false);
  assert.equal(isEffective(r, '2026-02-24'), true);
  assert.equal(isEffective(r, '2026-07-23'), true);
  assert.equal(isEffective(r, '2026-07-24'), false);
  assert.equal(isEffective({ effectiveFrom: '2020-01-01', effectiveTo: null }, '2099-01-01'), true);
});

// ─── duty pipeline ───
const programs = (asOf: string, origin = 'CN', hts = '8518.30.20.00') =>
  computeDuty({ htsCode: hts, origin, customsValue: 1000, asOf }, rules).lines.map(l => `${l.program}:${l.ratePct}`).sort();

test('duty: same HTS, different dates → different stacks (tariffs are data, not constants)', () => {
  assert.deepEqual(programs('2025-06-01'), ['ieepa:10', 'ieepa:20', 'mfn:4.9', 'section301:7.5']);
  assert.deepEqual(programs('2026-04-01'), ['mfn:4.9', 'section122:10', 'section301:7.5']);
  assert.deepEqual(programs('2026-10-10'), ['mfn:4.9', 'section301:12.5', 'section301:7.5']);
});

test('duty: non-China origin only gets MFN (+ global programs in force)', () => {
  assert.deepEqual(programs('2026-10-10', 'VN'), ['mfn:4.9']);
  assert.deepEqual(programs('2026-04-01', 'VN'), ['mfn:4.9', 'section122:10']);
});

test('duty: amounts and effective rate', () => {
  const d = computeDuty({ htsCode: '8518.30.20.00', origin: 'CN', customsValue: 1000, asOf: '2026-10-10' }, rules);
  near(d.total, 49 + 75 + 125);
  near(d.effectivePct, 24.9);
});

test('duty: MFN override beats table; unknown HTS warns instead of guessing', () => {
  const o = computeDuty({ htsCode: '8518.30.20.00', origin: 'VN', customsValue: 1000, asOf: '2026-10-10', mfnRatePct: 0 }, rules);
  assert.equal(o.total, 0);
  const u = computeDuty({ htsCode: '0101.21.00', origin: 'VN', customsValue: 1000, asOf: '2026-10-10' }, rules);
  assert.equal(u.total, 0);
  assert.match(u.warnings[0], /MFN rate .* unknown/);
});

test('duty: Section 232 needs metal content; computes on metal share only', () => {
  const w = computeDuty({ htsCode: '7323.93.00.80', origin: 'VN', customsValue: 1000, asOf: '2026-10-10' }, rules);
  assert.ok(w.warnings.some(x => /metal content/.test(x)));
  const m = computeDuty({ htsCode: '7323.93.00.80', origin: 'VN', customsValue: 1000, asOf: '2026-10-10', metalContentPct: 40 }, rules);
  near(m.lines.find(l => l.program === 'section232')!.amount, 200);
});

// ─── customs fees ───
test('customs: MPF clamps to min/max by fiscal year; informal below threshold; HMF only on ocean', () => {
  const fees = (v: number, asOf: string, mode: 'lcl' | 'air' = 'lcl') =>
    Object.fromEntries(computeCustomsFees({ entryValue: v, dutyTotal: 0, mode, asOf, includesBrokerage: false }, rules).map(l => [l.label.split(' ')[0], l.amount]));
  near(fees(5000, '2026-09-30').MPF, 33.58);
  near(fees(5000, '2026-10-01').MPF, 34.58);
  near(fees(1_000_000, '2026-10-01').MPF, 670.86);
  near(fees(100_000, '2026-10-01').MPF, 346.4);
  near(fees(2000, '2026-10-10').MPF, 2.77);
  assert.ok('HMF' in fees(5000, '2026-10-10', 'lcl'));
  assert.ok(!('HMF' in fees(5000, '2026-10-10', 'air')));
});

test('de minimis: available pre-2025, gone for CN from 2025-05-02 and globally from 2025-08-29', () => {
  assert.equal(deMinimisAvailable(rules, 'CN', '2024-06-01', 30).available, true);
  assert.equal(deMinimisAvailable(rules, 'CN', '2025-06-01', 30).available, false);
  assert.equal(deMinimisAvailable(rules, 'VN', '2025-06-01', 30).available, true);
  assert.equal(deMinimisAvailable(rules, 'VN', '2026-10-10', 30).available, false);
  assert.equal(deMinimisAvailable(rules, 'VN', '2024-06-01', 900).available, false);
});

// ─── freight ───
test('freight: CBM / chargeable weight math and LCL minimum', () => {
  const f = computeFreight({ carton: { lengthCm: 50, widthCm: 40, heightCm: 30, weightKg: 12, unitsPerCarton: 50 }, supplier: { moq: 500 } as DealInput['supplier'], freight: { mode: 'lcl' } }, rules);
  assert.equal(f.cartons, 10);
  near(f.totalCbm, 0.6);
  near(f.totalKg, 120);
  // LCL billed at 1 CBM min: 140 + 450 fixed + 0.6*45 delivery
  near(f.chosen.total, 140 + 450 + 27);
  const air = f.options.find(o => o.mode === 'air')!;
  near(air.total, 120 * 5.8 + 150 + 27); // actual 120 kg > volumetric 100 kg
});

test('freight: auto picks cheapest ocean mode; big volume → FCL', () => {
  const small = computeFreight({ carton: { lengthCm: 50, widthCm: 40, heightCm: 30, weightKg: 12, unitsPerCarton: 50 }, supplier: { moq: 500 } as DealInput['supplier'], freight: { mode: 'auto' } }, rules);
  assert.equal(small.chosen.mode, 'lcl');
  const big = computeFreight({ carton: { lengthCm: 60, widthCm: 40, heightCm: 40, weightKg: 14, unitsPerCarton: 10 }, supplier: { moq: 5000 } as DealInput['supplier'], freight: { mode: 'auto' } }, rules);
  assert.ok(['fcl20', 'fcl40hq'].includes(big.chosen.mode));
});

// ─── FBA fees ───
test('fba: size tier classification', () => {
  assert.equal(classifySizeTier({ lengthIn: 6, widthIn: 4, heightIn: 0.5, weightLb: 0.3 }, rules).tier, 'smallStandard');
  assert.equal(classifySizeTier({ lengthIn: 4.5, widthIn: 3.5, heightIn: 1.8, weightLb: 0.35 }, rules).tier, 'largeStandard');
  assert.equal(classifySizeTier({ lengthIn: 30, widthIn: 10, heightIn: 10, weightLb: 8 }, rules).tier, 'largeBulky');
});

test('fba: 2026 card = 2025 base + tier delta, then 3.5% surcharge from 2026-04-17', () => {
  const pkg = { lengthIn: 6, widthIn: 4, heightIn: 0.5, weightLb: 0.3 }; // 4.8 oz small standard → $3.24 base
  const before = computeFbaFees({ unitPackage: pkg, price: 20, quantity: 100, unitsPerMonth: 100, salesStart: '2026-03-01', asOf: '2026-03-01' }, rules);
  near(before.fulfillment, 3.24 + 0.25);
  const after = computeFbaFees({ unitPackage: pkg, price: 20, quantity: 100, unitsPerMonth: 100, salesStart: '2026-05-01', asOf: '2026-05-01' }, rules);
  near(after.fulfillment, (3.24 + 0.25) * 1.035);
});

test('fba: peak adder weighted by share of sales inside the peak window', () => {
  const pkg = { lengthIn: 6, widthIn: 4, heightIn: 0.5, weightLb: 0.3 };
  const r = computeFbaFees({ unitPackage: pkg, price: 20, quantity: 300, unitsPerMonth: 300, salesStart: '2026-11-01', asOf: '2026-11-01' }, rules);
  assert.ok(r.lines.some(l => /peak/.test(l.label)));
});

// ─── landed cost ───
test('landed: waterfall sums to contribution; contribution ≈ 0 at breakeven', () => {
  const input = fixture('earbuds-fba');
  const l = computeLandedCost(input, rules);
  const parts = l.waterfall.slice(0, -1).reduce((s, w) => s + w.amount, 0);
  near(parts, l.contributionPerUnit, 0.06);
  const be = computeLandedCost({ ...clone(input), sales: { ...input.sales, price: l.breakevenPrice } }, rules);
  near(be.contributionPerUnit, 0, 0.05);
  assert.ok(l.naiveMarginPct > l.contributionMarginPct + 30, 'naive margin must be far above true margin for the README example');
});

test('landed: overrides flow through (editable assumptions)', () => {
  const input = fixture('kitchen-utensils-fba');
  const base = computeLandedCost(input, rules);
  const cheap = computeLandedCost({ ...clone(input), overrides: { freightRatePerCbm: 40 } }, rules);
  assert.ok(cheap.perUnit.freight < base.perUnit.freight);
});

// ─── compliance ───
test('compliance: gaps vs certs held; unknown category is unassessed, not clear', () => {
  const c = evaluateCompliance(fixture('earbuds-fba'), rules, 'lcl');
  assert.deepEqual(c.gaps, ['un38.3', 'msds', 'prop65']);
  assert.ok(c.warnings[0].startsWith('CRITICAL'));
  const u = evaluateCompliance({ ...fixture('earbuds-fba'), product: { ...fixture('earbuds-fba').product, complianceCategory: 'nope' } }, rules);
  assert.match(u.warnings[0], /UNASSESSED/);
});

// ─── cash ───
test('cash: events sum to net profit ≈ contribution × qty; capital exceeds deposit', () => {
  const input = fixture('kitchen-utensils-fba');
  const l = computeLandedCost(input, rules);
  const c = cashPlan(input, l, rules);
  near(c.events.reduce((s, e) => s + e.amount, 0), c.netProfit, 0.05);
  near(c.netProfit, l.contributionPerUnit * l.quantity, l.quantity * 0.02);
  assert.ok(c.capitalRequired > (input.supplier.unitCost + (input.supplier.packagingPerUnit ?? 0)) * input.supplier.moq * 0.3);
  assert.ok(c.firstPayoutDay !== null && c.paybackDay !== null && c.paybackDay >= c.firstPayoutDay);
});

test('order-by: works backwards from target and suggests a faster mode when ocean misses', () => {
  const input = fixture('kitchen-utensils-fba');
  const l = computeLandedCost(input, rules);
  const ob = latestSafeOrderDate(input, rules, l.freight.chosen, l.freight.options)!;
  // 2027-03-01 − (30 prod + 40 LCL + 3 clearance + 10 check-in + 10 buffer = 93) = 2026-11-28
  assert.equal(ob.latestSafeOrderDate, '2026-11-28');
  assert.equal(ob.status, 'ok');
  const tight = { ...clone(input), timing: { targetLiveDate: '2026-12-20' } };
  const ob2 = latestSafeOrderDate(tight, rules, l.freight.chosen, l.freight.options)!;
  assert.equal(ob2.status, 'missed');
  assert.match(ob2.message, /still makes it/);
});

// ─── dropship ───
test('dropship: de minimis reality check flips a pre-2025-profitable model', () => {
  const input = fixture('yoga-mat-dropship');
  const now = computeDropship(input, rules);
  assert.equal(now.deMinimisCheck.available, false);
  assert.ok(now.contributionPerOrder < 0 && now.deMinimisCheck.preSuspensionContribution > 0);
  assert.match(now.deMinimisCheck.message, /only worked under de minimis/);
  const then = computeDropship({ ...clone(input), asOf: '2024-06-01' }, rules);
  assert.equal(then.deMinimisCheck.available, true);
  assert.equal(then.perOrder.find(l => l.label.startsWith('Per-parcel duty'))!.amount, 0);
});

// ─── scoring / verdict / determinism ───
test('scoring: missing market data is excluded (coverage drops), never defaulted', () => {
  const input = fixture('kitchen-utensils-fba');
  delete input.market;
  const r = underwrite(input, rules);
  assert.ok(r.score.coveragePct < 100);
  assert.equal(r.score.subscores.find(s => s.key === 'demand')!.score, null);
});

test('verdicts: kitchen = Undertake, earbuds = Fix These First, dropship yoga mat = Pass', () => {
  assert.equal(underwrite(fixture('kitchen-utensils-fba'), rules).verdict, 'Undertake');
  assert.equal(underwrite(fixture('earbuds-fba'), rules).verdict, 'Fix These First');
  assert.equal(underwrite(fixture('yoga-mat-dropship'), rules).verdict, 'Pass');
});

test('restricted category → Pass regardless of margin', () => {
  const r2: Ruleset = clone(rules);
  r2.compliance.categories.find(c => c.id === 'kitchen-food-contact')!.gating = 'restricted';
  assert.equal(underwrite(fixture('kitchen-utensils-fba'), r2).verdict, 'Pass');
});

test('determinism: same input + ruleset → identical report', () => {
  assert.deepEqual(underwrite(fixture('earbuds-fba'), rules), underwrite(fixture('earbuds-fba'), rules));
});
