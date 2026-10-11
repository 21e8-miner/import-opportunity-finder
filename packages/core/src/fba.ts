/**
 * Amazon FBA fees from versioned config: size tier → fulfillment fee (rate card + price band + surcharges + peak overlap),
 * referral fee, inventory-weighted monthly storage, inbound placement.
 */
import type { AssumptionOverrides, DealInput, FbaFees, FbaRateCard, Line, Ruleset, SizeTier } from './types.ts';
import { addDays, effective, isEffective, round2 } from './util.ts';

export function classifySizeTier(pkg: DealInput['unitPackage'], rules: Ruleset): { tier: SizeTier; shippingWeightOz: number } {
  const lim = rules.fba.tierLimits;
  const [longest, median, shortest] = [pkg.lengthIn, pkg.widthIn, pkg.heightIn].sort((a, b) => b - a);
  const unitOz = pkg.weightLb * 16;
  const dimOz = (pkg.lengthIn * pkg.widthIn * pkg.heightIn / lim.dimDivisor) * 16;
  const s = lim.smallStandard;
  if (longest <= s.maxLongestIn && median <= s.maxMedianIn && shortest <= s.maxShortestIn && unitOz <= s.maxOz) {
    return { tier: 'smallStandard', shippingWeightOz: unitOz };
  }
  const l = lim.largeStandard;
  const shipOz = Math.max(unitOz, dimOz);
  if (longest <= l.maxLongestIn && median <= l.maxMedianIn && shortest <= l.maxShortestIn && shipOz <= l.maxOz) {
    return { tier: 'largeStandard', shippingWeightOz: shipOz };
  }
  return { tier: 'largeBulky', shippingWeightOz: shipOz };
}

const band = (price: number): 'under10' | '10to50' | 'over50' => price < 10 ? 'under10' : price <= 50 ? '10to50' : 'over50';

function baseFee(card: FbaRateCard, tier: SizeTier, oz: number): number {
  if (tier === 'smallStandard' && card.smallStandard) {
    const step = card.smallStandard.find(s => oz <= s.maxOz);
    if (step) return step.fee;
  }
  if (tier !== 'largeBulky' && card.largeStandard) {
    const step = card.largeStandard.find(s => oz <= s.maxOz);
    if (step) return step.fee;
    if (card.largeStandardOver3lb) return card.largeStandardOver3lb.base + Math.ceil((oz - 48) / 4) * card.largeStandardOver3lb.per4ozAbove3lb;
  }
  if (!card.largeBulky) throw new Error(`Rate card ${card.id} lacks large bulky table`);
  return card.largeBulky.base + Math.max(0, Math.ceil(oz / 16) - 1) * card.largeBulky.perLbAbove1;
}

export function fulfillmentFee(tier: SizeTier, oz: number, price: number, asOf: string, rules: Ruleset): { fee: number; cardId: string; verified: boolean } {
  const card = effective(rules.fba.rateCards, asOf, 'FBA rate card');
  const base = card.inheritsFrom ? rules.fba.rateCards.find(c => c.id === card.inheritsFrom) : card;
  if (!base) throw new Error(`Rate card ${card.inheritsFrom} not found`);
  const b = band(price);
  let fee = baseFee(base, tier, oz);
  if (b !== '10to50' && base.priceBandDelta) fee += base.priceBandDelta[b][tier] ?? 0;
  if (card.tierDelta) fee += card.tierDelta[b][tier] ?? 0;
  for (const s of rules.fba.surcharges.filter(s => isEffective(s, asOf))) fee *= 1 + s.pctOfFulfillment / 100;
  return { fee: round2(fee), cardId: card.id, verified: (card.verified ?? false) && (base.verified ?? false) };
}

export function referralPct(amazonCategory: string | undefined, price: number, rules: Ruleset): number {
  const cat = amazonCategory ? rules.fba.referral.categories[amazonCategory] : undefined;
  if (!cat) return rules.fba.referral.defaultPct;
  return cat.pctAbove10 !== undefined && price > 10 ? cat.pctAbove10 : cat.pct;
}

