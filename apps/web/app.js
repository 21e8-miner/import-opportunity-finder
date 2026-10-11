const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n, d = 2) => Number.isFinite(+n) ? ((+n < 0 ? '-' : '') + '$' + Math.abs(+n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })) : '—';
const pct = (n, d = 1) => Number.isFinite(+n) ? `${(+n).toFixed(d)}%` : '—';
const provTag = p => !p ? '' : `<span class="prov ${p.verified === false ? 'unverified' : ''}">${p.verified === false ? '⚠ ' : ''}${esc(p.source)}</span>`;

let meta = null;
let deal = null;

const BLANK = () => ({
  playbook: 'fba-private-label',
  asOf: new Date().toISOString().slice(0, 10),
  product: { name: 'Unnamed product', complianceCategory: 'home-organization', htsCode: '3924.10.40.00', origin: 'CN' },
  supplier: { unitCost: 5, moq: 500, packagingPerUnit: 0.4, inspectionFlat: 300, samplesFlat: 100, productionDays: 25, depositPct: 30 },
  carton: { lengthCm: 50, widthCm: 40, heightCm: 35, weightKg: 12, unitsPerCarton: 25 },
  unitPackage: { lengthIn: 8, widthIn: 5, heightIn: 3, weightLb: 0.8 },
  freight: { mode: 'auto' },
  sales: { price: 29.99, unitsPerMonth: 200, tacosPct: 12, returnRatePct: 4 },
  dropship: { cpm: 8, ctrPct: 1.5, cvrPct: 2.5 },
  compliance: { certsHeld: [] },
  timing: {},
  market: {},
  overrides: {},
});

function getPath(obj, path) { return path.split('.').reduce((o, k) => o?.[k], obj); }
function setPath(obj, path, val) {
  const keys = path.split('.');
  const last = keys.pop();
  let cur = obj;
  for (const k of keys) cur = (cur[k] ??= {});
  if (val === undefined || val === '' || Number.isNaN(val)) delete cur[last];
  else cur[last] = val;
}

function syncFormFromDeal() {
  if (!deal) return;
  document.querySelectorAll('[data-path]').forEach(el => {
    const v = getPath(deal, el.dataset.path);
    el.value = v === undefined || v === null ? '' : v;
  });
  const isDs = deal.playbook === 'dropship';
  document.querySelectorAll('.fba-only').forEach(el => { el.style.display = isDs ? 'none' : ''; });
  document.querySelectorAll('.ds-only').forEach(el => { el.style.display = isDs ? '' : 'none'; });
  renderCertChecks();
}

function renderCertChecks() {
  const box = $('certChecks');
  if (!meta || !deal) { box.innerHTML = ''; return; }
  const cat = meta.categories.find(c => c.id === deal.product?.complianceCategory);
  const req = cat?.required ?? [];
  if (!req.length) { box.innerHTML = '<span class="sub">No mandatory certs listed for this category.</span>'; return; }
  const held = new Set(deal.compliance?.certsHeld ?? []);
  box.innerHTML = req.map(id => `<label><input type="checkbox" data-cert="${esc(id)}" ${held.has(id) ? 'checked' : ''} />${esc(id)}</label>`).join('');
  box.querySelectorAll('input[data-cert]').forEach(cb => cb.addEventListener('change', () => {
    const set = new Set(deal.compliance?.certsHeld ?? []);
    cb.checked ? set.add(cb.dataset.cert) : set.delete(cb.dataset.cert);
    (deal.compliance ??= {}).certsHeld = [...set];
    runUnderwrite();
  }));
}

function readFormIntoDeal() {
  if (!deal) deal = BLANK();
  document.querySelectorAll('[data-path]').forEach(el => {
    const p = el.dataset.path;
    const raw = el.value.trim();
    if (el.type === 'number') setPath(deal, p, raw === '' ? undefined : Number(raw));
    else setPath(deal, p, raw === '' ? undefined : raw);
  });
  if (deal.product?.origin) deal.product.origin = deal.product.origin.toUpperCase();
  if (deal.playbook === 'dropship') deal.dropship ??= { cpm: 8, ctrPct: 1.5, cvrPct: 2.5 };
}

