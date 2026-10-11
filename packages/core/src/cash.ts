/**
 * Capital & Cash Engine — day-by-day cash simulation of one PO from deposit to final Amazon payout,
 * plus the Latest Safe Order Date working backwards from a go-live target.
 */
import { leadTimeDays } from './landedCost.ts';
import type { CashEvent, CashPlan, DealInput, FreightQuote, LandedCost, OrderByResult, Ruleset } from './types.ts';
import { addDays, diffDays, round2 } from './util.ts';

const PAYOUT_CYCLE_DAYS = 14;
const PAYOUT_RESERVE_DAYS = 7;   // simplification of Amazon's delivery-date-based reserve

export function cashPlan(input: DealInput, landed: LandedCost, rules: Ruleset): CashPlan {
  const qty = landed.quantity;
  const goods = (input.supplier.unitCost + (input.supplier.packagingPerUnit ?? 0)) * qty;
  const dep = input.supplier.depositPct / 100;
  const lt = leadTimeDays(input, rules, landed.freight.chosen.transitDays);
  const shipDay = lt.production;
  const arriveDay = shipDay + lt.transit;
  const liveDay = arriveDay + lt.clearance + lt.checkIn;
  const dailyUnits = input.sales.unitsPerMonth / 30;
  if (dailyUnits <= 0) throw new Error('unitsPerMonth must be > 0');
  const sellThroughDays = Math.ceil(qty / dailyUnits);
  const s = landed.sellingPerUnit;
  const netToAmazonAccount = input.sales.price - s.referral - s.fulfillment - s.storage - s.returns;

  const events: CashEvent[] = [];
  const push = (day: number, label: string, amount: number) => { if (amount !== 0) events.push({ day, label, amount: round2(amount) }); };

  push(0, `Deposit ${input.supplier.depositPct}%`, -goods * dep);
  push(0, 'Samples', -(input.supplier.samplesFlat ?? 0));
  push(Math.max(0, shipDay - 2), 'Pre-shipment inspection', -(input.supplier.inspectionFlat ?? 0));
  push(shipDay, `Balance ${100 - input.supplier.depositPct}%`, -goods * (1 - dep));
  push(shipDay, `Freight (${landed.freight.chosen.label})`, -landed.freight.chosen.total);
  push(arriveDay, 'Duty', -landed.perUnit.duty * qty);
  push(arriveDay, 'Customs fees', -landed.perUnit.customs * qty);
  push(liveDay, 'FBA inbound placement', -landed.perUnit.inbound * qty);

  // Sales: ads paid daily out of pocket; proceeds accrue in the Amazon account and pay out biweekly with a reserve.
  const horizon = Math.min(1095, liveDay + sellThroughDays + PAYOUT_CYCLE_DAYS * 2 + PAYOUT_RESERVE_DAYS);
  const accrued: number[] = new Array(horizon + 1).fill(0);
  let sold = 0;
  for (let day = liveDay; day <= horizon && sold < qty; day++) {
    const u = Math.min(dailyUnits, qty - sold);
    sold += u;
    accrued[day] = u * netToAmazonAccount;
  }
  // collapse ads into weekly events to keep the event list readable
  let adBucket = 0, bucketStart = liveDay;
  sold = 0;
  for (let day = liveDay; day <= horizon && sold < qty; day++) {
    const u = Math.min(dailyUnits, qty - sold);
    sold += u;
    adBucket += u * s.marketing;
    if ((day - liveDay) % 7 === 6 || sold >= qty) { push(day, `Ads (week of day ${bucketStart})`, -adBucket); adBucket = 0; bucketStart = day + 1; }
  }
  let paidThrough = liveDay - 1;
  let firstPayoutDay: number | null = null;
  for (let day = liveDay + PAYOUT_CYCLE_DAYS; day <= horizon; day += PAYOUT_CYCLE_DAYS) {
    const cutoff = day - PAYOUT_RESERVE_DAYS;
    let amt = 0;
    for (let k = paidThrough + 1; k <= cutoff; k++) amt += accrued[k] ?? 0;
    paidThrough = cutoff;
    if (amt > 0) { push(day, 'Amazon payout', amt); firstPayoutDay ??= day; }
  }

  // Daily cumulative curve
  const byDay = new Map<number, number>();
  for (const e of events) byDay.set(e.day, (byDay.get(e.day) ?? 0) + e.amount);
  const lastDay = Math.max(...events.map(e => e.day));
  let cum = 0, min = 0, minDay = 0;
  const daily: number[] = [];
  for (let day = 0; day <= lastDay; day++) {
    cum += byDay.get(day) ?? 0;
    daily.push(cum);
    if (cum < min) { min = cum; minDay = day; }
  }
  let paybackDay: number | null = null;
  for (let day = minDay; day <= lastDay; day++) if (daily[day] >= 0) { paybackDay = day; break; }

  const outs = events.filter(e => e.amount < 0), ins = events.filter(e => e.amount > 0);
  const wMean = (es: CashEvent[]) => { const t = es.reduce((a, e) => a + Math.abs(e.amount), 0); return t ? es.reduce((a, e) => a + e.day * Math.abs(e.amount), 0) / t : 0; };
  const curve = daily.map((c, day) => ({ day, cumulative: round2(c) })).filter(p => p.day % 7 === 0 || p.day === lastDay || byDay.has(p.day));

  events.sort((a, b) => a.day - b.day);
  return {
    capitalRequired: round2(-min),
    capitalMultipleOfGoods: round2(-min / goods),
    firstPayoutDay,
    paybackDay,
    sellThroughDays,
    cashConversionCycleDays: ins.length ? Math.round(wMean(ins) - wMean(outs)) : null,
    events,
    curve,
    netProfit: round2(cum),
  };
}

