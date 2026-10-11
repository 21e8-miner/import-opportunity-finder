/**
 * @iof/providers — network adapters. NOT part of the MIT pure core: anything that fetches lives here,
 * behind BYO keys (self-host) or pooled keys (hosted SaaS). Every value returned carries provenance.
 *
 * Guardrail: no scraping ships in this repo. Adapters only call documented APIs.
 */
import type { DealInput, Provenance } from '../../core/src/types.ts';

export interface Sourced<T> { value: T; provenance: Provenance }

// ─── tiny TTL cache (swap for Redis in the hosted build) ───
const cache = new Map<string, { at: number; data: unknown }>();
async function cached<T>(key: string, ttlSec: number, fetcher: () => Promise<T>): Promise<{ data: T; ageSec: number }> {
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < ttlSec * 1000) return { data: hit.data as T, ageSec: Math.round((now - hit.at) / 1000) };
  const data = await fetcher();
  cache.set(key, { at: now, data });
  return { data, ageSec: 0 };
}

async function getJson(url: string, timeoutMs = 10_000): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${new URL(url).host} responded ${res.status}`);
  return res.json();
}

// ─── USITC HTS (free, no key) ───
export interface HtsLookup { htsno: string; description: string; general: string; mfnRatePct: number | null }

/** Parses the HTSUS "General" column: "Free" → 0, "4.9%" → 4.9; specific/compound rates → null (needs manual entry). */
export function parseGeneralRate(general: string): number | null {
  const g = general.trim();
  if (/^free$/i.test(g)) return 0;
  const m = g.match(/^(\d+(?:\.\d+)?)%$/);
  return m ? Number(m[1]) : null;
}

export async function usitcLookup(htsCode: string): Promise<Sourced<HtsLookup | null>> {
  const code = htsCode.replace(/[^0-9.]/g, '');
  const url = `https://hts.usitc.gov/reststop/search?keyword=${encodeURIComponent(code)}`;
  const { data, ageSec } = await cached(`usitc:${code}`, 86_400, () => getJson(url));
  const rows = (Array.isArray(data) ? data : []) as { htsno?: string; description?: string; general?: string }[];
  const digits = code.replace(/\./g, '');
  // Most specific row with a General rate whose number is a prefix-match of the query (rates often sit on the 8-digit line).
  const row = rows
    .filter(r => r.htsno && r.general && digits.startsWith(r.htsno.replace(/\./g, '')))
    .sort((a, b) => (b.htsno as string).length - (a.htsno as string).length)[0]
    ?? rows.find(r => r.htsno && r.general);
  const value = row ? { htsno: row.htsno as string, description: row.description ?? '', general: row.general as string, mfnRatePct: parseGeneralRate(row.general as string) } : null;
  return { value, provenance: { source: 'usitc', retrievedAt: new Date().toISOString(), cacheAgeSec: ageSec, verified: true } };
}

// ─── Keepa (BYO key, €49+/mo) ───
export interface KeepaMarket { title: string; priceNow: number | null; priceAvg90: number | null; salesRank: number | null; reviewCount: number | null; market: Partial<NonNullable<DealInput['market']>> }

export async function keepaProduct(asin: string, key = process.env.KEEPA_API_KEY): Promise<Sourced<KeepaMarket>> {
  if (!key) throw new Error('KEEPA_API_KEY not set — Keepa is a BYO-key provider');
  const url = `https://api.keepa.com/product?key=${encodeURIComponent(key)}&domain=1&asin=${encodeURIComponent(asin)}&stats=90&rating=1`;
  const { data, ageSec } = await cached(`keepa:${asin}`, 3_600, () => getJson(url, 20_000));
  const p = (data as { products?: any[] }).products?.[0];
  if (!p) throw new Error(`Keepa returned no product for ${asin}`);
  const cents = (v: unknown) => (typeof v === 'number' && v > 0 ? v / 100 : null);
  const priceNow = cents(p.stats?.current?.[1]) ?? cents(p.stats?.current?.[0]);
  const priceAvg90 = cents(p.stats?.avg90?.[1]) ?? cents(p.stats?.avg90?.[0]);
  const rank = typeof p.stats?.current?.[3] === 'number' && p.stats.current[3] > 0 ? p.stats.current[3] : null;
  const reviews = typeof p.stats?.current?.[17] === 'number' && p.stats.current[17] >= 0 ? p.stats.current[17] : null;
  const market: KeepaMarket['market'] = {};
  if (priceNow && priceAvg90) market.priceErosionPct90d = Math.round((priceNow - priceAvg90) / priceAvg90 * 1000) / 10;
  return {
    value: { title: p.title ?? asin, priceNow, priceAvg90, salesRank: rank, reviewCount: reviews, market },
    provenance: { source: 'keepa', retrievedAt: new Date().toISOString(), cacheAgeSec: ageSec, verified: true },
  };
}
