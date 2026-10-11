/**
 * Freight math — deterministic and assumption-driven. Carton dims → CBM / chargeable weight → quote per mode.
 * 'auto' picks the cheapest per-unit ocean option (LCL vs FCL 20' vs 40'HQ); air/express are always shown for comparison.
 */
import type { AssumptionOverrides, DealInput, FreightMode, FreightQuote, FreightResult, Ruleset } from './types.ts';
import { round2 } from './util.ts';

export function computeFreight(input: Pick<DealInput, 'carton' | 'supplier' | 'freight'>, rules: Ruleset, ov: Partial<AssumptionOverrides> = {}): FreightResult {
  const { carton } = input;
  const qty = input.supplier.moq;
  if (carton.unitsPerCarton <= 0) throw new Error('unitsPerCarton must be > 0');
  const cartons = Math.ceil(qty / carton.unitsPerCarton);
  const cartonCm3 = carton.lengthCm * carton.widthCm * carton.heightCm;
  const totalCbm = cartons * cartonCm3 / 1e6;
  const totalKg = cartons * carton.weightKg;
  const m = rules.freight.modes;
  const delivery = (cbm: number) => cbm * rules.freight.destinationDeliveryPerCbm;

  const q = (mode: FreightMode, label: string, total: number, transitDays: number, detail: string, includesBrokerage: boolean): FreightQuote =>
    ({ mode, label, total: round2(total), perUnit: round2(total / qty), transitDays: ov.transitDays ?? transitDays, detail, includesBrokerage });

  const options: FreightQuote[] = [];

  // Express: chargeable = max(actual, volumetric /5000)
  {
    const vol = cartons * cartonCm3 / m.express.volumetricDivisor;
    const chg = Math.max(totalKg, vol);
    const rate = ov.expressRatePerKg ?? m.express.ratePerKg;
    options.push(q('express', m.express.label, chg * rate + m.express.fixed, m.express.transitDays,
      `${chg.toFixed(1)} kg chargeable × $${rate}/kg`, m.express.includesBrokerage));
  }
  // Air: chargeable = max(actual, volumetric /6000)
  {
    const vol = cartons * cartonCm3 / m.air.volumetricDivisor;
    const chg = Math.max(totalKg, vol);
    const rate = ov.airRatePerKg ?? m.air.ratePerKg;
    options.push(q('air', m.air.label, chg * rate + m.air.fixed + delivery(totalCbm), m.air.transitDays,
      `${chg.toFixed(1)} kg chargeable × $${rate}/kg + $${m.air.fixed} fixed + delivery`, m.air.includesBrokerage));
  }
  // LCL
  {
    const billable = Math.max(m.lcl.minCbm, totalCbm);
    const rate = ov.freightRatePerCbm ?? m.lcl.ratePerCbm;
    options.push(q('lcl', m.lcl.label, billable * rate + m.lcl.fixed + delivery(totalCbm), m.lcl.transitDays,
      `${billable.toFixed(2)} CBM × $${rate}/CBM + $${m.lcl.fixed} fixed + delivery`, m.lcl.includesBrokerage));
  }
  // FCL 20' / 40'HQ
  for (const mode of ['fcl20', 'fcl40hq'] as const) {
    const spec = m[mode];
    const containers = Math.max(1, Math.ceil(totalCbm / spec.usableCbm));
    const per = mode === 'fcl20' ? (ov.freightPerContainer20 ?? spec.perContainer) : (ov.freightPerContainer40 ?? spec.perContainer);
    options.push(q(mode, spec.label, containers * per + spec.fixed + delivery(totalCbm), spec.transitDays,
      `${containers} × $${per} + $${spec.fixed} fixed + delivery (${(totalCbm / (containers * spec.usableCbm) * 100).toFixed(0)}% utilised)`, spec.includesBrokerage));
  }

  let chosen: FreightQuote;
  if (input.freight.mode === 'auto') {
    chosen = options.filter(o => o.mode === 'lcl' || o.mode === 'fcl20' || o.mode === 'fcl40hq').sort((a, b) => a.perUnit - b.perUnit)[0];
  } else {
    const hit = options.find(o => o.mode === input.freight.mode);
    if (!hit) throw new Error(`Unknown freight mode ${input.freight.mode}`);
    chosen = hit;
  }
  return { cartons, totalCbm: round2(totalCbm), totalKg: round2(totalKg), chosen, options };
}
