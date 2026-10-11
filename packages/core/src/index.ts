/**
 * @iof/core — pure, deterministic underwriting engines. MIT. Zero dependencies, zero network calls.
 */
export * from './types.ts';
export { computeDuty, computeCustomsFees, deMinimisAvailable, lookupMfn } from './duty.ts';
export { computeFreight } from './freight.ts';
export { classifySizeTier, computeFbaFees, fulfillmentFee, referralPct } from './fba.ts';
export { computeLandedCost } from './landedCost.ts';
export { computeDropship } from './dropship.ts';
export { evaluateCompliance } from './compliance.ts';
export { cashPlan, latestSafeOrderDate } from './cash.ts';
export { score } from './scoring.ts';
export { underwrite } from './underwrite.ts';
export { isEffective, effective, addDays, diffDays } from './util.ts';
