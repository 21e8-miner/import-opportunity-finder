/**
 * Landed Cost Engine (FBA Private Label): factory → packaging → QC → freight → duty → customs → FBA → ads → returns.
 * Pure: (DealInput, Ruleset) → LandedCost. No network, no clock (asOf comes from the input).
 */
import { computeCustomsFees, computeDuty } from './duty.ts';
import { computeFbaFees } from './fba.ts';
import { computeFreight } from './freight.ts';
import type { DealInput, LandedCost, PlaybookDef, Ruleset } from './types.ts';
import { addDays, round2 } from './util.ts';

export function playbookDef(rules: Ruleset, id: string): PlaybookDef {
  const pb = rules.playbooks.playbooks.find(p => p.id === id);
  if (!pb) throw new Error(`Unknown playbook ${id}`);
  return pb;
}

export function amazonCategoryFor(input: DealInput, rules: Ruleset): string | undefined {
  return input.product.amazonCategory
    ?? rules.compliance.categories.find(c => c.id === input.product.complianceCategory)?.amazonCategory;
}

/** Days from PO to sellable at FBA, using the chosen freight mode's transit time. */
export function leadTimeDays(input: DealInput, rules: Ruleset, transitDays: number): { production: number; transit: number; clearance: number; checkIn: number } {
  return {
    production: input.supplier.productionDays,
    transit: transitDays,
    clearance: rules.freight.customsClearanceDays,
    checkIn: input.timing?.checkInDays ?? rules.freight.fbaCheckInDays,
  };
}

export function computeLandedCost(input: DealInput, rules: Ruleset): LandedCost {
  const ov = input.overrides ?? {};
  const d = playbookDef(rules, input.playbook).defaults ?? {};
  const warnings: string[] = [];
  const qty = input.supplier.moq;
  const price = input.sales.price;
  if (qty <= 0 || price <= 0) throw new Error('moq and price must be > 0');

  const packaging = input.supplier.packagingPerUnit ?? 0;
  const goodsValue = (input.supplier.unitCost + packaging) * qty;   // dutiable transaction value (FOB)

  const freight = computeFreight(input, rules, ov);
  const duty = computeDuty({
    htsCode: input.product.htsCode, origin: input.product.origin, customsValue: goodsValue, asOf: input.asOf,
    mfnRatePct: input.product.mfnRatePct, metalContentPct: input.product.metalContentPct,
  }, rules);
  warnings.push(...duty.warnings);

  const customsLines = computeCustomsFees({
    entryValue: goodsValue, dutyTotal: duty.total, mode: freight.chosen.mode, asOf: input.asOf,
    includesBrokerage: freight.chosen.includesBrokerage, brokerageOverride: ov.brokeragePerEntry,
  }, rules);
  const customsTotal = customsLines.reduce((s, l) => s + l.amount, 0);

  const lt = leadTimeDays(input, rules, freight.chosen.transitDays);
  const salesStart = addDays(input.asOf, lt.production + lt.transit + lt.clearance + lt.checkIn);

  const fba = computeFbaFees({
    unitPackage: input.unitPackage, price, amazonCategory: amazonCategoryFor(input, rules), quantity: qty,
    unitsPerMonth: input.sales.unitsPerMonth, salesStart, asOf: input.asOf,
  }, rules, ov);

  const tacosPct = input.sales.tacosPct ?? d.tacosPct ?? 0;
  const returnRatePct = input.sales.returnRatePct ?? d.returnRatePct ?? 0;
  const returnLossPct = ov.returnLossPctOfPrice ?? d.returnLossPctOfPrice ?? 50;
  const minRef = rules.fba.referral.minFee;

  const perUnit = {
    productCost: input.supplier.unitCost,
    packaging,
    inspection: ((input.supplier.inspectionFlat ?? 0) + (input.supplier.samplesFlat ?? 0)) / qty,
    freight: freight.chosen.perUnit,
    duty: duty.total / qty,
    customs: customsTotal / qty,
    inbound: fba.inboundPlacement,
    unitLanded: 0,
  };
  perUnit.unitLanded = perUnit.productCost + perUnit.packaging + perUnit.inspection + perUnit.freight + perUnit.duty + perUnit.customs + perUnit.inbound;

  const sellingAt = (p: number) => ({
    referral: Math.max(minRef, p * fba.referralPct / 100),
    fulfillment: fba.fulfillment,
    storage: fba.storagePerUnit,
    marketing: p * tacosPct / 100,
    returns: p * returnRatePct / 100 * returnLossPct / 100,
  });
  const contributionAt = (p: number) => {
    const s = sellingAt(p);
    return p - perUnit.unitLanded - s.referral - s.fulfillment - s.storage - s.marketing - s.returns;
  };

  const selling = sellingAt(price);
  const contribution = contributionAt(price);
  const variablePct = fba.referralPct + tacosPct + returnRatePct * returnLossPct / 100;
  const breakeven = variablePct < 100 ? (perUnit.unitLanded + selling.fulfillment + selling.storage) / (1 - variablePct / 100) : Infinity;

  const naiveMarginPct = (price - input.supplier.unitCost) / price * 100;
  const marginPct = contribution / price * 100;
  if (naiveMarginPct - marginPct > 15) {
    warnings.push(`Naive margin (price vs factory) is ${naiveMarginPct.toFixed(0)}%; true contribution after landed cost, fees and ads is ${marginPct.toFixed(0)}%.`);
  }
  if (duty.effectivePct >= 30) warnings.push(`Stacked duty is ${duty.effectivePct}% of customs value — check country-of-origin alternatives (VN, IN, MX).`);

  const r = round2;
  const waterfall = [
    { label: 'Sale price', amount: r(price) },
    { label: 'Factory + packaging', amount: -r(perUnit.productCost + perUnit.packaging) },
    { label: 'Freight', amount: -r(perUnit.freight) },
    { label: 'Duty', amount: -r(perUnit.duty) },
    { label: 'Customs, QC, inbound', amount: -r(perUnit.customs + perUnit.inspection + perUnit.inbound) },
    { label: 'Amazon fees', amount: -r(selling.referral + selling.fulfillment + selling.storage) },
    { label: 'Ads (TACOS)', amount: -r(selling.marketing) },
    { label: 'Returns', amount: -r(selling.returns) },
    { label: 'Contribution', amount: r(contribution) },
  ];

  const priceSensitivity = [];
  for (let k = -30; k <= 30; k += 5) {
    const p = price * (1 + k / 100);
    const c = contributionAt(p);
    priceSensitivity.push({ price: r(p), contribution: r(c), marginPct: r(c / p * 100) });
  }

  return {
    quantity: qty,
    perUnit: Object.fromEntries(Object.entries(perUnit).map(([k, v]) => [k, r(v)])) as LandedCost['perUnit'],
    sellingPerUnit: Object.fromEntries(Object.entries(selling).map(([k, v]) => [k, r(v)])) as LandedCost['sellingPerUnit'],
    duty: duty.lines,
    dutyEffectivePct: duty.effectivePct,
    customsLines,
    freight,
    fba,
    contributionPerUnit: r(contribution),
    contributionMarginPct: r(marginPct),
    naiveMarginPct: r(naiveMarginPct),
    salesStart,
    roiPct: r(contribution / perUnit.unitLanded * 100),
    breakevenPrice: r(breakeven),
    waterfall,
    priceSensitivity,
    warnings,
  };
}
