/**
 * Duty pipeline: MFN base + every dated overlay program in force (301 / 232 / 122 / IEEPA history …),
 * returned as transparent line items. Rates come only from the Ruleset — never from code.
 */
import type { DutyLine, FreightMode, Line, Ruleset } from './types.ts';
import { effective, isEffective, matchesHs, matchesOrigin, normalizeHs, round2 } from './util.ts';

export interface DutyContext {
  htsCode: string;
  origin: string;
  customsValue: number;      // transaction value (FOB) of the goods on this entry
  asOf: string;
  mfnRatePct?: number;       // provider/user override
  metalContentPct?: number;  // Section 232 basis
}

export function lookupMfn(rules: Ruleset, htsCode: string): { ratePct: number; hts: string; verified: boolean } | null {
  const h = normalizeHs(htsCode);
  if (h.length < 6) return null;
  // exact → entries that extend the user's code → the user's code extends an entry (longest first)
  const entries = rules.hts.entries.map(e => ({ ...e, n: normalizeHs(e.hts) }));
  const hit = entries.find(e => e.n === h)
    ?? entries.find(e => e.n.startsWith(h))
    ?? entries.filter(e => h.startsWith(e.n)).sort((a, b) => b.n.length - a.n.length)[0];
  return hit ? { ratePct: hit.mfnPct, hts: hit.hts, verified: hit.verified ?? false } : null;
}

export function computeDuty(ctx: DutyContext, rules: Ruleset): { lines: DutyLine[]; total: number; effectivePct: number; warnings: string[] } {
  const warnings: string[] = [];
  const lines: DutyLine[] = [];
  const v = ctx.customsValue;

  // 1. MFN base (column 1 general)
  let mfnPct = ctx.mfnRatePct;
  let mfnSource = 'user';
  let mfnVerified = true;
  if (mfnPct === undefined) {
    const hit = lookupMfn(rules, ctx.htsCode);
    if (hit) { mfnPct = hit.ratePct; mfnSource = `rules:hts-sample ${hit.hts}`; mfnVerified = hit.verified; }
  }
  if (mfnPct === undefined) {
    warnings.push(`MFN rate for HTS ${ctx.htsCode} unknown — look it up (USITC) and enter it; duty below excludes MFN.`);
    mfnPct = 0; mfnSource = 'missing'; mfnVerified = false;
  }
  lines.push({
    label: `MFN (HTSUS ${ctx.htsCode})`, program: 'mfn', ratePct: mfnPct, basis: 'customsValue',
    amount: round2(v * mfnPct / 100), effectiveFrom: '—', effectiveTo: null,
    provenance: { source: mfnSource, verified: mfnVerified },
  });

  // 2. Overlay programs in force on asOf
  const inForce = rules.tariffs.rules.filter(r =>
    isEffective(r, ctx.asOf) && matchesOrigin(r.origin, ctx.origin) && matchesHs(r.hsPrefixes, ctx.htsCode)
    && !(r.excludeHsPrefixes && matchesHs(r.excludeHsPrefixes, ctx.htsCode)));
  const superseded = new Set(inForce.map(r => r.supersedes).filter(Boolean));

  for (const r of inForce) {
    if (superseded.has(r.id)) continue;
    let base = v;
    let note: string | undefined;
    if (r.basis === 'metalContent') {
      if (ctx.metalContentPct === undefined) {
        warnings.push(`${r.label} may apply to HTS ${ctx.htsCode}: enter metal content % (steel/aluminum share of value) to compute it.`);
        base = 0; note = 'metal content % not provided';
      } else {
        base = v * ctx.metalContentPct / 100;
        note = `${ctx.metalContentPct}% metal content`;
      }
    }
    lines.push({
      label: r.label, program: r.program, ratePct: r.ratePct, basis: r.basis,
      amount: round2(base * r.ratePct / 100), effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo,
      provenance: { source: `rules:${r.id}`, verified: r.verified ?? false }, note,
    });
  }

  const total = round2(lines.reduce((s, l) => s + l.amount, 0));
  return { lines, total, effectivePct: v > 0 ? round2(total / v * 100) : 0, warnings };
}

export interface CustomsContext {
  entryValue: number;
  dutyTotal: number;
  mode: FreightMode;
  asOf: string;
  includesBrokerage: boolean;
  brokerageOverride?: number;
}

/** Per-entry customs fees: MPF (formal/informal), HMF (ocean), brokerage, ISF (ocean), single-entry bond. */
export function computeCustomsFees(ctx: CustomsContext, rules: Ruleset): Line[] {
  const c = rules.customs;
  const out: Line[] = [];
  const formal = ctx.entryValue > c.formalEntryThreshold;
  const mpf = effective(c.mpf, ctx.asOf, 'MPF');
  const ocean = ctx.mode === 'lcl' || ctx.mode === 'fcl20' || ctx.mode === 'fcl40hq';

  if (formal) {
    const raw = ctx.entryValue * mpf.ratePct / 100;
    out.push({ label: `MPF ${mpf.ratePct}% (min $${mpf.min}, max $${mpf.max})`, amount: round2(Math.min(mpf.max, Math.max(mpf.min, raw))), provenance: { source: `rules:${mpf.id}`, verified: mpf.verified } });
  } else {
    out.push({ label: 'MPF (informal entry)', amount: mpf.informalFlat, provenance: { source: `rules:${mpf.id}`, verified: mpf.verified } });
  }

  if (ocean) {
    for (const h of c.hmf.filter(h => isEffective(h, ctx.asOf) && h.appliesTo.includes(ctx.mode))) {
      out.push({ label: `HMF ${h.ratePct}%`, amount: round2(ctx.entryValue * h.ratePct / 100), provenance: { source: `rules:${h.id}`, verified: h.verified } });
    }
    out.push({ label: 'ISF (10+2) filing', amount: c.assumptions.isfFilingPerEntry, provenance: { source: 'assumption:customs', verified: false } });
  }

  if (!ctx.includesBrokerage) {
    out.push({ label: 'Customs brokerage', amount: ctx.brokerageOverride ?? c.assumptions.brokeragePerEntry, provenance: { source: ctx.brokerageOverride !== undefined ? 'user' : 'assumption:customs', verified: false } });
  }

  if (formal) {
    const bond = Math.max(c.assumptions.singleEntryBondMin, (ctx.entryValue + ctx.dutyTotal) * c.assumptions.singleEntryBondPctOfValuePlusDuty / 100);
    out.push({ label: 'Single-entry bond', amount: round2(bond), provenance: { source: 'assumption:customs', verified: false }, note: 'Use an annual continuous bond once you import regularly' });
  }
  return out;
}

/** De minimis availability for a parcel on asOf (dropship reality check). */
export function deMinimisAvailable(rules: Ruleset, origin: string, asOf: string, parcelValue: number): { available: boolean; ruleId: string } {
  const inForce = rules.customs.deMinimis
    .filter(d => isEffective(d, asOf) && matchesOrigin(d.origin, origin))
    // most specific origin wins, then most recent
    .sort((a, b) => (a.origin.includes('*') ? 1 : 0) - (b.origin.includes('*') ? 1 : 0) || b.effectiveFrom.localeCompare(a.effectiveFrom));
  const r = inForce[0];
  if (!r) return { available: false, ruleId: 'none' };
  return { available: r.available && parcelValue <= (r.thresholdUsd ?? Infinity), ruleId: r.id };
}
