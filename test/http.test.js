const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isCloudflareChallenge,
  proxyUrlForImpit,
  parseSetCookie,
  freshHttpState,
  httpFallbackState,
  CHALLENGE_FALLBACK_STREAK
} = require("../src/http");

test("cloudflare challenge is the mitigated header or the challenge page", () => {
  assert.equal(isCloudflareChallenge({
    status: 403,
    headers: { "cf-mitigated": "challenge" },
    text: "<html>ok</html>"
  }), true);
  assert.equal(isCloudflareChallenge({
    status: 503,
    headers: { "cf-mitigated": "challenge" },
    text: ""
  }), true);
  assert.equal(isCloudflareChallenge({
    status: 403,
    headers: {},
    text: "<title>Just a moment...</title><div class=\"challenge-platform\"></div>"
  }), true);
  assert.equal(isCloudflareChallenge({
    status: 403,
    headers: {},
    text: "<h1>Sorry, you have been blocked</h1>"
  }), false);
  assert.equal(isCloudflareChallenge({ status: 200, headers: {}, text: "<html>profile</html>" }), false);
});

test("impit uses the same proxy url as the window, including http credentials", () => {
  assert.equal(proxyUrlForImpit(null), "");
  assert.equal(proxyUrlForImpit({ proxy: { server: "socks5://127.0.0.1:1080" } }), "socks5://127.0.0.1:1080");
  assert.equal(proxyUrlForImpit({
    proxy: { server: "http://127.0.0.1:8080", username: "user", password: "p@ss" }
  }), "http://user:p%40ss@127.0.0.1:8080");
});

test("set-cookie from the http client maps onto an electron cookie", () => {
  const cookie = parseSetCookie(
    "cf_clearance=abc; Domain=.myfxbook.com; Path=/; Secure; HttpOnly; SameSite=None",
    "https://www.myfxbook.com/members/a"
  );
  assert.equal(cookie.name, "cf_clearance");
  assert.equal(cookie.value, "abc");
  assert.equal(cookie.domain, "myfxbook.com");
  assert.equal(cookie.path, "/");
  assert.equal(cookie.secure, true);
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.sameSite, "no_restriction");
  assert.equal(cookie.url, "https://myfxbook.com/");
});

test("three challenges right after clearance switch the run to the window", () => {
  assert.equal(CHALLENGE_FALLBACK_STREAK, 3);
  let state = freshHttpState();
  state = httpFallbackState(state, "challenge");
  assert.equal(state.mode, "http");
  assert.equal(state.challengeStreak, 0);
  state = httpFallbackState(state, "cleared");
  state = httpFallbackState(state, "challenge");
  state = httpFallbackState(state, "cleared");
  state = httpFallbackState(state, "challenge");
  assert.equal(state.mode, "http");
  assert.equal(state.challengeStreak, 2);
  state = httpFallbackState(state, "cleared");
  state = httpFallbackState(state, "challenge");
  assert.equal(state.mode, "window");
  assert.equal(state.switched, true);
  assert.equal(state.reason, "challenge");
  state = httpFallbackState(state, "ok");
  assert.equal(state.mode, "window");
});

test("a clean response resets the challenge streak", () => {
  let state = httpFallbackState(freshHttpState(), "cleared");
  state = httpFallbackState(state, "challenge");
  assert.equal(state.challengeStreak, 1);
  state = httpFallbackState(state, "ok");
  assert.equal(state.challengeStreak, 0);
  assert.equal(state.mode, "http");
});

test("impit failing to load, or three client errors, stays on the window", () => {
  const failed = httpFallbackState(freshHttpState(), "load-failed");
  assert.equal(failed.mode, "window");
  assert.equal(failed.reason, "load");
  let state = freshHttpState();
  state = httpFallbackState(state, "client-error");
  state = httpFallbackState(state, "client-error");
  assert.equal(state.mode, "http");
  state = httpFallbackState(state, "client-error");
  assert.equal(state.mode, "window");
  assert.equal(state.reason, "errors");
});

test("impit is published for macOS arm64 and loads here", () => {
  const pkg = require("impit/package.json");
  assert.equal(pkg.optionalDependencies["impit-darwin-arm64"], "0.14.9");
  const { Impit } = require("impit");
  const client = new Impit({ browser: "chrome" });
  assert.equal(typeof client.fetch, "function");
});
