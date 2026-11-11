// A short randomized gap, then minutes of back-off when the site answers
// 403 / 429 or the request times out. Profile fetches may run two at a time
// until the first 403 or 429, then one at a time for the rest of the run.

function politeDelayMs(rand = Math.random) {
  return 800 + Math.floor(rand() * 701);
}

function profileSlotsAfter(slots, status) {
  if (status === 403 || status === 429) return 1;
  return slots;
}

function backoffMinutes(step) {
  const n = Math.max(0, step | 0);
  return Math.min(30, 2 ** n);
}

function cooldownMs(rand = Math.random) {
  return (5 + rand() * 5) * 60 * 1000;
}

module.exports = { politeDelayMs, backoffMinutes, cooldownMs, profileSlotsAfter };
