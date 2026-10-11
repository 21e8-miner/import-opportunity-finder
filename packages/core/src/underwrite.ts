/**
 * underwrite(): the single entry point. DealInput + Ruleset → UnderwritingReport.
 * Order matters: compliance gating first, then economics, cash, timing, scoring.
 */
import { cashPlan, latestSafeOrderDate } from './cash.ts';
import { evaluateCompliance } from './compliance.ts';
import { computeDropship } from './dropship.ts';
import { computeLandedCost, playbookDef } from './landedCost.ts';
import { score } from './scoring.ts';
import type { DealInput, Ruleset, UnderwritingReport } from './types.ts';
import { diffDays } from './util.ts';

export function underwrite(input: DealInput, rules: Ruleset): UnderwritingReport {
  const pb = playbookDef(rules, input.playbook);
  if (pb.status !== 'live') throw new Error(`Playbook ${pb.id} is planned, not live yet`);
  const d = pb.defaults ?? {};
  const target = d.targetMarginPct ?? 20;
  const warnings: string[] = [];
  let report: Omit<UnderwritingReport, 'verdict' | 'drivers' | 'score' | 'risks'> & Partial<UnderwritingReport>;

  if (input.playbook === 'dropship') {
    const compliance = evaluateCompliance(input, rules, 'express');
    const ds = computeDropship(input, rules);
    warnings.push(...compliance.warnings, ...ds.warnings);
    const sc = score({ input, weights: pb.weights ?? {}, contributionMarginPct: ds.contributionMarginPct, targetMarginPct: target,
      dutyEffectivePct: dutyPctFromLines(ds), compliance });
    report = baseReport(input, rules, compliance, warnings);
    report.dropship = ds;
    report.score = sc;
    report.assumptions = [
      ...report.assumptions,
      { key: 'Parcel base / per-kg', value: `$${rules.freight.dropship.parcelBaseUsd} + $${rules.freight.dropship.parcelPerKgUsd}/kg`, provenance: { source: 'assumption:freight.dropship', verified: false } },
      { key: 'Carrier clearance / parcel', value: rules.freight.dropship.carrierClearancePerParcel, provenance: { source: 'assumption:freight.dropship', verified: false } },
      { key: 'CPM / CTR / CVR', value: `$${input.dropship?.cpm} / ${input.dropship?.ctrPct}% / ${input.dropship?.cvrPct}%`, provenance: { source: 'user' } },
      { key: 'Payout lag (days)', value: ds.cash.payoutLagDays, provenance: { source: 'rules:playbooks.dropship', verified: false } },
    ];
  } else {
    const landed = computeLandedCost(input, rules);
    const compliance = evaluateCompliance(input, rules, landed.freight.chosen.mode);
    const cash = cashPlan(input, landed, rules);
    const orderBy = latestSafeOrderDate(input, rules, landed.freight.chosen, landed.freight.options);
    warnings.push(...compliance.warnings, ...landed.warnings);
    const sc = score({ input, weights: pb.weights ?? {}, contributionMarginPct: landed.contributionMarginPct, targetMarginPct: target,
      dutyEffectivePct: landed.dutyEffectivePct, compliance, orderByStatus: orderBy?.status, roiPct: landed.roiPct });
    report = baseReport(input, rules, compliance, warnings);
    Object.assign(report, { landed, cash, orderBy, score: sc });
    const ov = input.overrides ?? {};
    const prov = (k: keyof NonNullable<DealInput['overrides']>, src: string) => ({ source: ov[k] !== undefined ? 'user' : src, verified: ov[k] !== undefined });
    report.assumptions = [
      ...report.assumptions,
      { key: 'Freight mode', value: landed.freight.chosen.label, provenance: { source: input.freight.mode === 'auto' ? 'engine:cheapest-ocean' : 'user' } },
      { key: 'Freight detail', value: landed.freight.chosen.detail, provenance: { source: 'assumption:freight', verified: false } },
      { key: 'Transit days', value: landed.freight.chosen.transitDays, provenance: prov('transitDays', 'assumption:freight') },
      { key: 'Customs brokerage / entry', value: ov.brokeragePerEntry ?? rules.customs.assumptions.brokeragePerEntry, provenance: prov('brokeragePerEntry', 'assumption:customs') },
      { key: 'FBA fulfillment fee', value: landed.fba?.fulfillment ?? 0, provenance: prov('fbaFulfillmentFee', 'rules:fba') },
      { key: 'Referral fee %', value: landed.fba?.referralPct ?? 0, provenance: prov('referralPct', 'rules:fba.referral') },
      { key: 'TACOS %', value: input.sales.tacosPct ?? d.tacosPct ?? 0, provenance: { source: input.sales.tacosPct !== undefined ? 'user' : 'rules:playbooks', verified: input.sales.tacosPct !== undefined } },
      { key: 'Return rate %', value: input.sales.returnRatePct ?? d.returnRatePct ?? 0, provenance: { source: input.sales.returnRatePct !== undefined ? 'user' : 'rules:playbooks', verified: input.sales.returnRatePct !== undefined } },
      { key: 'Return loss % of price', value: ov.returnLossPctOfPrice ?? d.returnLossPctOfPrice ?? 50, provenance: prov('returnLossPctOfPrice', 'rules:playbooks') },
      { key: 'FBA check-in days', value: input.timing?.checkInDays ?? rules.freight.fbaCheckInDays, provenance: { source: input.timing?.checkInDays !== undefined ? 'user' : 'assumption:freight' } },
      { key: 'Sell-through (units/mo)', value: input.sales.unitsPerMonth, provenance: { source: 'user' } },
    ];
  }

  report.risks = buildRisks(input, report as UnderwritingReport, rules);
  const sc = report.score!;
  return { ...(report as UnderwritingReport), verdict: sc.verdict, drivers: sc.drivers };

  function dutyPctFromLines(ds: ReturnType<typeof computeDropship>): number {
    const goods = input.supplier.unitCost * (input.dropship?.unitsPerOrder ?? 1);
    const dutyLine = ds.perOrder.find(l => l.label.startsWith('Per-parcel duty'));
    return goods > 0 && dutyLine ? Math.round(dutyLine.amount / goods * 100) : 0;
  }
}

