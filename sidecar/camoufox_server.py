"""Long-lived Camoufox. One JSON object per line on stdin and stdout.

Python 3.10–3.13 only. Camoufox fails on 3.14+ (PyYAML CLoader, fpgen).
Two pages stay open and are reused. The route is registered once on the context.
Images, fonts and media are blocked there. block_images stays off: Camoufox
treats that flag as a WAF signal. Challenge scripts are left alone.
The same profile is relaunched every 300 pages, or after 25 pages when the
largest browser process passes 1.5 GB (shared pages are not summed), so
cf_clearance survives. A process that starts above the cap is left alone
until it grows another 512 MB.
"""

import asyncio
import json
import os
import re
import sys
import time
from urllib.parse import unquote, urlparse

MAX_PAGES = 2
CHALLENGE_WAIT_S = 45
GOTO_TIMEOUT_MS = 45000
CHALLENGE_POLL_MS = 1000
RECYCLE_PAGES = 300
RSS_LIMIT_BYTES = int(1.5 * 1024 * 1024 * 1024)

# Rendering cost only. Nothing here changes WebGL, canvas, the user agent, or the font list.
FIREFOX_PREFS = {
    "layout.frame_rate": 10,
    "general.smoothScroll": False,
    "general.smoothScroll.mouseWheel": False,
    "general.smoothScroll.other": False,
    "general.smoothScroll.pages": False,
    "image.animation_mode": "none",
    "toolkit.cosmeticAnimations.enabled": False,
    "browser.cache.memory.capacity": 65536,
    "media.autoplay.default": 5,
    "media.autoplay.enabled": False,
}

PROBE_JS = r"""() => {
  const title = document.title || "";
  const challenge = !!(
    document.getElementById("challenge-form") ||
    document.getElementById("challenge-running") ||
    document.querySelector(".cf-turnstile") ||
    document.querySelector(".cf-challenge-running")
  );
  let chars = 0;
  const root = document.body;
  if (root && typeof document.createTreeWalker === "function") {
    const reject = (node) => {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    };
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: reject });
    let node = walker.nextNode();
    while (node && chars < 80) {
      chars += (node.nodeValue || "").replace(/\s+/g, "").length;
      node = walker.nextNode();
    }
  }
  return { title, challenge, chars };
}"""

CHALLENGE_SCRIPT = re.compile(r"challenges\.cloudflare\.com|/cdn-cgi/challenge-platform/|turnstile", re.I)
HARD_BLOCK = re.compile(r"you have been blocked|error code:\s*10(?:20|15|06)", re.I)


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def fail_ready(message):
    emit({"ready": False, "error": message})
    raise SystemExit(1)


def proxy_config(raw):
    text = (raw or "").strip()
    if not text:
        return None
    parsed = urlparse(text)
    scheme = (parsed.scheme or "").lower()
    if scheme not in ("socks5", "socks5h", "http", "https") or not parsed.hostname or not parsed.port:
        raise ValueError("proxy must be socks5://host:port or http://host:port")
    server_scheme = "socks5" if scheme.startswith("socks") else scheme
    proxy = {"server": f"{server_scheme}://{parsed.hostname}:{parsed.port}"}
    if parsed.username:
        proxy["username"] = unquote(parsed.username)
        proxy["password"] = unquote(parsed.password or "")
    return proxy


