/**
 * Compliance Engine — evaluated BEFORE economics. Category rules DB → required certs, gaps vs. certs held,
 * Amazon gating flags, IP risk, and freight-mode interactions (lithium on air/express).
 */
import type { ComplianceResult, DealInput, FreightMode, Ruleset } from './types.ts';

export function evaluateCompliance(input: DealInput, rules: Ruleset, freightMode?: FreightMode): ComplianceResult {
  const cat = rules.compliance.categories.find(c => c.id === input.product.complianceCategory);
  const held = new Set((input.compliance?.certsHeld ?? []).map(s => s.toLowerCase()));
  const ipFlags = input.compliance?.ipFlags ?? [];

  if (!cat) {
    return {
      category: input.product.complianceCategory, label: 'Unknown category', gating: 'none', items: [], gaps: [],
      amazonFlags: [], ipRisk: ipFlags, checklist: [],
      warnings: [`Category "${input.product.complianceCategory}" is not in the compliance rules DB — compliance is UNASSESSED, not clear.`],
      blockers: [], verified: false,
    };
  }

  const items = cat.required.map(r => ({ ...r, held: held.has(r.id.toLowerCase()) }));
  const gaps = items.filter(i => !i.held && !i.when).map(i => i.id);
  const warnings: string[] = [];
  const blockers: string[] = [];

  for (const i of items.filter(i => !i.held && i.when)) warnings.push(`If ${i.when}: ${i.label}`);
  if (cat.gating === 'restricted') blockers.push(`${cat.label} is restricted — resolve eligibility before any spend.`);
  if (cat.gating === 'approval') warnings.push(`Amazon category/product approval required for ${cat.label} (flags: ${cat.amazonFlags.join(', ') || 'n/a'}).`);
  if (cat.lithium && (freightMode === 'air' || freightMode === 'express')) {
    warnings.push('Lithium batteries by air/express: UN38.3 + SDS mandatory, DG surcharge applies, and some carriers refuse standalone cells.');
  }
  if (cat.lithium && !held.has('un38.3')) warnings.unshift('CRITICAL: no UN38.3 test summary — a lithium product cannot legally ship or pass Amazon hazmat review until the supplier provides one.');
  for (const f of ipFlags) warnings.push(`IP flag: ${f}`);

  return {
    category: cat.id, label: cat.label, gating: cat.gating, items, gaps,
    amazonFlags: cat.amazonFlags, ipRisk: [...cat.ipRisk, ...ipFlags], checklist: cat.checklist,
    warnings, blockers, verified: cat.verified ?? false,
  };
}