function baseReport(input: DealInput, rules: Ruleset, compliance: UnderwritingReport['compliance'], warnings: string[]) {
  return {
    rulesetVersion: rules.version,
    generatedFor: input.product.name,
    asOf: input.asOf,
    playbook: input.playbook,
    input,
    compliance,
    assumptions: [
      { key: 'Ruleset version', value: rules.version, provenance: { source: 'rules' } },
      { key: 'Rules evaluated as of', value: input.asOf, provenance: { source: 'user' } },
      { key: 'Unit cost (FOB)', value: input.supplier.unitCost, provenance: { source: 'user' } },
      { key: 'Order quantity', value: input.supplier.moq, provenance: { source: 'user' } },
      { key: 'Sale price', value: input.sales.price, provenance: { source: 'user' } },
      { key: 'MFN rate %', value: input.product.mfnRatePct ?? 'from rules table', provenance: { source: input.product.mfnRatePct !== undefined ? 'user' : 'rules:hts-sample', verified: input.product.mfnRatePct !== undefined } },
    ] as UnderwritingReport['assumptions'],
    warnings: [...new Set(warnings)],
  } as Omit<UnderwritingReport, 'verdict' | 'drivers' | 'score' | 'risks'> & Partial<UnderwritingReport>;
}

function buildRisks(input: DealInput, r: UnderwritingReport, rules: Ruleset): UnderwritingReport['risks'] {
  const m = input.market ?? {};
  const risks: UnderwritingReport['risks'] = [];
  risks.push(m.priceErosionPct90d === undefined
    ? { key: 'Price erosion', level: 'unknown', detail: 'No 90-day price history (Keepa provider).' }
    : { key: 'Price erosion', level: m.priceErosionPct90d < -10 ? 'high' : m.priceErosionPct90d < -3 ? 'medium' : 'low', detail: `${m.priceErosionPct90d}% over 90 days` });
  risks.push(m.reviewGrowthPct90d === undefined
    ? { key: 'Saturation', level: 'unknown', detail: 'No top-10 review growth data.' }
    : { key: 'Saturation', level: m.reviewGrowthPct90d > 40 ? 'high' : m.reviewGrowthPct90d > 15 ? 'medium' : 'low', detail: `Top-10 review counts +${m.reviewGrowthPct90d}% in 90 days` });
  risks.push({ key: 'IP', level: r.compliance.ipRisk.length > 1 ? 'medium' : r.compliance.ipRisk.length ? 'low' : 'unknown', detail: r.compliance.ipRisk.join(' · ') || 'No IP notes for this category; run a USPTO trademark search on your brand + keywords.' });

  // Tariff volatility: any duty program in force that started within the last 12 months.
  const recent = (r.landed?.duty ?? []).filter(l => l.effectiveFrom !== '—' && diffDays(l.effectiveFrom, input.asOf) < 365);
  risks.push({ key: 'Tariff volatility', level: recent.length ? 'high' : 'low',
    detail: recent.length ? `${recent.map(l => `${l.label} (since ${l.effectiveFrom})`).join('; ')} — rates changed within 12 months; re-underwrite before each PO.` : 'No duty programs changed in the last 12 months.' });

  if (r.landed) {
    const peak = rules.fba.peak.find(p => r.landed && r.landed.salesStart < (p.effectiveTo ?? '9999') && p.effectiveFrom <= r.landed.salesStart);
    risks.push({ key: 'Seasonality / timing', level: r.orderBy?.status === 'missed' ? 'high' : peak ? 'medium' : 'low',
      detail: `Go-live ${r.landed.salesStart}${peak ? ' falls inside the Q4 peak-fee window' : ''}${r.orderBy ? `; ${r.orderBy.message}` : ''}` });
  }
  risks.push({ key: 'Compliance', level: r.compliance.blockers.length ? 'high' : r.compliance.gaps.length ? 'medium' : r.compliance.label === 'Unknown category' ? 'unknown' : 'low',
    detail: r.compliance.blockers[0] ?? (r.compliance.gaps.length ? `Missing: ${r.compliance.gaps.join(', ')}` : 'All listed requirements held.') });
  return risks;
}
