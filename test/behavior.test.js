'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const behavior = require('../reader/behavior');

const keys = [
  'READ_DWELL_MIN', 'READ_DWELL_MAX', 'READ_DWELL_LONG', 'READ_LONG_CHANCE',
  'READ_HUMAN_GAP_MIN', 'READ_HUMAN_GAP_MAX', 'READ_GAP_MIN', 'READ_GAP_MAX',
  'READ_MEMORY_SETTLE_MS', 'BALANCE_CHECK_INTERVAL',
];

function withReadEnv(values, fn) {
  const before = new Map(keys.map(key => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, values);
  try {
    return fn();
  } finally {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('default profile-shaped timing keeps at least eight seconds between posts', () => {
  withReadEnv({}, () => {
    for (let index = 0; index < 100; index++) {
      const value = behavior.resolve(`profile-${index}`);
      assert.ok(value.humanGapMax >= value.humanGapMin);
      assert.ok(value.humanGapMin + value.memorySettleMs >= 8000, `profile-${index}`);
    }
  });
});

test('new and legacy explicit timing values may intentionally override the floor', () => {
  withReadEnv({
    READ_HUMAN_GAP_MIN: '100',
    READ_HUMAN_GAP_MAX: '200',
    READ_MEMORY_SETTLE_MS: '300',
  }, () => {
    const value = behavior.resolve('explicit-new');
    assert.equal(value.humanGapMin, 100);
    assert.equal(value.humanGapMax, 200);
    assert.equal(value.memorySettleMs, 300);
    assert.equal(value.gapFloorApplied, false);
  });

  withReadEnv({
    READ_GAP_MIN: '120',
    READ_GAP_MAX: '220',
    READ_MEMORY_SETTLE_MS: '0',
  }, () => {
    const value = behavior.resolve('explicit-legacy');
    assert.equal(value.humanGapMin, 120);
    assert.equal(value.humanGapMax, 220);
    assert.equal(value.memorySettleMs, 0);
    assert.equal(value.usesLegacyGap, true);
    assert.equal(value.gapFloorApplied, false);
  });
});