async function runUnderwrite() {
  if (!deal) return;
  try {
    const res = await fetch('/api/underwrite', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(deal) });
    const r = await res.json();
    if (!res.ok) throw new Error(r.error || `HTTP ${res.status}`);
    $('statusBar').className = 'notice';
    $('statusBar').innerHTML = `<strong>${esc(r.generatedFor)}</strong> · playbook <code>${esc(r.playbook)}</code> · rules <code>${esc(r.rulesetVersion)}</code> evaluated as of <code>${esc(r.asOf)}</code> · score coverage ${r.score.coveragePct}%${deal._note ? ` · <em>${esc(deal._note)}</em>` : ''}`;
    renderReport(r);
  } catch (e) {
    $('statusBar').className = 'notice error';
    $('statusBar').textContent = 'Underwrite error: ' + e.message;
  }
}

function renderReport(r) {
  const vClass = r.verdict === 'Undertake' ? 'Undertake' : r.verdict === 'Pass' ? 'Pass' : 'Fix';
  const parts = [];

  // 1. Verdict + score + drivers
  parts.push(`<div class="panel">
    <div class="verdict-bar">
      <div>
        <span class="badge ${vClass}">${esc(r.verdict)}</span>
        <span class="sub" style="margin-left:8px">${esc(r.generatedFor)} · as of ${esc(r.asOf)}</span>
        <ol class="drivers">${r.drivers.map(d => `<li>${esc(d)}</li>`).join('')}</ol>
      </div>
      <div class="score-box">
        <div class="score-num">${r.score.total}<span style="font-size:16px;color:var(--muted)">/100</span></div>
        <div class="score-sub">${r.score.coveragePct}% data coverage</div>
      </div>
    </div>
    ${r.warnings.length ? `<ul class="warn-list">${r.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
  </div>`);

  // 2. Top-line stats
  if (r.landed) {
    const l = r.landed, c = r.cash;
    const mCls = l.contributionMarginPct >= 20 ? 'pos' : l.contributionMarginPct <= 0 ? 'neg' : 'warn-text';
    parts.push(`<div class="stats">
      <div class="stat"><div class="k">True contribution / unit</div><div class="v ${mCls}">${money(l.contributionPerUnit)} <span style="font-size:16px">(${pct(l.contributionMarginPct)})</span></div><div class="foot">Naive factory-vs-price margin was ${pct(l.naiveMarginPct, 0)} · breakeven ${money(l.breakevenPrice)}</div></div>
      <div class="stat"><div class="k">Unit landed cost</div><div class="v">${money(l.perUnit.unitLanded)}</div><div class="foot">FOB ${money(l.perUnit.productCost)} + freight ${money(l.perUnit.freight)} + duty ${money(l.perUnit.duty)} (${pct(l.dutyEffectivePct)})</div></div>
      <div class="stat"><div class="k">Working capital peak</div><div class="v">${money(c.capitalRequired, 0)}</div><div class="foot">${c.capitalMultipleOfGoods}× goods value · payback day ${c.paybackDay ?? 'never'} · CCC ${c.cashConversionCycleDays ?? '—'}d</div></div>
      <div class="stat"><div class="k">Latest safe PO date</div><div class="v ${r.orderBy?.status === 'missed' ? 'neg' : r.orderBy?.status === 'tight' ? 'warn-text' : ''}">${esc(r.orderBy?.latestSafeOrderDate ?? '—')}</div><div class="foot">${esc(r.orderBy ? r.orderBy.message : 'Set a target go-live date in the form')}</div></div>
    </div>`);
  } else if (r.dropship) {
    const d = r.dropship, dm = d.deMinimisCheck;
    const mCls = d.contributionPerOrder > 0 ? 'pos' : 'neg';
    parts.push(`<div class="stats">
      <div class="stat"><div class="k">Contribution / order</div><div class="v ${mCls}">${money(d.contributionPerOrder)} <span style="font-size:16px">(${pct(d.contributionMarginPct)})</span></div><div class="foot">At ${money(r.input.sales.price)} price</div></div>
      <div class="stat"><div class="k">De-minimis impact</div><div class="v ${dm.delta > 0 ? 'neg' : ''}">-${money(dm.delta)}/order</div><div class="foot">Pre-suspension contribution was ${money(dm.preSuspensionContribution)}</div></div>
      <div class="stat"><div class="k">Ad CAC vs breakeven CPA</div><div class="v ${d.cac > d.breakevenCpa ? 'neg' : 'pos'}">${money(d.cac)} / ${money(d.breakevenCpa)}</div><div class="foot">Max profitable CPA is ${money(d.breakevenCpa)}</div></div>
      <div class="stat"><div class="k">Ad + inventory float</div><div class="v">${money(d.cash.adFloat, 0)}</div><div class="foot">Across ${d.cash.payoutLagDays}-day payout lag</div></div>
    </div>
    <div class="notice ${d.contributionPerOrder <= 0 ? 'error' : ''}"><strong>Post-de-minimis reality check:</strong> ${esc(dm.message)}</div>`);
  }

  // 3. Waterfall + Duty stack (FBA) or Per-order table (Dropship)
  if (r.landed) {
    const l = r.landed;
    const max = Math.max(r.input.sales.price, ...l.waterfall.map(w => Math.abs(w.amount)));
    const wf = l.waterfall.map((w, i) => {
      const width = Math.max(2, Math.abs(w.amount) / max * 100).toFixed(1);
      const color = i === 0 ? '#6ea8fe' : i === l.waterfall.length - 1 ? (w.amount >= 0 ? 'var(--pos)' : 'var(--neg)') : 'var(--neg)';
      return `<div class="wf-row"><span>${esc(w.label)}</span><div class="wf-bar-wrap"><div class="wf-bar" style="width:${width}%;background:${color}"></div></div><span class="num ${w.amount < 0 ? 'neg' : 'pos'}">${money(w.amount)}</span></div>`;
    }).join('');

    const dutyRows = l.duty.map(d => `<tr><td>${esc(d.label)}${d.note ? ` <span class="sub">(${esc(d.note)})</span>` : ''}</td><td class="num">${pct(d.ratePct, 2)}</td><td class="num">${money(d.amount)}</td><td>${esc(d.effectiveFrom)}</td><td>${provTag(d.provenance)}</td></tr>`).join('');
    const custRows = l.customsLines.map(c => `<tr><td>${esc(c.label)}</td><td></td><td class="num">${money(c.amount)}</td><td></td><td>${provTag(c.provenance)}</td></tr>`).join('');

    parts.push(`<div class="two-col">
      <div class="panel"><div class="panel-head"><h2>Unit economics waterfall</h2><span class="sub">per unit @ ${money(r.input.sales.price)}</span></div><div class="pad">${wf}</div></div>
      <div class="panel"><div class="panel-head"><h2>Duty &amp; customs line items</h2><span class="sub">stacked duty ${pct(l.dutyEffectivePct)} on ${money((r.input.supplier.unitCost + (r.input.supplier.packagingPerUnit ?? 0)) * l.quantity, 0)} FOB</span></div>
        <table><thead><tr><th>Line</th><th class="num">Rate</th><th class="num">Total</th><th>Effective</th><th>Source</th></tr></thead><tbody>${dutyRows}${custRows}</tbody></table>
      </div>
    </div>`);

    // 4. Freight mode comparison + FBA fee breakdown
    const fRows = l.freight.options.map(o => `<tr class="${o.mode === l.freight.chosen.mode ? 'chosen' : ''}"><td>${esc(o.label)} ${o.mode === l.freight.chosen.mode ? '✓' : ''}</td><td class="num">${money(o.total, 0)}</td><td class="num">${money(o.perUnit)}</td><td class="num">${o.transitDays}d</td><td class="sub">${esc(o.detail)}</td></tr>`).join('');
    const fbaRows = (l.fba?.lines ?? []).map(x => `<tr><td>${esc(x.label)}</td><td class="num">${money(x.amount)}</td><td>${provTag(x.provenance)}</td></tr>`).join('')
      + `<tr><td>Referral (${l.fba?.referralPct}%)</td><td class="num">${money(l.sellingPerUnit.referral)}</td><td>${provTag({ source: 'rules:fba.referral', verified: false })}</td></tr>`;
    parts.push(`<div class="two-col">
      <div class="panel"><div class="panel-head"><h2>Freight modes (${l.freight.cartons} cartons · ${l.freight.totalCbm} CBM · ${l.freight.totalKg} kg)</h2><span class="sub">editable assumption table</span></div>
        <table><thead><tr><th>Mode</th><th class="num">Total</th><th class="num">/ unit</th><th class="num">Transit</th><th>Basis</th></tr></thead><tbody>${fRows}</tbody></table>
      </div>
      <div class="panel"><div class="panel-head"><h2>Amazon FBA fees</h2><span class="sub">go-live ${esc(l.salesStart)}</span></div>
        <table><thead><tr><th>Fee</th><th class="num">/ unit</th><th>Source</th></tr></thead><tbody>${fbaRows}</tbody></table>
      </div>
    </div>`);

    // 5. Cash curve + price sensitivity
    parts.push(`<div class="two-col">
      <div class="panel"><div class="panel-head"><h2>Working-capital curve (1 PO = ${l.quantity} units)</h2><span class="sub">trough ${money(-r.cash.capitalRequired, 0)} → net ${money(r.cash.netProfit, 0)}</span></div>
        <div class="plot">${drawCashSvg(r.cash)}</div>
      </div>
      <div class="panel"><div class="panel-head"><h2>Price sensitivity</h2><span class="sub">breakeven ${money(l.breakevenPrice)}</span></div>
        <table><thead><tr><th class="num">Price</th><th class="num">Contribution</th><th class="num">Margin</th></tr></thead><tbody>
          ${l.priceSensitivity.filter((_, i) => i % 2 === 0).map(p => `<tr class="${Math.abs(p.price - r.input.sales.price) < 0.01 ? 'chosen' : ''}"><td class="num">${money(p.price)}</td><td class="num ${p.contribution >= 0 ? 'pos' : 'neg'}">${money(p.contribution)}</td><td class="num">${pct(p.marginPct)}</td></tr>`).join('')}
        </tbody></table>
      </div>
    </div>`);
  } else if (r.dropship) {
    const rows = r.dropship.perOrder.map(l => `<tr><td>${esc(l.label)}${l.note ? ` <span class="sub">(${esc(l.note)})</span>` : ''}</td><td class="num">${money(l.amount)}</td><td>${provTag(l.provenance)}</td></tr>`).join('');
    parts.push(`<div class="panel" style="margin-top:14px"><div class="panel-head"><h2>Per-order unit economics</h2><span class="sub">price ${money(r.input.sales.price)}</span></div>
      <table><thead><tr><th>Line</th><th class="num">Amount</th><th>Source</th></tr></thead><tbody>${rows}
      <tr class="chosen"><td><strong>Net contribution / order</strong></td><td class="num ${r.dropship.contributionPerOrder >= 0 ? 'pos' : 'neg'}"><strong>${money(r.dropship.contributionPerOrder)} (${pct(r.dropship.contributionMarginPct)})</strong></td><td></td></tr></tbody></table></div>`);
  }

  // 6. Compliance + Score breakdown & Risks
  const c = r.compliance;
  const certRows = c.items.map(i => `<tr><td><span class="pill ${i.held ? 'ok' : 'gap'}">${i.held ? '✓ held' : '✗ gap'}</span></td><td>${esc(i.label)}${i.when ? ` <span class="sub">(when ${esc(i.when)})</span>` : ''}</td><td>${esc(i.authority)}</td></tr>`).join('') || '<tr><td colspan="3" class="sub">No specific certifications listed for this category.</td></tr>';
  const subRows = r.score.subscores.filter(s => s.weight > 0).map(s => `<tr><td>${esc(s.key)}</td><td class="num">${pct(s.weight * 100, 0)}</td><td class="num">${s.score === null ? '<span class="sub">excluded</span>' : `${s.score}/100`}</td><td class="sub">${esc(s.why)}</td></tr>`).join('');
  const riskRows = r.risks.map(x => `<tr><td>${esc(x.key)}</td><td><span class="pill ${x.level}">${esc(x.level)}</span></td><td class="sub">${esc(x.detail)}</td></tr>`).join('');

  parts.push(`<div class="two-col">
    <div class="panel"><div class="panel-head"><h2>Compliance checklist · ${esc(c.label)}</h2><span class="sub">gating: ${esc(c.gating)} ${c.verified ? '' : '· ⚠ unverified'}</span></div>
      <table><thead><tr><th>Status</th><th>Requirement</th><th>Authority</th></tr></thead><tbody>${certRows}</tbody></table>
      <div class="pad">
        ${c.amazonFlags.length ? `<div class="sub">Amazon flags: ${c.amazonFlags.map(f => `<code>${esc(f)}</code>`).join(' ')}</div>` : ''}
        ${c.ipRisk.length ? `<div class="sub" style="margin-top:6px">IP notes: ${c.ipRisk.map(esc).join(' · ')}</div>` : ''}
        ${c.checklist.length ? `<ul class="sub" style="margin:6px 0 0;padding-left:16px">${c.checklist.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      </div>
    </div>
    <div class="panel"><div class="panel-head"><h2>Playbook score &amp; risk panel</h2><span class="sub">missing inputs excluded, never defaulted</span></div>
      <table><thead><tr><th>Dimension</th><th class="num">Weight</th><th class="num">Score</th><th>Basis</th></tr></thead><tbody>${subRows}</tbody></table>
      <table><thead><tr><th>Risk</th><th>Level</th><th>Detail</th></tr></thead><tbody>${riskRows}</tbody></table>
    </div>
  </div>`);

  // 7. Full assumptions + provenance table
  const aRows = r.assumptions.map(a => `<tr><td>${esc(a.key)}</td><td class="num">${esc(typeof a.value === 'number' ? a.value : a.value)}</td><td>${provTag(a.provenance)}</td></tr>`).join('');
  parts.push(`<div class="panel" style="margin-top:14px"><div class="panel-head"><h2>Assumptions &amp; provenance</h2><span class="sub">every number traces to user input, a dated rule, or an editable assumption</span></div>
    <table><thead><tr><th>Assumption</th><th class="num">Value</th><th>Provenance</th></tr></thead><tbody>${aRows}</tbody></table>
  </div>`);

  $('reportRoot').innerHTML = parts.join('');
}

function drawCashSvg(cash) {
  const pts = cash.curve;
  if (!pts.length) return '';
  const w = 560, h = 195, l = 54, r = 14, t = 12, b = 24;
  const maxD = pts[pts.length - 1].day || 1;
  const vals = pts.map(p => p.cumulative);
  const lo = Math.min(0, ...vals) * 1.1, hi = Math.max(100, ...vals) * 1.1;
  const x = d => l + (d / maxD) * (w - l - r);
  const y = v => t + (hi - v) / (hi - lo) * (h - t - b);
  const zeroY = y(0).toFixed(1);
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.day).toFixed(1)},${y(p.cumulative).toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Cumulative cash flow over days from PO">
    <line x1="${l}" y1="${zeroY}" x2="${w - r}" y2="${zeroY}" stroke="#3a4657" stroke-dasharray="3 4" />
    <text x="${l - 6}" y="${zeroY}" text-anchor="end" fill="#9ca8bb" font-size="10">$0</text>
    <text x="${l - 6}" y="${y(lo) + 3}" text-anchor="end" fill="#e9a9a5" font-size="10">${money(lo / 1.1, 0)}</text>
    <text x="${l - 6}" y="${y(hi) + 8}" text-anchor="end" fill="#89d8b5" font-size="10">${money(hi / 1.1, 0)}</text>
    <path d="${path}" fill="none" stroke="#c1dbff" stroke-width="2" />
    <text x="${l}" y="${h - 5}" fill="#9ca8bb" font-size="10">Day 0 (PO)</text>
    <text x="${w - r}" y="${h - 5}" text-anchor="end" fill="#9ca8bb" font-size="10">Day ${maxD}</text>
  </svg>`;
}

// ─── URL share encoding (#deal=<base64url JSON>) ───
const encodeDeal = obj => btoa(unescape(encodeURIComponent(JSON.stringify(obj)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const decodeDeal = str => JSON.parse(decodeURIComponent(escape(atob(str.replace(/-/g, '+').replace(/_/g, '/')))));

async function boot() {
  meta = await (await fetch('/api/meta')).json();
  $('rulesetTag').textContent = `rules ${meta.rulesetVersion}`;
  $('catSelect').innerHTML = meta.categories.map(c => `<option value="${esc(c.id)}">${esc(c.label)}</option>`).join('');
  const ex = $('exampleSelect');
  meta.fixtures.forEach(f => { const o = document.createElement('option'); o.value = f; o.textContent = `Example: ${f}`; ex.appendChild(o); });

  // If a #deal= hash is present, load it; otherwise stay empty (NO DEAL LOADED).
  const m = location.hash.match(/deal=([A-Za-z0-9_-]+)/);
  if (m) {
    try { deal = decodeDeal(m[1]); syncFormFromDeal(); await runUnderwrite(); }
    catch (e) { $('statusBar').className = 'notice error'; $('statusBar').textContent = 'Invalid share link: ' + e.message; }
  }
}

$('exampleSelect').addEventListener('change', async e => {
  const name = e.target.value; if (!name) return;
  deal = await (await fetch(`/api/fixtures/${name}`)).json();
  syncFormFromDeal();
  await runUnderwrite();
});

$('newBlank').addEventListener('click', () => { deal = BLANK(); syncFormFromDeal(); runUnderwrite(); });

$('dealForm').addEventListener('input', e => {
  if (e.target.matches('input[data-cert]')) return;
  readFormIntoDeal();
  if (e.target.dataset.path === 'product.complianceCategory' || e.target.dataset.path === 'playbook') syncFormFromDeal();
  runUnderwrite();
});

$('fileIn').addEventListener('change', async e => {
  const f = e.target.files?.[0]; if (!f) return;
  try { deal = JSON.parse(await f.text()); syncFormFromDeal(); await runUnderwrite(); }
  catch (err) { $('statusBar').className = 'notice error'; $('statusBar').textContent = 'Cannot read deal JSON: ' + err.message; }
});

$('downloadJson').addEventListener('click', () => {
  if (!deal) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(deal, null, 2)], { type: 'application/json' }));
  a.download = `${(deal.product?.name || 'deal').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.deal.json`;
  a.click();
});

$('shareBtn').addEventListener('click', async () => {
  if (!deal) return;
  const copy = { ...deal }; delete copy._note;
  history.replaceState(null, '', '#deal=' + encodeDeal(copy));
  try { await navigator.clipboard.writeText(location.href); $('shareBtn').textContent = 'Copied!'; setTimeout(() => ($('shareBtn').textContent = 'Copy share link'), 1500); } catch {}
});

$('printBtn').addEventListener('click', () => window.print());

$('usitcBtn').addEventListener('click', async () => {
  readFormIntoDeal();
  const hts = deal?.product?.htsCode; if (!hts) return;
  $('usitcBtn').textContent = '…';
  try {
    const r = await (await fetch(`/api/hts/${encodeURIComponent(hts)}`)).json();
    if (r.error) throw new Error(r.error);
    if (r.value?.mfnRatePct !== null && r.value?.mfnRatePct !== undefined) {
      deal.product.mfnRatePct = r.value.mfnRatePct;
      syncFormFromDeal();
      await runUnderwrite();
    } else alert(`USITC returned "${r.value?.general ?? 'no match'}" — enter MFN % manually.`);
  } catch (e) { alert(e.message); }
  finally { $('usitcBtn').textContent = 'USITC'; }
});

$('changelogBtn').addEventListener('click', async () => {
  $('changelogModal').showModal();
  $('changelogBody').textContent = await (await fetch('/api/rules/changelog')).text();
});
$('closeModal').addEventListener('click', () => $('changelogModal').close());

boot();
