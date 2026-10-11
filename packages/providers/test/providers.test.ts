import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGeneralRate } from '../src/index.ts';

test('parseGeneralRate handles Free, ad valorem, and refuses compound rates', () => {
  assert.equal(parseGeneralRate('Free'), 0);
  assert.equal(parseGeneralRate('4.9%'), 4.9);
  assert.equal(parseGeneralRate(' 17.6% '), 17.6);
  assert.equal(parseGeneralRate('2.2¢/kg + 5%'), null);
});
