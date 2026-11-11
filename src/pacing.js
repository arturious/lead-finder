// One request at a time. A short randomized gap, then minutes of back-off
// when the site answers 403 / 429 or the request times out.

function politeDelayMs(rand = Math.random) {
  return 2000 + Math.floor(rand() * 1001);
}

function backoffMinutes(step) {
  const n = Math.max(0, step | 0);
  return Math.min(30, 2 ** n);
}

function cooldownMs(rand = Math.random) {
  return (5 + rand() * 5) * 60 * 1000;
}

module.exports = { politeDelayMs, backoffMinutes, cooldownMs };