/** Work backwards from a target go-live date: check-in + clearance + transit + production + buffer. */
export function latestSafeOrderDate(input: DealInput, rules: Ruleset, chosen: FreightQuote, options: FreightQuote[] = []): OrderByResult | undefined {
  const target = input.timing?.targetLiveDate;
  if (!target) return undefined;
  const buffer = input.timing?.bufferDays ?? rules.freight.orderBufferDays;
  const build = (q: FreightQuote) => {
    const lt = leadTimeDays(input, rules, q.transitDays);
    const breakdown = [
      { label: 'Supplier production', days: lt.production },
      { label: `Transit (${q.label})`, days: lt.transit },
      { label: 'Customs clearance', days: lt.clearance },
      { label: 'FBA check-in', days: lt.checkIn },
      { label: 'Safety buffer', days: buffer },
    ];
    const total = breakdown.reduce((a, b) => a + b.days, 0);
    const date = addDays(target, -total);
    return { breakdown, date, days: diffDays(input.asOf, date) };
  };
  const main = build(chosen);
  const status: OrderByResult['status'] = main.days < 0 ? 'missed' : main.days <= 14 ? 'tight' : 'ok';
  let message = status === 'missed'
    ? `Missed: with ${chosen.label} the PO needed to be placed by ${main.date} (${-main.days} days ago) to be live by ${target}.`
    : `Place the PO by ${main.date} (${main.days} days from ${input.asOf}) or you miss ${target}.`;
  if (status === 'missed') {
    const rescue = options.filter(o => o.transitDays < chosen.transitDays).map(o => ({ o, r: build(o) }))
      .filter(x => x.r.days >= 0).sort((a, b) => a.o.total - b.o.total)[0];
    message += rescue
      ? ` ${rescue.o.label} still makes it if ordered by ${rescue.r.date} (freight $${rescue.o.total.toLocaleString()} vs $${chosen.total.toLocaleString()}).`
      : ' No freight mode makes it — retarget the launch window.';
  }
  return { targetLiveDate: target, latestSafeOrderDate: main.date, daysFromAsOf: main.days, status, breakdown: main.breakdown, message };
}
