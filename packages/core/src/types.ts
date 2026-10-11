/**
 * @iof/core types. Pure data shapes — no runtime code.
 * Money is USD. Freight dims are metric (cm/kg); Amazon unit dims are imperial (in/lb), matching each domain's source.
 */

export type PlaybookId = 'fba-private-label' | 'dropship';
export type OceanMode = 'lcl' | 'fcl20' | 'fcl40hq';
export type FreightMode = 'express' | 'air' | OceanMode;
export type FreightChoice = FreightMode | 'auto';
export type Verdict = 'Undertake' | 'Fix These First' | 'Pass';

// ───────────────────────────── Provenance ─────────────────────────────

export interface Provenance {
  source: string;               // 'user', 'rules:<id>', 'usitc', 'keepa', 'assumption:<table>'
  retrievedAt?: string;         // ISO timestamp for provider data
  cacheAgeSec?: number;
  verified?: boolean;           // false = seeded/secondary, needs primary check
}

// ───────────────────────────── Deal input ─────────────────────────────

export interface DealInput {
  playbook: PlaybookId;
  asOf: string;                              // ISO date — rules are evaluated as of this date
  product: {
    name: string;
    complianceCategory: string;              // id in compliance-us.json
    amazonCategory?: string;                 // referral-fee category; defaults from compliance category
    htsCode: string;
    origin: string;                          // ISO-2, e.g. 'CN'
    mfnRatePct?: number;                     // overrides offline HTS table (e.g. from USITC lookup)
    metalContentPct?: number;                // share of customs value that is steel/aluminum (Section 232)
  };
  supplier: {
    unitCost: number;                        // FOB per unit at this MOQ
    moq: number;                             // order quantity for this underwriting
    packagingPerUnit?: number;               // if billed by supplier, dutiable
    inspectionFlat?: number;                 // third-party QC
    samplesFlat?: number;
    productionDays: number;
    depositPct: number;                      // e.g. 30
  };
  carton: { lengthCm: number; widthCm: number; heightCm: number; weightKg: number; unitsPerCarton: number };
  unitPackage: { lengthIn: number; widthIn: number; heightIn: number; weightLb: number };
  freight: { mode: FreightChoice };
  sales: {
    price: number;
    unitsPerMonth: number;                   // your expected sell-through
    tacosPct?: number;                       // total ad cost as % of revenue (FBA)
    returnRatePct?: number;
  };
  dropship?: {
    cpm: number;                             // $ per 1000 impressions
    ctrPct: number;
    cvrPct: number;
    unitsPerOrder?: number;
  };
  market?: {
    monthlySearches?: number;
    medianReviewsTop10?: number;
    reviewGrowthPct90d?: number;             // growth of top-10 review counts (saturation)
    priceErosionPct90d?: number;             // negative = prices falling
    searchTrendPct12m?: number;              // momentum
  };
  compliance?: { certsHeld?: string[]; ipFlags?: string[] };
  timing?: { targetLiveDate?: string; checkInDays?: number; bufferDays?: number };
  overrides?: Partial<AssumptionOverrides>;
}

/** Every assumption the report uses can be overridden per deal (the "editable assumptions" table). */
export interface AssumptionOverrides {
  freightRatePerCbm: number;
  freightPerContainer20: number;
  freightPerContainer40: number;
  airRatePerKg: number;
  expressRatePerKg: number;
  brokeragePerEntry: number;
  fbaFulfillmentFee: number;
  referralPct: number;
  storageMonthsAvg: number;
  returnLossPctOfPrice: number;
  transitDays: number;
}

// ───────────────────────────── Rules shapes ─────────────────────────────

export interface Dated { id: string; effectiveFrom: string; effectiveTo: string | null; source?: string; verified?: boolean }

export interface TariffRule extends Dated {
  program: 'section301' | 'section232' | 'section122' | 'ieepa' | 'adcvd' | string;
  label: string;
  origin: string[];
  hsPrefixes: string[];
  excludeHsPrefixes?: string[];
  ratePct: number;
  basis: 'customsValue' | 'metalContent';
  supersedes?: string;
}

