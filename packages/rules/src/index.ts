/**
 * @iof/rules — versioned, dated datasets consumed by @iof/core.
 *
 * Guardrail: rates live here (with effectiveFrom/effectiveTo + source), never in code.
 * Bump RULESET_VERSION and add a CHANGELOG.md entry on every data change.
 */
import tariffs from '../data/tariffs/overlay.json' with { type: 'json' };
import hts from '../data/tariffs/hts-sample.json' with { type: 'json' };
import customs from '../data/customs-fees.json' with { type: 'json' };
import fba from '../data/fba-fees-us.json' with { type: 'json' };
import freight from '../data/freight-assumptions.json' with { type: 'json' };
import compliance from '../data/compliance-us.json' with { type: 'json' };
import playbooks from '../data/playbooks.json' with { type: 'json' };
import type { Ruleset } from '../../core/src/types.ts';

export const RULESET_VERSION = '2026.10.10';

export const rules: Ruleset = {
  version: RULESET_VERSION,
  tariffs,
  hts,
  customs,
  fba,
  freight,
  compliance,
  playbooks,
} as unknown as Ruleset;

export default rules;
