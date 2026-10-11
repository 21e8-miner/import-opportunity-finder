import type { Dated } from './types.ts';

export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
export const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** A dated rule is in force on `asOf` when effectiveFrom <= asOf < effectiveTo (null = open-ended). ISO dates compare lexically. */
export function isEffective(rule: Pick<Dated, 'effectiveFrom' | 'effectiveTo'>, asOf: string): boolean {
  const d = asOf.slice(0, 10);
  return rule.effectiveFrom <= d && (rule.effectiveTo === null || d < rule.effectiveTo);
}

/** Pick the single in-force entry from a dated series; throws if none (missing data must never silently default). */
export function effective<T extends Pick<Dated, 'effectiveFrom' | 'effectiveTo' | 'id'>>(series: T[], asOf: string, what: string): T {
  const hits = series.filter(r => isEffective(r, asOf));
  if (!hits.length) throw new Error(`No ${what} rule in force on ${asOf}`);
  return hits.sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
}

export const normalizeHs = (hts: string): string => hts.replace(/[^0-9]/g, '');

export const matchesOrigin = (origins: string[], origin: string): boolean =>
  origins.includes('*') || origins.includes(origin.toUpperCase());

export const matchesHs = (prefixes: string[], hts: string): boolean => {
  const h = normalizeHs(hts);
  return prefixes.some(p => p === '*' || h.startsWith(normalizeHs(p)));
};

const DAY_MS = 86_400_000;
export function addDays(iso: string, days: number): string {
  const t = Date.parse(iso.slice(0, 10) + 'T00:00:00Z') + days * DAY_MS;
  return new Date(t).toISOString().slice(0, 10);
}
export function diffDays(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(toIso.slice(0, 10) + 'T00:00:00Z') - Date.parse(fromIso.slice(0, 10) + 'T00:00:00Z')) / DAY_MS);
}
