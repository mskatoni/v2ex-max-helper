'use strict';

const crypto = require('crypto');
const MIN_TOTAL_GAP_MS = 8000;

function makeRng(seedStr) {
  const hash = crypto.createHash('sha256').update(String(seedStr)).digest();
  let a = hash.readUInt32LE(0);
  return function rng() {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hasEnv(name) {
  return process.env[name] !== undefined && process.env[name] !== '';
}

function intEnv(name, def) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v >= 0 ? v : def;
}

function hasValidIntEnv(name) {
  if (!hasEnv(name)) return false;
  const value = parseInt(process.env[name], 10);
  return Number.isFinite(value) && value >= 0;
}

function floatEnv(name, def) {
  const v = parseFloat(process.env[name]);
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : def;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function scaledInt(value, multiplier) {
  return Math.max(0, Math.round(value * multiplier));
}

function profileShape(profile) {
  const rng = makeRng(`v2ex-behavior::${profile}`);
  return {
    dwellMultiplier: 0.9 + rng() * 0.2,
    longChanceDelta: -0.03 + rng() * 0.06,
    gapMultiplier: 0.85 + rng() * 0.3,
    balanceOffset: Math.floor(rng() * 11) - 5,
  };
}

function resolveHumanGap(name, legacyName, def, multiplier) {
  if (hasEnv(name)) return intEnv(name, def);
  if (hasEnv(legacyName)) return intEnv(legacyName, def);
  return scaledInt(def, multiplier);
}

function resolve(profile) {
  const shape = profileShape(profile);
  const explicitDwell = hasEnv('READ_DWELL_MIN') ||
                        hasEnv('READ_DWELL_MAX') ||
                        hasEnv('READ_DWELL_LONG') ||
                        hasEnv('READ_LONG_CHANCE');
  const dwellMultiplier = explicitDwell ? 1 : shape.dwellMultiplier;

  let dwellMin = hasEnv('READ_DWELL_MIN') ? intEnv('READ_DWELL_MIN', 8000) : scaledInt(8000, dwellMultiplier);
  let dwellMax = hasEnv('READ_DWELL_MAX') ? intEnv('READ_DWELL_MAX', 22000) : scaledInt(22000, dwellMultiplier);
  let dwellLong = hasEnv('READ_DWELL_LONG') ? intEnv('READ_DWELL_LONG', 45000) : scaledInt(45000, dwellMultiplier);
  if (dwellMax < dwellMin) dwellMax = dwellMin;
  if (dwellLong < dwellMax) dwellLong = dwellMax;

  const longChance = hasEnv('READ_LONG_CHANCE')
    ? floatEnv('READ_LONG_CHANCE', 0.15)
    : clamp(0.15 + shape.longChanceDelta, 0.08, 0.22);

  const usesLegacyGap = !hasEnv('READ_HUMAN_GAP_MIN') &&
                        !hasEnv('READ_HUMAN_GAP_MAX') &&
                        (hasEnv('READ_GAP_MIN') || hasEnv('READ_GAP_MAX'));
  let humanGapMin = resolveHumanGap('READ_HUMAN_GAP_MIN', 'READ_GAP_MIN', 3000, shape.gapMultiplier);
  let humanGapMax = resolveHumanGap('READ_HUMAN_GAP_MAX', 'READ_GAP_MAX', 9000, shape.gapMultiplier);
  if (humanGapMax < humanGapMin) humanGapMax = humanGapMin;

  let memorySettleMs = intEnv('READ_MEMORY_SETTLE_MS', 5000);
  const explicitGapMin = hasValidIntEnv('READ_HUMAN_GAP_MIN') ||
                         (!hasEnv('READ_HUMAN_GAP_MIN') && hasValidIntEnv('READ_GAP_MIN'));
  const explicitMemorySettle = hasValidIntEnv('READ_MEMORY_SETTLE_MS');
  let gapFloorApplied = false;
  if (!explicitGapMin && !explicitMemorySettle && humanGapMin + memorySettleMs < MIN_TOTAL_GAP_MS) {
    memorySettleMs += MIN_TOTAL_GAP_MS - humanGapMin - memorySettleMs;
    gapFloorApplied = true;
  }
  const balanceCheckInterval = hasEnv('BALANCE_CHECK_INTERVAL')
    ? Math.max(1, intEnv('BALANCE_CHECK_INTERVAL', 50))
    : Math.max(10, 50 + shape.balanceOffset);

  return {
    profile,
    dwellMin,
    dwellMax,
    dwellLong,
    longChance,
    humanGapMin,
    humanGapMax,
    memorySettleMs,
    balanceCheckInterval,
    usesLegacyGap,
    gapFloorApplied,
    summary: {
      dwellMultiplier: Number(shape.dwellMultiplier.toFixed(3)),
      gapMultiplier: Number(shape.gapMultiplier.toFixed(3)),
      balanceOffset: shape.balanceOffset,
      explicitReadEnv: explicitDwell || hasEnv('READ_HUMAN_GAP_MIN') || hasEnv('READ_HUMAN_GAP_MAX') ||
                       hasEnv('READ_GAP_MIN') || hasEnv('READ_GAP_MAX') || hasEnv('READ_MEMORY_SETTLE_MS'),
    },
  };
}

module.exports = { resolve };
