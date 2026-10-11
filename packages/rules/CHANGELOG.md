# Rules Changelog

Public, dated log of every change to tariff, fee, compliance, and freight datasets.
Format: `YYYY.MM.DD` ruleset version → what changed → source. Entries marked **⚠ unverified** were seeded from secondary sources and need primary-source confirmation (Federal Register, USTR, CBP CSMS, Seller Central).

## 2026.10.10 — initial ruleset

### Tariffs (`data/tariffs/overlay.json`)
- **Section 301 China Lists 1–3 (25%) and 4A (7.5%)** — continued after the four-year review; USTR continuation notice 2026-10-07. ⚠ unverified. List membership seeded only for fixture HTS codes.
- **Section 301 forced-labor action — China +12.5%**, effective 2026-07-24, additive to Lists 1–4A. ⚠ unverified.
- **IEEPA fentanyl (10% → 20% → 10%) and IEEPA reciprocal (125% → 10%) on CN/HK** — recorded with end date 2026-02-20 (*Learning Resources v. Trump*, SCOTUS held IEEPA does not authorize tariffs). Kept for historical deal re-runs. ⚠ unverified.
- **Section 122 global 10%** — 2026-02-24 → 2026-07-24 (150-day statutory limit). ⚠ unverified.
- **Section 232 steel/aluminum derivatives 50%** on metal content, from 2025-06-04. ⚠ unverified.
- Watching: US–China "30-for-30" Board of Trade lists (proposed, not in force); truce extension reportedly through 2027-01-10.

### Customs fees (`data/customs-fees.json`)
- MPF FY2026 (0.3464%, $33.58–$651.50) and FY2027 from 2026-10-01 ($34.58–$670.86). FY2027 informal flat fee estimated. ⚠ unverified.
- **De minimis suspended**: CN/HK since 2025-05-02, global since 2025-08-29; CBP regulations (2026-06) re-based suspension on Tariff Act authority; upheld by CIT 2026-08-13; statutory repeal effective 2027-07-01.

### Amazon FBA (`data/fba-fees-us.json`)
- 2025 rate card seed + 2026-01-15 average per-tier deltas; 3.5% fuel & logistics surcharge from 2026-04-17; holiday peak window 2026-10-15 → 2027-01-14 (adders estimated). ⚠ unverified — replace with full 2026 rate card.

### Compliance (`data/compliance-us.json`)
- 16 categories seeded, including MoCRA registration/listing for cosmetics and UN38.3/hazmat flags for lithium products.
