/**
 * CLI: underwrite a deal JSON and print the report summary (or full JSON with --json).
 *   node apps/cli/underwrite.ts packages/core/fixtures/earbuds-fba.json [--json]
 */
import { readFileSync } from 'node:fs';
import { underwrite } from '../../packages/core/src/index.ts';
import { rules } from '../../packages/rules/src/index.ts';

const [file, flag] = process.argv.slice(2);
if (!file) { console.error('usage: node apps/cli/underwrite.ts <deal.json> [--json]'); process.exit(2); }
const r = underwrite(JSON.parse(readFileSync(file, 'utf8')), rules);
if (flag === '--json') { console.log(JSON.stringify(r, null, 2)); process.exit(0); }

const $ = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
console.log(`\n${r.generatedFor}  ·  ${r.playbook}  ·  rules ${r.rulesetVersion} as of ${r.asOf}`);
console.log(`\nVERDICT: ${r.verdict.toUpperCase()}   score ${r.score.total}/100 (data coverage ${r.score.coveragePct}%)`);
r.drivers.forEach(d => console.log(`  • ${d}`));
if (r.landed) {
  const l = r.landed;
  console.log(`\nUnit economics @ ${$(r.input.sales.price)}`);
  l.waterfall.forEach(w => console.log(`  ${w.label.padEnd(24)} ${$(w.amount).padStart(10)}`));
  console.log(`  naive margin ${l.naiveMarginPct}%  →  true contribution ${l.contributionMarginPct}%   breakeven ${$(l.breakevenPrice)}`);
  console.log(`\nDuty (${l.dutyEffectivePct}% of customs value)`);
  l.duty.forEach(d => console.log(`  ${d.label.padEnd(56)} ${String(d.ratePct + '%').padStart(6)} ${$(d.amount).padStart(10)}  since ${d.effectiveFrom}`));
}
if (r.dropship) {
  const d = r.dropship;
  console.log('\nPer order');
  d.perOrder.forEach(l => console.log(`  ${l.label.padEnd(44)} ${$(l.amount).padStart(9)}`));
  console.log(`  contribution ${$(d.contributionPerOrder)} (${d.contributionMarginPct}%)   breakeven CPA ${$(d.breakevenCpa)}`);
  console.log(`  ${d.deMinimisCheck.message}`);
}
if (r.cash) console.log(`\nCash: capital required ${$(r.cash.capitalRequired)} (${r.cash.capitalMultipleOfGoods}× goods) · first payout day ${r.cash.firstPayoutDay} · payback day ${r.cash.paybackDay} · CCC ${r.cash.cashConversionCycleDays}d · net ${$(r.cash.netProfit)}`);
if (r.orderBy) console.log(`Order-by: ${r.orderBy.message}`);
if (r.compliance.gaps.length) console.log(`Compliance gaps: ${r.compliance.gaps.join(', ')}`);
if (r.warnings.length) { console.log('\nWarnings'); r.warnings.forEach(w => console.log(`  ! ${w}`)); }
console.log('');
