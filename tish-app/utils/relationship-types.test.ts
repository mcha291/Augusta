/**
 * Tests for 3.4's relationship-type keys.
 *
 * Run with `npm test` from `tish-app/`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_RELATIONSHIP_TYPE,
  RELATIONSHIP_TYPES,
  normaliseRelationshipType,
  relationshipTypeLabelKey,
} from './relationship-types.ts';

test('the default is one of the offered types', () => {
  assert.ok((RELATIONSHIP_TYPES as readonly string[]).includes(DEFAULT_RELATIONSHIP_TYPE));
});

test('THE EXISTING ROWS STILL NORMALISE, in both spellings already in the column', () => {
  // The column holds 'Family' (written by the hardcoded client) and 'family'
  // (written by /debug/link). Both predate this module and both must keep
  // rendering, or every card in the managed-users list loses its subtitle.
  assert.equal(normaliseRelationshipType('Family'), 'family');
  assert.equal(normaliseRelationshipType('family'), 'family');
  assert.equal(normaliseRelationshipType('  FAMILY  '), 'family');
});

test('an unknown value is null rather than being relabelled as the default', () => {
  // Silently calling somebody's "Neighbour" a family member would be a wrong
  // answer presented confidently. The caller shows the raw string instead.
  assert.equal(normaliseRelationshipType('neighbour'), null);
  assert.equal(relationshipTypeLabelKey('neighbour'), null);
});

test('non-strings do not throw and do not coerce', () => {
  // These arrive off a server row, so null and undefined are both reachable.
  for (const value of [null, undefined, 0, 1, {}, [], true]) {
    assert.equal(normaliseRelationshipType(value), null, String(value));
    assert.equal(relationshipTypeLabelKey(value), null, String(value));
  }
});

test('every offered type has a distinct label key under one namespace', () => {
  const keys = RELATIONSHIP_TYPES.map((t) => relationshipTypeLabelKey(t));
  assert.equal(new Set(keys).size, RELATIONSHIP_TYPES.length);
  for (const key of keys) assert.match(String(key), /^relationshipTypes\.[a-z]+$/);
});

test('the keys are stable, because they are what the database stores', () => {
  // A rename here silently orphans every row already written with the old key —
  // the label would fall back to the raw string, which is the *old English
  // word*, in every language. Changing this list is a migration, not an edit.
  assert.deepEqual([...RELATIONSHIP_TYPES], [
    'family', 'spouse', 'parent', 'child', 'sibling', 'carer', 'other',
  ]);
});