def visible_text(html):
    text = re.sub(r"<script[\s\S]*?</script>", " ", html or "", flags=re.I)
    text = re.sub(r"<style[\s\S]*?</style>", " ", text, flags=re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def document_title(html, title):
    given = (title or "").strip()
    if given:
        return given
    match = re.search(r"<title[^>]*>([\s\S]*?)</title>", html or "", re.I)
    return re.sub(r"\s+", " ", match.group(1)).strip() if match else ""


def is_challenge(html, title="", mitigated=""):
    """Real interstitials only. A normal page's challenge-platform script is not one."""
    html = html or ""
    if HARD_BLOCK.search(f"{title or ''}\n{html}"):
        return False
    page_title = document_title(html, title)
    if re.search(r"just a moment", page_title, re.I):
        return True
    if re.search(r"Attention Required!\s*\|\s*Cloudflare", page_title, re.I):
        return True
    if len(visible_text(html)) >= 80:
        return False
    if mitigated and re.search(r"challenge", mitigated, re.I):
        return True
    if re.search(r"id=[\"']challenge-form[\"']", html, re.I):
        return True
    if re.search(r"id=[\"']challenge-running[\"']", html, re.I):
        return True
    if re.search(r"class=[\"'][^\"']*\bcf-turnstile\b", html, re.I):
        return True
    if re.search(r"cf-challenge-running", html, re.I):
        return True
    return False


def still_interstitial(html, title, mitigated=""):
    if is_challenge(html, title, mitigated):
        return True
    return len(visible_text(html)) < 20 and not document_title(html, title)


def probe_waiting(probe, mitigated=""):
    """Cheap stand-in for still_interstitial. The full HTML is read once, after this is false."""
    if not isinstance(probe, dict) or probe.get("error"):
        return True
    title = str(probe.get("title") or "")
    if HARD_BLOCK.search(title):
        return False
    if re.search(r"just a moment", title, re.I):
        return True
    if re.search(r"Attention Required!\s*\|\s*Cloudflare", title, re.I):
        return True
    try:
        chars = int(probe.get("chars") or 0)
    except (TypeError, ValueError):
        chars = 0
    if chars >= 80:
        return False
    if probe.get("challenge"):
        return True
    if mitigated and re.search(r"challenge", mitigated, re.I):
        return True
    if chars < 20 and not title.strip():
        return True
    return False


MIN_RSS_PAGES = 25
RSS_GROWTH_BYTES = 512 * 1024 * 1024


def needs_recycle(pages_done, rss_bytes, hold_rss=False, baseline=0):
    """Recycle on page count, or after the main process grows past the cap.

    A browser that is already large at startup must not relaunch on page 1.
    hold_rss keeps that guard for a process that was just relaunched.
    """
    done = int(pages_done or 0)
    if done >= RECYCLE_PAGES:
        return True
    if hold_rss or done < MIN_RSS_PAGES:
        return False
    try:
        rss = int(rss_bytes or 0)
    except (TypeError, ValueError):
        rss = 0
    try:
        base = int(baseline or 0)
    except (TypeError, ValueError):
        base = 0
    floor = RSS_LIMIT_BYTES
    if base > floor:
        floor = base + RSS_GROWTH_BYTES
    return rss > floor


def _proc_rss(pid):
    try:
        with open(f"/proc/{pid}/status", encoding="utf-8") as handle:
            for line in handle:
                if line.startswith("VmRSS:"):
                    return int(line.split()[1]) * 1024
    except (OSError, ValueError, IndexError):
        return 0
    return 0


def _proc_children(pid):
    try:
        with open(f"/proc/{pid}/task/{pid}/children", encoding="utf-8") as handle:
            return [int(part) for part in handle.read().split()]
    except (OSError, ValueError):
        return []


def _ps_rows():
    import subprocess
    try:
        out = subprocess.check_output(["ps", "-ax", "-o", "pid=,ppid=,rss="], text=True)
    except (OSError, subprocess.SubprocessError):
        return []
    rows = []
    for line in out.splitlines():
        parts = line.split()
        if len(parts) < 3:
            continue
        try:
            rows.append((int(parts[0]), int(parts[1]), int(parts[2]) * 1024))
        except ValueError:
            continue
    return rows


def browser_rss_bytes(root=None):
    """RSS of the largest browser process, not the sum of the tree.

    Plugin-containers and the GPU process each report shared pages, so a sum
    looks like 2.5 GB while the main process is still near the startup size.
    """
    root = os.getpid() if root is None else int(root)
    largest = 0
    if os.path.isdir("/proc"):
        stack = _proc_children(root)
        seen = set()
        while stack:
            pid = stack.pop()
            if pid in seen:
                continue
            seen.add(pid)
            largest = max(largest, _proc_rss(pid))
            stack.extend(_proc_children(pid))
        return largest
    rows = _ps_rows()
    by_parent = {}
    rss = {}
    for pid, ppid, size in rows:
        rss[pid] = size
        by_parent.setdefault(ppid, []).append(pid)
    stack = list(by_parent.get(root, []))
    seen = set()
    while stack:
        pid = stack.pop()
        if pid in seen:
            continue
        seen.add(pid)
        largest = max(largest, rss.get(pid, 0))
        stack.extend(by_parent.get(pid, []))
    return largest


async def intercept(route):
    kind = route.request.resource_type
    url = route.request.url or ""
    if kind in ("image", "media", "font") or (kind == "script" and not CHALLENGE_SCRIPT.search(url)):
        await route.abort()
        return
    await route.continue_()


def header_value(response, name):
    if response is None:
        return ""
    try:
        return response.headers.get(name) or ""
    except Exception:
        return ""


class PagePool:
    """A fixed set of pages. The route is on the context, registered once by the caller."""

    def __init__(self, context, size):
        self.context = context
        self.size = size
        self.free = asyncio.Queue()
        self.busy = set()
        self.alive = set()
        self.shut = False
        self.lock = asyncio.Lock()

    async def fill(self):
        async with self.lock:
            existing = []
            try:
                existing = list(self.context.pages)
            except Exception:
                existing = []
            for page in existing:
                if len(self.alive) >= self.size:
                    await self._close(page)
                    continue
                self.alive.add(page)
                self.free.put_nowait(page)
            await self._top_up()

    async def ensure(self):
        """Replace pages Stop closed. A cancelled fetch must not be the one that calls new_page."""
        if self.shut:
            return
        async with self.lock:
            self.alive = {page for page in self.alive if not page.is_closed()}
            await self._top_up()

    async def _top_up(self):
        while len(self.alive) < self.size and not self.shut:
            page = await self.context.new_page()
            self.alive.add(page)
            self.free.put_nowait(page)

    async def acquire(self):
        page = await self.free.get()
        self.busy.add(page)
        return page

    async def release(self, page):
        async with self.lock:
            self.busy.discard(page)
            if page.is_closed():
                self.alive.discard(page)
                return
            self.free.put_nowait(page)

    async def close_busy(self):
        for page in list(self.busy):
            await self._close(page)

    async def close(self):
        self.shut = True
        for page in list(self.alive):
            await self._close(page)
        self.alive.clear()
        self.busy.clear()

    async def _close(self, page):
        try:
            await page.close()
        except Exception:
            pass


async def cheap_probe(page):
    try:
        probe = await page.evaluate(PROBE_JS)
    except asyncio.CancelledError:
        raise
    except Exception:
        return {"title": "", "challenge": False, "chars": 0, "error": True}
    if not isinstance(probe, dict):
        return {"title": "", "challenge": False, "chars": 0, "error": True}
    return probe


ORIGIN = "https://www.myfxbook.com"
CONTEST_LINKS_JS = r"""() => {
  const html = document.documentElement ? document.documentElement.innerHTML : "";
  return /\/contests\/[^\s"'<>]*\d/.test(html) || html.indexOf("\\/contests\\/") !== -1;
}"""


def contest_index(url):
    path = urlparse(url or "").path or ""
    return path.rstrip("/") == "/contests"


async def wait_for_contest_links(page):
    # The index often paints the table after DOMContentLoaded. Snapshot too
    # early and the HTML has no /contests/<id> links.
    try:
        await page.wait_for_function(CONTEST_LINKS_JS, timeout=5000)
    except asyncio.CancelledError:
        raise
    except Exception:
        return


XHR_JS = """async (url) => {
  try {
    const res = await fetch(url, {
      credentials: "include",
      redirect: "follow",
      headers: {
        "X-Requested-With": "XMLHttpRequest",
        "Accept": "text/html, */*; q=0.8"
      }
    });
    return {
      status: res.status,
      text: await res.text(),
      mitigated: res.headers.get("cf-mitigated") || ""
    };
  } catch (error) {
    return { status: 0, text: "", mitigated: "", error: String(error && error.message || error) };
  }
}"""


def on_myfxbook(page):
    try:
        return str(page.url or "").startswith(ORIGIN)
    except Exception:
        return False


def xhr_challenged(data):
    if not isinstance(data, dict):
        return False
    try:
        status = int(data.get("status") or 0)
    except (TypeError, ValueError):
        status = 0
    mitigated = str(data.get("mitigated") or "")
    html = str(data.get("text") or "")
    if status in (403, 503) and re.search(r"challenge", mitigated, re.I):
        return True
    return is_challenge(html, "", mitigated)


async def read_document(page, url, started):
    status = 0
    mitigated = ""
    try:
        response = await page.goto(url, wait_until="domcontentloaded", timeout=GOTO_TIMEOUT_MS)
        if response is not None:
            status = response.status
            mitigated = header_value(response, "cf-mitigated")
    except asyncio.CancelledError:
        raise
    except Exception as error:
        final = ""
        try:
            final = page.url
        except Exception:
            final = ""
        return blank(started, str(error), final)
    deadline = time.monotonic() + CHALLENGE_WAIT_S
    while True:
        probe = await cheap_probe(page)
        if not probe_waiting(probe, mitigated) or time.monotonic() >= deadline:
            break
        try:
            await page.wait_for_timeout(CHALLENGE_POLL_MS)
        except asyncio.CancelledError:
            raise
        except Exception:
            break
    if contest_index(url) and not probe_waiting(probe, mitigated):
        await wait_for_contest_links(page)
    try:
        html = await page.content()
    except asyncio.CancelledError:
        raise
    except Exception:
        html = ""
    try:
        title = await page.title()
    except asyncio.CancelledError:
        raise
    except Exception:
        title = ""
    challenged = is_challenge(html, title, mitigated)
    if not challenged and status in (403, 503) and not HARD_BLOCK.search(html or ""):
        status = 200
    final_url = url
    try:
        final_url = page.url or url
    except Exception:
        final_url = url
    return {
        "status": status,
        "html": html,
        "finalUrl": final_url,
        "ms": elapsed(started),
        "challenge": challenged,
    }


async def read_xhr(page, url):
    try:
        data = await page.evaluate(XHR_JS, url)
    except asyncio.CancelledError:
        raise
    except Exception as error:
        return {"status": 0, "text": "", "mitigated": "", "error": str(error)}
    if not isinstance(data, dict):
        return {"status": 0, "text": "", "mitigated": "", "error": "empty xhr"}
    return data


async def fetch_xhr(page, url, started):
    if not on_myfxbook(page):
        opened = await read_document(page, f"{ORIGIN}/contests", started)
        if opened.get("error") or opened.get("challenge") or not on_myfxbook(page):
            return opened
    data = await read_xhr(page, url)
    if data.get("error") and not data.get("text"):
        return blank(started, str(data.get("error")), url)
    if xhr_challenged(data):
        referer = page.url if on_myfxbook(page) else f"{ORIGIN}/contests"
        cleared = await read_document(page, referer, started)
        if cleared.get("challenge"):
            return cleared
        data = await read_xhr(page, url)
        if data.get("error") and not data.get("text"):
            return blank(started, str(data.get("error")), url)
    try:
        status = int(data.get("status") or 0)
    except (TypeError, ValueError):
        status = 0
    return {
        "status": status,
        "html": str(data.get("text") or ""),
        "finalUrl": url,
        "ms": elapsed(started),
        "challenge": xhr_challenged(data),
    }


async def fetch_page(pool, url, xhr=False):
    started = time.monotonic()
    await pool.ensure()
    page = await pool.acquire()
    try:
        if xhr:
            return await fetch_xhr(page, url, started)
        return await read_document(page, url, started)
    finally:
        await pool.release(page)


def elapsed(started):
    return int((time.monotonic() - started) * 1000)


def blank(started, message, final_url):
    return {
        "status": 0,
        "html": "",
        "finalUrl": final_url or "",
        "ms": elapsed(started),
        "challenge": False,
        "error": message,
    }


async def open_context(options):
    from camoufox.async_api import AsyncCamoufox

    cm = AsyncCamoufox(**options)
    context = await cm.__aenter__()
    await context.route("**/*", intercept)
    pool = PagePool(context, MAX_PAGES)
    await pool.fill()
    return cm, pool


async def close_context(cm, pool):
    if pool:
        await pool.close()
    if not cm:
        return
    try:
        await cm.__aexit__(None, None, None)
    except Exception:
        pass


async def relaunch(options, cm, pool):
    await close_context(cm, pool)
    delay = 0.25
    last = None
    for _ in range(4):
        try:
            return await open_context(options)
        except Exception as error:
            last = error
            await asyncio.sleep(delay)
            delay = min(delay * 2, 2)
    raise last


def note_err(line):
    sys.stderr.write(line.rstrip() + "\n")
    try:
        sys.stderr.flush()
    except Exception:
        pass


async def serve(options):
    loop = asyncio.get_running_loop()
    queue = asyncio.Queue()

    def read_stdin():
        for line in sys.stdin:
            loop.call_soon_threadsafe(queue.put_nowait, line)
        loop.call_soon_threadsafe(queue.put_nowait, None)

    import threading
    threading.Thread(target=read_stdin, daemon=True).start()

    try:
        cm, pool = await open_context(options)
    except Exception as error:
        fail_ready(str(error))
    state = {
        "cm": cm,
        "pool": pool,
        "active": 0,
        "pages": 0,
        "recycling": False,
        "closing": False,
        "hold_rss": False,
        "baseline": 0,
    }
    idle = asyncio.Condition()
    inflight = set()
    emit({"ready": True})

    def cancel_pages(shut=False):
        for task in list(inflight):
            task.cancel()
        current = state["pool"]
        if not current:
            return
        if shut:
            current.shut = True
        asyncio.create_task(current.close_busy())

    async def finish_recycle(old, failed_message=""):
        try:
            if failed_message:
                raise RuntimeError(failed_message)
            fresh = await relaunch(options, old[0], old[1])
            rss = browser_rss_bytes()
            note_err(f"camoufox recycle pages={state['pages']} rss={rss}")
            installed = fresh
            failed = False
        except Exception as error:
            note_err(f"camoufox recycle failed: {error}")
            installed = (None, None)
            rss = 0
            failed = True
        async with idle:
            state["cm"], state["pool"] = installed
            if not failed:
                state["pages"] = 0
                state["baseline"] = rss if rss > 0 else 0
                state["hold_rss"] = False
            state["recycling"] = False
            idle.notify_all()

    async def maybe_recycle():
        async with idle:
            if state["closing"] or state["recycling"] or state["active"] != 0:
                return None
            rss = browser_rss_bytes()
            if state["baseline"] <= 0 and rss > 0:
                state["baseline"] = rss
            if not needs_recycle(state["pages"], rss, state["hold_rss"], state["baseline"]):
                return None
            state["recycling"] = True
            old = (state["cm"], state["pool"])
            state["cm"] = None
            state["pool"] = None
        await finish_recycle(old)

    async def handle(msg):
        async with idle:
            while state["recycling"] and not state["closing"]:
                await idle.wait()
            if state["closing"]:
                emit({**blank(time.monotonic(), "stopped", ""), "id": msg.get("id")})
                return
            if state["pool"] is None:
                state["recycling"] = True
                need_open = True
            else:
                state["active"] += 1
                pool_ref = state["pool"]
                need_open = False
        if need_open:
            try:
                fresh = await open_context(options)
            except Exception as error:
                async with idle:
                    state["recycling"] = False
                    idle.notify_all()
                emit({**blank(time.monotonic(), str(error), ""), "id": msg.get("id")})
                return
            async with idle:
                state["cm"], state["pool"] = fresh
                state["pages"] = 0
                state["baseline"] = 0
                state["hold_rss"] = False
                state["recycling"] = False
                if state["closing"]:
                    idle.notify_all()
                    emit({**blank(time.monotonic(), "stopped", ""), "id": msg.get("id")})
                    return
                state["active"] += 1
                pool_ref = state["pool"]
                idle.notify_all()
        try:
            try:
                result = await fetch_page(pool_ref, msg.get("url") or "", bool(msg.get("xhr")))
            except asyncio.CancelledError:
                raise
            except Exception as error:
                result = blank(time.monotonic(), str(error), "")
            result["id"] = msg.get("id")
            emit(result)
        finally:
            async with idle:
                state["active"] -= 1
                if not state["closing"]:
                    state["pages"] += 1
                idle.notify_all()
        await maybe_recycle()

    try:
        while True:
            line = await queue.get()
            if line is None:
                break
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(msg, dict):
                continue
            if msg.get("cmd") == "stop":
                cancel_pages()
                continue
            if msg.get("cmd") == "quit":
                async with idle:
                    state["closing"] = True
                    idle.notify_all()
                cancel_pages(shut=True)
                break
            if "id" not in msg:
                continue
            task = asyncio.create_task(handle(msg))
            inflight.add(task)
            task.add_done_callback(inflight.discard)
    finally:
        async with idle:
            state["closing"] = True
            while state["recycling"]:
                await idle.wait()
            cm = state["cm"]
            pool = state["pool"]
            state["cm"] = None
            state["pool"] = None
            idle.notify_all()
        if pool:
            pool.shut = True
        for task in list(inflight):
            task.cancel()
        if inflight:
            await asyncio.gather(*inflight, return_exceptions=True)
        await close_context(cm, pool)


def browser_installed():
    try:
        from camoufox.pkgman import installed_verstr
        return bool(installed_verstr())
    except Exception:
        return False


def fetch_browser():
    # The packaged app has the Python sidecar, not the Firefox build. The
    # browser still lands in the user cache (Library/Caches/camoufox on macOS).
    if browser_installed():
        return
    import click
    from camoufox.__main__ import fetch
    print("camoufox fetch: downloading browser", file=sys.stderr, flush=True)
    click.confirm = lambda *args, **kwargs: True
    fetch.callback(None)


async def main():
    version = sys.version_info
    if version < (3, 10) or version >= (3, 14):
        fail_ready(f"Python {version.major}.{version.minor} is not supported; need 3.10–3.13")
    profile = os.environ.get("LEADFINDER_PROFILE") or ""
    if not profile:
        fail_ready("LEADFINDER_PROFILE is not set")
    os.makedirs(profile, exist_ok=True)
    try:
        proxy = proxy_config(os.environ.get("LEADFINDER_PROXY"))
    except ValueError as error:
        fail_ready(str(error))
    try:
        from camoufox.async_api import AsyncCamoufox
    except Exception as error:
        fail_ready(f"camoufox is not installed ({error}). Run npm run setup:camoufox")
    del AsyncCamoufox

    options = {
        "headless": True,
        "persistent_context": True,
        "user_data_dir": profile,
        "firefox_user_prefs": FIREFOX_PREFS,
    }
    if proxy:
        options["proxy"] = proxy
        options["geoip"] = True
    try:
        await serve(options)
    except SystemExit:
        raise
    except Exception as error:
        fail_ready(str(error))


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except Exception:
        pass
    if "--fetch-browser" in sys.argv:
        try:
            fetch_browser()
        except SystemExit as error:
            code = error.code if isinstance(error.code, int) else 1
            raise SystemExit(code)
        raise SystemExit(0)
    asyncio.run(main())
