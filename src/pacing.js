// One shared IP. Start conservative, speed up slowly after a streak of
// ordinary answers, and give back speed on 429/503. A long pause is only for
// repeated 429s. A Cloudflare challenge is not a rate limit.

const GAP_FLOOR_MS = 400;
const GAP_START_MS = 1200;
const GAP_CAP_MS = 10000;
const SLOT_MAX = 3;

function createPace() {
  return { gapMs: GAP_START_MS, slots: 2, streak: 0, limitStreak: 0 };
}

function paceDelayMs(pace, rand = Math.random) {
  const spread = 0.85 + rand() * 0.3;
  return Math.max(GAP_FLOOR_MS, Math.round(pace.gapMs * spread));
}

function paceOnSuccess(pace) {
  pace.streak += 1;
  pace.limitStreak = 0;
  if (pace.streak % 6 === 0) {
    pace.gapMs = Math.max(GAP_FLOOR_MS, Math.round(pace.gapMs * 0.8));
    if (pace.streak % 12 === 0 && pace.slots < SLOT_MAX) pace.slots += 1;
  }
  return pace;
}

function isPressureStatus(status) {
  return status === 429 || status === 503;
}

function retryAfterMs(value, now = Date.now()) {
  if (value == null || value === "") return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 10 * 60 * 1000);
  const when = Date.parse(String(value));
  if (Number.isNaN(when)) return 0;
  return Math.min(Math.max(0, when - now), 10 * 60 * 1000);
}

// Halve the parallel fetches and double the gap. Retry-After wins if it is longer.
// The minutes-long pause starts on the third 429 in a row.
function paceOnLimit(pace, { status, retryAfter } = {}) {
  pace.streak = 0;
  if (status === 429) pace.limitStreak += 1;
  pace.slots = Math.max(1, Math.ceil(pace.slots / 2));
  pace.gapMs = Math.min(GAP_CAP_MS, pace.gapMs * 2);
  const waitMs = Math.max(pace.gapMs, retryAfterMs(retryAfter));
  return {
    waitMs,
    longBackoff: status === 429 && pace.limitStreak >= 3,
    slots: pace.slots,
    gapMs: pace.gapMs
  };
}

function paceOnSoft(pace) {
  pace.streak = 0;
  pace.gapMs = Math.min(GAP_CAP_MS, pace.gapMs * 2);
  return pace.gapMs;
}

function backoffMinutes(step) {
  const n = Math.max(0, step | 0);
  return Math.min(30, 2 ** n);
}

function cooldownMs(rand = Math.random) {
  return (5 + rand() * 5) * 60 * 1000;
}

module.exports = {
  createPace,
  paceDelayMs,
  paceOnSuccess,
  paceOnLimit,
  paceOnSoft,
  isPressureStatus,
  retryAfterMs,
  backoffMinutes,
  cooldownMs,
  GAP_FLOOR_MS,
  GAP_START_MS,
  SLOT_MAX
};
