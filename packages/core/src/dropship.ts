/**
 * Dropship / TikTok Shop economics: per-order contribution after ad CAC and *per-parcel* duty.
 * Includes the de-minimis reality check — what this order would have made before the §321 suspension vs. today.
 */
import { computeDuty, deMinimisAvailable } from './duty.ts';
import { playbookDef } from './landedCost.ts';
import type { DealInput, DropshipEconomics, Line, Ruleset } from './types.ts';
import { effective, round2 } from './util.ts';

export function computeDropship(input: DealInput, rules: Ruleset): DropshipEconomics {
  if (!input.dropship) throw new Error('dropship playbook requires input.dropship (cpm, ctrPct, cvrPct)');
  const d = playbookDef(rules, 'dropship').defaults ?? {};
  const ds = input.dropship;
  const fr = rules.freight.dropship;
  const units = ds.unitsPerOrder ?? 1;
  const price = input.sales.price * units;
  const warnings: string[] = [];

  const goods = (input.supplier.unitCost + (input.supplier.packagingPerUnit ?? 0)) * units;
  const kg = input.unitPackage.weightLb * 0.4536 * units;
  const shipping = fr.parcelBaseUsd + fr.parcelPerKgUsd * kg;

  const duty = computeDuty({
    htsCode: input.product.htsCode, origin: input.product.origin, customsValue: goods, asOf: input.asOf,
    mfnRatePct: input.product.mfnRatePct, metalContentPct: input.product.metalContentPct,
  }, rules);
  warnings.push(...duty.warnings);
  const mpf = effective(rules.customs.mpf, input.asOf, 'MPF');
  const dm = deMinimisAvailable(rules, input.product.origin, input.asOf, goods);

  const ctr = ds.ctrPct / 100, cvr = ds.cvrPct / 100;
  if (ctr <= 0 || cvr <= 0) throw new Error('ctrPct and cvrPct must be > 0');
  const cac = ds.cpm / (1000 * ctr * cvr);
  const payment = price * (d.paymentPct ?? 2.9) / 100 + (d.paymentFixed ?? 0.3);
  const returns = price * (input.sales.returnRatePct ?? d.returnRatePct ?? 0) / 100 * (input.overrides?.returnLossPctOfPrice ?? d.returnLossPctOfPrice ?? 70) / 100;

  const dutyAmt = dm.available ? 0 : duty.total;
  const clearance = dm.available ? 0 : fr.carrierClearancePerParcel;
  const mpfAmt = dm.available ? 0 : mpf.informalFlat;

  const perOrder: Line[] = [
    { label: `Product (${units}×)`, amount: round2(goods), provenance: { source: 'user' } },
    { label: `Parcel shipping (${kg.toFixed(2)} kg)`, amount: round2(shipping), provenance: { source: 'assumption:freight.dropship', verified: false } },
    { label: `Per-parcel duty (${duty.effectivePct}% stacked)`, amount: round2(dutyAmt), provenance: { source: `rules:${dm.ruleId}`, verified: false }, note: dm.available ? 'de minimis available' : 'no de minimis' },
    { label: 'Carrier clearance fee', amount: round2(clearance), provenance: { source: 'assumption:freight.dropship', verified: false } },
    { label: 'MPF (informal)', amount: round2(mpfAmt), provenance: { source: `rules:${mpf.id}`, verified: mpf.verified } },
    { label: 'Payment processing', amount: round2(payment), provenance: { source: 'rules:playbooks.dropship', verified: false } },
    { label: `Ad CAC ($${ds.cpm} CPM → ${ds.ctrPct}% CTR → ${ds.cvrPct}% CVR)`, amount: round2(cac), provenance: { source: 'user' } },
    { label: 'Returns', amount: round2(returns), provenance: { source: 'rules:playbooks.dropship', verified: false } },
  ];
  const costs = perOrder.reduce((s, l) => s + l.amount, 0);
  const contribution = price - costs;
  const breakevenCpa = price - (costs - cac);

  // Counterfactual: §321 de minimis available (pre-2025 world)
  const preContribution = contribution + (dm.available ? 0 : dutyAmt + clearance + mpfAmt);
  const delta = preContribution - contribution;
  const message = dm.available
    ? 'De minimis applies on this date — parcel enters duty-free.'
    : contribution <= 0 && preContribution > 0
      ? `This model only worked under de minimis: it made $${preContribution.toFixed(2)}/order before the suspension and loses $${Math.abs(contribution).toFixed(2)}/order today.`
      : `De minimis is gone: per-parcel duty + clearance costs $${delta.toFixed(2)}/order (${(delta / price * 100).toFixed(1)}% of price).`;
  if (cac > price * 0.5) warnings.push(`CAC is ${(cac / price * 100).toFixed(0)}% of price — creative/targeting must improve before scaling.`);

  const dailyOrders = input.sales.unitsPerMonth / 30 / units;
  const lag = d.payoutLagDays ?? 8;
  return {
    perOrder,
    cac: round2(cac),
    contributionPerOrder: round2(contribution),
    contributionMarginPct: round2(contribution / price * 100),
    breakevenCpa: round2(breakevenCpa),
    deMinimisCheck: { available: dm.available, preSuspensionContribution: round2(preContribution), delta: round2(delta), message },
    cash: { adFloat: round2(dailyOrders * (cac + goods + shipping) * lag), payoutLagDays: lag },
    warnings,
  };
}
