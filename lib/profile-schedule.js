'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;

function validateSlotHours(hours, profileCount) {
  if (!Number.isFinite(hours) || hours < 1) {
    throw new Error('PROFILE_TIME_SLOT_HOURS 必须是大于等于 1 的有限数字');
  }
  if (profileCount > 0 && hours * profileCount > 24) {
    throw new Error('profile 数量 × PROFILE_TIME_SLOT_HOURS 不得超过 24 小时');
  }
  return hours;
}

function localDateKey(date) {
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function getDailyCycle(now, profileCount, slotMs, startLocalMinutes = 9 * 60 + 10) {
  const start = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    Math.floor(startLocalMinutes / 60),
    startLocalMinutes % 60,
    0,
    0
  );
  if (now.getTime() < start.getTime()) start.setDate(start.getDate() - 1);
  return {
    id: localDateKey(start),
    startTimeMs: start.getTime(),
    endTimeMs: start.getTime() + profileCount * slotMs,
  };
}

function getSlotWindow(sequenceStartMs, slotMs, index) {
  const startTimeMs = sequenceStartMs + index * slotMs;
  return { startTimeMs, endTimeMs: startTimeMs + slotMs };
}

module.exports = { DAY_MS, getDailyCycle, getSlotWindow, validateSlotHours };
