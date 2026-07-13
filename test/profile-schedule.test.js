'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const schedule = require('../lib/profile-schedule');

test('six four-hour profiles fit exactly one day', () => {
  assert.equal(schedule.validateSlotHours(4, 6), 4);
  assert.throws(() => schedule.validateSlotHours(4.1, 6), /不得超过 24/);
  assert.throws(() => schedule.validateSlotHours(Infinity, 2), /有限数字/);
});

test('daily cycle uses the previous local day before 09:10', () => {
  const now = new Date(2026, 6, 12, 8, 0, 0);
  const cycle = schedule.getDailyCycle(now, 6, 4 * 60 * 60 * 1000);
  const start = new Date(cycle.startTimeMs);
  assert.equal(start.getDate(), 11);
  assert.equal(start.getHours(), 9);
  assert.equal(start.getMinutes(), 10);
  assert.equal(cycle.endTimeMs - cycle.startTimeMs, 24 * 60 * 60 * 1000);
});

test('slot windows have fixed boundaries', () => {
  const start = Date.now();
  const slot = 4 * 60 * 60 * 1000;
  assert.deepEqual(schedule.getSlotWindow(start, slot, 2), {
    startTimeMs: start + 2 * slot,
    endTimeMs: start + 3 * slot,
  });
});