export interface FbaRateCard extends Dated {
  inheritsFrom?: string;
  smallStandard?: { maxOz: number; fee: number }[];
  largeStandard?: { maxOz: number; fee: number }[];
  largeStandardOver3lb?: { base: number; per4ozAbove3lb: number };
  largeBulky?: { base: number; perLbAbove1: number };
  priceBandDelta?: Record<'under10' | 'over50', Record<SizeTier, number>>;
  tierDelta?: Record<'under10' | '10to50' | 'over50', Record<SizeTier, number>>;
}

export type SizeTier = 'smallStandard' | 'largeStandard' | 'largeBulky';

export interface ComplianceRequirement { id: string; label: string; authority: string; when?: string }
export interface ComplianceCategory {
  id: string; label: string; amazonCategory: string;
  gating: 'none' | 'approval' | 'restricted';
  lithium: boolean; verified?: boolean;
  required: ComplianceRequirement[];
  amazonFlags: string[]; ipRisk: string[]; checklist: string[];
}

export interface PlaybookDef {
  id: string; status: 'live' | 'planned'; label: string; question: string;
  weights?: Record<string, number>;
  defaults?: Record<string, number>;
}

export interface Ruleset {
  version: string;
  tariffs: { rules: TariffRule[] };
  hts: { entries: { hts: string; description: string; mfnPct: number; verified?: boolean }[] };
  customs: {
    formalEntryThreshold: number;
    mpf: (Dated & { ratePct: number; min: number; max: number; informalFlat: number })[];
    hmf: (Dated & { ratePct: number; appliesTo: string[] })[];
    deMinimis: (Dated & { origin: string[]; available: boolean; thresholdUsd?: number })[];
    assumptions: { brokeragePerEntry: number; isfFilingPerEntry: number; singleEntryBondPctOfValuePlusDuty: number; singleEntryBondMin: number };
  };
  fba: {
    tierLimits: {
      smallStandard: { maxLongestIn: number; maxMedianIn: number; maxShortestIn: number; maxOz: number };
      largeStandard: { maxLongestIn: number; maxMedianIn: number; maxShortestIn: number; maxOz: number };
      dimDivisor: number;
    };
    rateCards: FbaRateCard[];
    surcharges: (Dated & { label: string; pctOfFulfillment: number })[];
    peak: (Dated & { perUnitAdd: Record<SizeTier, number> })[];
    referral: { defaultPct: number; minFee: number; categories: Record<string, { pct: number; pctAbove10?: number; note?: string }> };
    storage: { standardPerCuFt: { janSep: number; octDec: number }; oversizePerCuFt: { janSep: number; octDec: number } };
    inboundPlacement: { standardPerUnit: number; oversizePerUnit: number };
  };
  freight: {
    modes: {
      express: { label: string; ratePerKg: number; volumetricDivisor: number; fixed: number; transitDays: number; includesBrokerage: boolean };
      air: { label: string; ratePerKg: number; volumetricDivisor: number; fixed: number; transitDays: number; includesBrokerage: boolean };
      lcl: { label: string; ratePerCbm: number; minCbm: number; fixed: number; transitDays: number; includesBrokerage: boolean };
      fcl20: { label: string; perContainer: number; usableCbm: number; fixed: number; transitDays: number; includesBrokerage: boolean };
      fcl40hq: { label: string; perContainer: number; usableCbm: number; fixed: number; transitDays: number; includesBrokerage: boolean };
    };
    destinationDeliveryPerCbm: number;
    fbaCheckInDays: number;
    customsClearanceDays: number;
    orderBufferDays: number;
    dropship: { parcelBaseUsd: number; parcelPerKgUsd: number; parcelTransitDays: number; carrierClearancePerParcel: number };
  };
  compliance: { categories: ComplianceCategory[] };
  playbooks: { playbooks: PlaybookDef[] };
}