export interface FbaContext {
  unitPackage: DealInput['unitPackage'];
  price: number;
  amazonCategory?: string;
  quantity: number;
  unitsPerMonth: number;
  salesStart: string;            // date inventory goes live at FBA
  asOf: string;                  // date for rate-card resolution
}

export function computeFbaFees(ctx: FbaContext, rules: Ruleset, ov: Partial<AssumptionOverrides> = {}): FbaFees {
  const { tier, shippingWeightOz } = classifySizeTier(ctx.unitPackage, rules);
  const lines: Line[] = [];

  // Fulfillment — use the card in force when sales begin (fees are charged at sale time).
  const ff = fulfillmentFee(tier, shippingWeightOz, ctx.price, ctx.salesStart > ctx.asOf ? ctx.salesStart : ctx.asOf, rules);
  let fulfillment = ov.fbaFulfillmentFee ?? ff.fee;
  lines.push({ label: `FBA fulfillment (${tier}, ${shippingWeightOz.toFixed(1)} oz)`, amount: fulfillment, provenance: { source: ov.fbaFulfillmentFee !== undefined ? 'user' : `rules:${ff.cardId}`, verified: ff.verified } });

  // Peak overlap: weight peak adders by the share of units sold inside the peak window.
  const sellDays = Math.max(1, Math.ceil(ctx.quantity / (ctx.unitsPerMonth / 30)));
  if (ov.fbaFulfillmentFee === undefined) {
    for (const p of rules.fba.peak) {
      let inPeak = 0;
      for (let d = 0; d < sellDays; d++) if (isEffective(p, addDays(ctx.salesStart, d))) inPeak++;
      if (inPeak > 0) {
        const add = round2((p.perUnitAdd[tier] ?? 0) * inPeak / sellDays);
        fulfillment = round2(fulfillment + add);
        lines.push({ label: `Holiday peak adder (${Math.round(inPeak / sellDays * 100)}% of sales in window)`, amount: add, provenance: { source: `rules:${p.id}`, verified: p.verified } });
      }
    }
  }

  const refPct = ov.referralPct ?? referralPct(ctx.amazonCategory, ctx.price, rules);

  // Storage: inventory declines linearly over the sell-through window; rate depends on calendar month.
  const cuFt = ctx.unitPackage.lengthIn * ctx.unitPackage.widthIn * ctx.unitPackage.heightIn / 1728;
  const rates = tier === 'largeBulky' ? rules.fba.storage.oversizePerCuFt : rules.fba.storage.standardPerCuFt;
  let storageTotal = 0;
  if (ov.storageMonthsAvg !== undefined) {
    storageTotal = ctx.quantity * cuFt * rates.janSep * ov.storageMonthsAvg;
  } else {
    const daily = ctx.unitsPerMonth / 30;
    for (let d = 0; d < sellDays; d++) {
      const month = Number(addDays(ctx.salesStart, d).slice(5, 7));
      const rate = month >= 10 ? rates.octDec : rates.janSep;
      storageTotal += Math.max(0, ctx.quantity - daily * d) * cuFt * rate / 30.4;
    }
  }
  const storagePerUnit = round2(storageTotal / ctx.quantity);
  lines.push({ label: `Monthly storage (${cuFt.toFixed(3)} ft³/unit, ${sellDays}d sell-through)`, amount: storagePerUnit, provenance: { source: 'rules:fba.storage', verified: false } });

  const inbound = tier === 'largeBulky' ? rules.fba.inboundPlacement.oversizePerUnit : rules.fba.inboundPlacement.standardPerUnit;
  lines.push({ label: 'Inbound placement', amount: inbound, provenance: { source: 'rules:fba.inboundPlacement', verified: false } });

  return { sizeTier: tier, shippingWeightOz: round2(shippingWeightOz), fulfillment, referralPct: refPct, storagePerUnit, inboundPlacement: inbound, lines };
}
