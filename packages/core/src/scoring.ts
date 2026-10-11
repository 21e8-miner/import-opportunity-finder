/**
 * Scoring Engine v2 — playbook-weighted sub-scores. Missing inputs are EXCLUDED (weights renormalised) and reported
 * as reduced coverage, never filled with defaults. Margin uses true landed contribution.
 */
import type { ComplianceResult, DealInput, ScoreResult, SubScore, Verdict } from './types.ts';
import { clamp } from './util.ts';

export interface ScoreInputs {
  input: DealInput;
  weights: Record<string, number>;
  contributionMarginPct: number;
  targetMarginPct: number;
  dutyEffectivePct: number;
  compliance: ComplianceResult;
  orderByStatus?: 'ok' | 'tight' | 'missed';
  roiPct?: number;
}

const logScale = (v: number, lo: number, hi: number) => clamp((Math.log10(Math.max(v, 1)) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo)) * 100, 0, 100);

export function score(si: ScoreInputs): ScoreResult {
  const m = si.input.market ?? {};
  const subs: SubScore[] = [];
  const add = (key: string, s: number | null, why: string) => subs.push({ key, score: s === null ? null : Math.round(s), weight: si.weights[key] ?? 0, why });

  // Margin: 0% → 0, 2× target → 100
  add('margin', clamp(si.contributionMarginPct / (si.targetMarginPct * 2) * 100, 0, 100),
    `${si.contributionMarginPct.toFixed(1)}% true contribution margin (target ${si.targetMarginPct}%)`);

  // Demand: monthly searches preferred; fall back to user's own sell-through estimate is NOT market demand → excluded.
  add('demand', m.monthlySearches !== undefined ? logScale(m.monthlySearches, 1_000, 100_000) : null,
    m.monthlySearches !== undefined ? `${m.monthlySearches.toLocaleString()} monthly searches` : 'no market demand data (connect a provider or enter searches)');

  // Competition: median reviews of top-10 incumbents — fewer = easier entry; fast review growth = saturating.
  if (m.medianReviewsTop10 !== undefined) {
    let c = 100 - logScale(m.medianReviewsTop10, 100, 10_000);
    if (m.reviewGrowthPct90d !== undefined && m.reviewGrowthPct90d > 25) c -= 15;
    add('competition', clamp(c, 0, 100), `top-10 median ${m.medianReviewsTop10.toLocaleString()} reviews${m.reviewGrowthPct90d !== undefined ? `, +${m.reviewGrowthPct90d}% in 90d` : ''}`);
  } else add('competition', null, 'no incumbent review data');

  // Risk: start at 100, subtract for compliance, duty exposure, price erosion, timing.
  {
    let r = 100; const why: string[] = [];
    if (si.compliance.blockers.length) { r -= 60; why.push('blocking compliance issue'); }
    if (si.compliance.gating === 'approval') { r -= 10; why.push('category approval'); }
    if (si.compliance.gaps.length) { r -= Math.min(30, si.compliance.gaps.length * 8); why.push(`${si.compliance.gaps.length} cert gap(s)`); }
    if (si.compliance.ipRisk.length) { r -= 5; why.push('IP risk noted'); }
    if (si.dutyEffectivePct >= 30) { r -= 10; why.push(`${si.dutyEffectivePct}% duty stack (policy-volatile)`); }
    if (m.priceErosionPct90d !== undefined && m.priceErosionPct90d < -5) { r -= 15; why.push(`price eroding ${m.priceErosionPct90d}%/90d`); }
    if (si.orderByStatus === 'missed') { r -= 15; why.push('launch window missed'); }
    if (si.compliance.category && !si.compliance.items.length && si.compliance.label === 'Unknown category') { r -= 10; why.push('compliance unassessed'); }
    add('risk', clamp(r, 0, 100), why.length ? why.join('; ') : 'no major risk flags');
  }

  add('momentum', m.searchTrendPct12m !== undefined ? clamp(50 + m.searchTrendPct12m, 0, 100) : null,
    m.searchTrendPct12m !== undefined ? `${m.searchTrendPct12m > 0 ? '+' : ''}${m.searchTrendPct12m}% search trend (12m)` : 'no trend data');

  if (si.weights.capitalEfficiency !== undefined) {
    add('capitalEfficiency', si.roiPct !== undefined ? clamp(si.roiPct, 0, 100) : null, si.roiPct !== undefined ? `${si.roiPct.toFixed(0)}% ROI per turn` : 'n/a');
  }

  const scored = subs.filter(s => s.score !== null && s.weight > 0);
  const wSum = scored.reduce((a, s) => a + s.weight, 0);
  const total = wSum ? Math.round(scored.reduce((a, s) => a + (s.score as number) * s.weight, 0) / wSum) : 0;
  const allW = subs.reduce((a, s) => a + s.weight, 0);
  const coveragePct = allW ? Math.round(wSum / allW * 100) : 0;

  const { verdict, drivers } = decide(si, total, subs);
  return { total, coveragePct, subscores: subs, verdict, drivers };
}

function decide(si: ScoreInputs, total: number, subs: SubScore[]): { verdict: Verdict; drivers: string[] } {
  const drivers: string[] = [];
  const c = si.compliance;
  let verdict: Verdict;
  if (c.blockers.length) { verdict = 'Pass'; drivers.push(...c.blockers); }
  else if (si.contributionMarginPct <= 0) { verdict = 'Pass'; drivers.push(`Loses money per unit (${si.contributionMarginPct.toFixed(1)}% contribution) after landed cost, fees and ads`); }
  else if (si.contributionMarginPct < si.targetMarginPct / 2) { verdict = 'Pass'; drivers.push(`Contribution margin ${si.contributionMarginPct.toFixed(1)}% is under half the ${si.targetMarginPct}% target — too thin to survive a price war or tariff change`); }
  else {
    const fixes: string[] = [];
    if (c.gaps.length) fixes.push(`Close ${c.gaps.length} compliance gap(s): ${c.gaps.join(', ')}`);
    if (c.warnings.some(w => w.startsWith('CRITICAL'))) fixes.push(c.warnings.find(w => w.startsWith('CRITICAL')) as string);
    if (si.contributionMarginPct < si.targetMarginPct) fixes.push(`Margin ${si.contributionMarginPct.toFixed(1)}% below ${si.targetMarginPct}% target — negotiate unit cost, change freight mode or raise price`);
    if (si.orderByStatus === 'missed') fixes.push('Launch window missed with this freight mode');
    if (total < 60) fixes.push(`Composite score ${total}/100`);
    verdict = fixes.length ? 'Fix These First' : 'Undertake';
    drivers.push(...fixes);
  }
  // Fill to 3 drivers with the strongest/weakest sub-scores.
  const ranked = subs.filter(s => s.score !== null).sort((a, b) => verdict === 'Undertake' ? (b.score as number) - (a.score as number) : (a.score as number) - (b.score as number));
  for (const s of ranked) { if (drivers.length >= 3) break; drivers.push(`${s.key} ${s.score}/100 — ${s.why}`); }
  return { verdict, drivers: drivers.slice(0, 3) };
}