// ───────────────────────────── Outputs ─────────────────────────────

export interface Line { label: string; amount: number; provenance: Provenance; note?: string }

export interface DutyLine extends Line {
  program: string;
  ratePct: number;
  basis: 'customsValue' | 'metalContent';
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface FreightQuote {
  mode: FreightMode;
  label: string;
  total: number;
  perUnit: number;
  transitDays: number;
  detail: string;
  includesBrokerage: boolean;
}

export interface FreightResult {
  cartons: number;
  totalCbm: number;
  totalKg: number;
  chosen: FreightQuote;
  options: FreightQuote[];
}

export interface FbaFees {
  sizeTier: SizeTier;
  shippingWeightOz: number;
  fulfillment: number;
  referralPct: number;
  storagePerUnit: number;
  inboundPlacement: number;
  lines: Line[];
}

export interface LandedCost {
  quantity: number;
  perUnit: {
    productCost: number; packaging: number; inspection: number; freight: number;
    duty: number; customs: number; inbound: number; unitLanded: number;
  };
  sellingPerUnit: { referral: number; fulfillment: number; storage: number; marketing: number; returns: number };
  duty: DutyLine[];
  dutyEffectivePct: number;
  customsLines: Line[];
  freight: FreightResult;
  fba?: FbaFees;
  contributionPerUnit: number;
  contributionMarginPct: number;
  naiveMarginPct: number;          // (price − factory cost) / price — the number sellers are usually shown
  salesStart: string;              // computed go-live date at FBA
  roiPct: number;
  breakevenPrice: number;
  waterfall: { label: string; amount: number }[];
  priceSensitivity: { price: number; contribution: number; marginPct: number }[];
  warnings: string[];
}

export interface ComplianceResult {
  category: string;
  label: string;
  gating: 'none' | 'approval' | 'restricted';
  items: (ComplianceRequirement & { held: boolean })[];
  gaps: string[];
  amazonFlags: string[];
  ipRisk: string[];
  checklist: string[];
  warnings: string[];
  blockers: string[];
  verified: boolean;
}

export interface CashEvent { day: number; label: string; amount: number }
export interface CashPlan {
  capitalRequired: number;
  capitalMultipleOfGoods: number;
  firstPayoutDay: number | null;
  paybackDay: number | null;
  sellThroughDays: number;
  cashConversionCycleDays: number | null;
  events: CashEvent[];
  curve: { day: number; cumulative: number }[];
  netProfit: number;
}

export interface OrderByResult {
  targetLiveDate: string;
  latestSafeOrderDate: string;
  daysFromAsOf: number;
  status: 'ok' | 'tight' | 'missed';
  breakdown: { label: string; days: number }[];
  message: string;
}

export interface SubScore { key: string; score: number | null; weight: number; why: string }
export interface ScoreResult {
  total: number;
  coveragePct: number;
  subscores: SubScore[];
  verdict: Verdict;
  drivers: string[];
}

export interface DropshipEconomics {
  perOrder: Line[];
  cac: number;
  contributionPerOrder: number;
  contributionMarginPct: number;
  breakevenCpa: number;
  deMinimisCheck: { available: boolean; preSuspensionContribution: number; delta: number; message: string };
  cash: { adFloat: number; payoutLagDays: number };
  warnings: string[];
}

export interface UnderwritingReport {
  rulesetVersion: string;
  generatedFor: string;
  asOf: string;
  playbook: PlaybookId;
  input: DealInput;
  verdict: Verdict;
  drivers: string[];
  score: ScoreResult;
  landed?: LandedCost;
  dropship?: DropshipEconomics;
  compliance: ComplianceResult;
  cash?: CashPlan;
  orderBy?: OrderByResult;
  risks: { key: string; level: 'low' | 'medium' | 'high' | 'unknown'; detail: string }[];
  assumptions: { key: string; value: number | string; provenance: Provenance }[];
  warnings: string[];
}
