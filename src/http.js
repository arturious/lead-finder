const { isChallengeHtml, isHardBlockHtml } = require("./parse");

const CHALLENGE_FALLBACK_STREAK = 3;

function headerValue(headers, name) {
  if (!headers) return "";
  if (typeof headers.get === "function") return headers.get(name) || "";
  const key = Object.keys(headers).find((item) => item.toLowerCase() === name.toLowerCase());
  return key ? String(headers[key] || "") : "";
}

function isCloudflareChallenge({ status, headers, text } = {}) {
  const mitigated = headerValue(headers, "cf-mitigated");
  if ((status === 403 || status === 503) && /challenge/i.test(mitigated)) return true;
  return isChallengeHtml(text || "", "");
}

function proxyUrlForImpit(prepared) {
  if (!prepared || !prepared.proxy || !prepared.proxy.server) return "";
  const { server, username, password } = prepared.proxy;
  if (!username) return server;
  const url = new URL(server);
  url.username = username;
  url.password = password || "";
  const href = url.toString();
  return href.endsWith("/") && url.pathname === "/" ? href.slice(0, -1) : href;
}

function parseSetCookie(line, requestUrl) {
  const parts = String(line || "").split(";").map((part) => part.trim()).filter(Boolean);
  if (!parts.length || !parts[0].includes("=")) return null;
  const eq = parts[0].indexOf("=");
  const name = parts[0].slice(0, eq).trim();
  const value = parts[0].slice(eq + 1).trim();
  if (!name) return null;
  let request;
  try { request = new URL(requestUrl); } catch { return null; }
  const cookie = {
    url: requestUrl,
    name,
    value,
    path: "/",
    secure: request.protocol === "https:"
  };
  for (const attr of parts.slice(1)) {
    const split = attr.indexOf("=");
    const key = (split === -1 ? attr : attr.slice(0, split)).trim().toLowerCase();
    const attrValue = split === -1 ? "" : attr.slice(split + 1).trim();
    if (key === "domain" && attrValue) cookie.domain = attrValue.replace(/^\./, "");
    else if (key === "path" && attrValue) cookie.path = attrValue;
    else if (key === "secure") cookie.secure = true;
    else if (key === "httponly") cookie.httpOnly = true;
    else if (key === "expires") {
      const time = Date.parse(attrValue);
      if (!Number.isNaN(time)) cookie.expirationDate = time / 1000;
    } else if (key === "max-age") {
      const seconds = Number(attrValue);
      if (Number.isFinite(seconds)) cookie.expirationDate = Date.now() / 1000 + seconds;
    } else if (key === "samesite") {
      const site = attrValue.toLowerCase();
      cookie.sameSite = site === "none" ? "no_restriction" : site === "strict" ? "strict" : "lax";
    }
  }
  if (cookie.domain) {
    const proto = cookie.secure ? "https:" : request.protocol;
    cookie.url = `${proto}//${cookie.domain}${cookie.path || "/"}`;
  }
  return cookie;
}

function freshHttpState() {
  return { mode: "http", challengeStreak: 0, errorStreak: 0, afterClear: false };
}

// Decides when the fast client gives up for the rest of the run.
// A challenge counts only when it comes back immediately after the window cleared.
function httpFallbackState(state, event) {
  const next = {
    mode: state.mode || "http",
    challengeStreak: state.challengeStreak || 0,
    errorStreak: state.errorStreak || 0,
    afterClear: Boolean(state.afterClear),
    switched: false,
    reason: ""
  };
  if (event === "load-failed") {
    return { ...next, mode: "window", afterClear: false, switched: true, reason: "load" };
  }
  if (next.mode === "window") return next;
  if (event === "ok") return freshHttpState();
  if (event === "cleared") return { ...next, afterClear: true, errorStreak: 0 };
  if (event === "client-error") {
    next.errorStreak += 1;
    next.afterClear = false;
    if (next.errorStreak >= CHALLENGE_FALLBACK_STREAK) {
      return { ...next, mode: "window", switched: true, reason: "errors" };
    }
    return next;
  }
  if (event === "challenge") {
    if (next.afterClear) next.challengeStreak += 1;
    next.afterClear = false;
    next.errorStreak = 0;
    if (next.challengeStreak >= CHALLENGE_FALLBACK_STREAK) {
      return { ...next, mode: "window", switched: true, reason: "challenge" };
    }
    return next;
  }
  return next;
}

function setCookieLines(headers) {
  if (!headers) return [];
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie().filter(Boolean);
  const one = headerValue(headers, "set-cookie");
  return one ? [one] : [];
}

function createHttpClient({ cookieHeader, setCookie, userAgent, acceptLanguage, proxyUrl }) {
  let client = null;
  let broken = false;

  async function instance() {
    if (broken) {
      const error = new Error("impit unavailable");
      error.code = "IMPIT_LOAD";
      throw error;
    }
    if (client) return client;
    try {
      const { Impit } = require("impit");
      const proxy = proxyUrl ? proxyUrl() : "";
      client = new Impit({
        browser: "chrome",
        proxyUrl: proxy || undefined,
        timeout: 45000,
        headers: {
          "user-agent": userAgent(),
          "accept-language": acceptLanguage()
        },
        cookieJar: {
          getCookieString: (url) => cookieHeader(url),
          setCookie: (cookie, url) => setCookie(cookie, url)
        }
      });
      return client;
    } catch (error) {
      broken = true;
      error.code = "IMPIT_LOAD";
      throw error;
    }
  }

  async function fetch(url, { xhr = false } = {}) {
    let response;
    try {
      const impit = await instance();
      const headers = xhr ? { "x-requested-with": "XMLHttpRequest" } : undefined;
      response = await impit.fetch(url, headers ? { headers } : {});
    } catch (error) {
      if (error && error.code === "IMPIT_LOAD") throw error;
      const wrapped = new Error(error && error.message ? error.message : String(error));
      wrapped.code = "IMPIT_REQUEST";
      throw wrapped;
    }
    const text = await response.text();
    const retryAfter = headerValue(response.headers, "retry-after");
    const finalUrl = response.url || url;
    for (const line of setCookieLines(response.headers)) {
      await setCookie(line, finalUrl).catch(() => {});
    }
    const result = { status: response.status, text, retryAfter };
    if (isHardBlockHtml(text)) return { ...result, blocked: true };
    if (isCloudflareChallenge({ status: response.status, headers: response.headers, text })) {
      return { ...result, challenge: true };
    }
    if (response.status === 403 || response.status === 429 || response.status === 408 || response.status >= 500) {
      return { ...result, blocked: true };
    }
    return result;
  }

  return { fetch };
}

module.exports = {
  createHttpClient,
  isCloudflareChallenge,
  proxyUrlForImpit,
  parseSetCookie,
  freshHttpState,
  httpFallbackState,
  CHALLENGE_FALLBACK_STREAK
};
