"""Long-lived Camoufox. One JSON object per line on stdin and stdout.

Python 3.10–3.13 only. Camoufox fails on 3.14+ (PyYAML CLoader, fpgen).
Images, fonts and media are blocked with page.route. block_images stays off:
Camoufox treats that flag as a WAF signal. Challenge scripts are left alone.
"""

import asyncio
import json
import os
import re
import sys
import time
from urllib.parse import unquote, urlparse

MAX_PAGES = 3
CHALLENGE_WAIT_S = 45
GOTO_TIMEOUT_MS = 45000

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


def is_challenge(html, title):
    blob = f"{title or ''}\n{html or ''}"
    if re.search(r"you have been blocked", blob, re.I):
        return False
    if re.search(r"just a moment", blob, re.I) and re.search(
        r"cloudflare|challenge-platform|cf-challenge|turnstile", blob, re.I
    ):
        return True
    if title and re.search(r"just a moment", title, re.I):
        return True
    return bool(re.search(
        r"challenge-platform|cf-turnstile|cf-challenge-running|Attention Required! \| Cloudflare",
        html or "",
        re.I,
    ))


def still_interstitial(html, title):
    if HARD_BLOCK.search(html or ""):
        return False
    if is_challenge(html, title):
        return True
    text = re.sub(r"<[^>]+>", " ", html or "")
    return len(text.strip()) < 20 and not (title or "").strip()


async def intercept(route):
    kind = route.request.resource_type
    url = route.request.url or ""
    if kind in ("image", "media", "font") or (kind == "script" and not CHALLENGE_SCRIPT.search(url)):
        await route.abort()
        return
    await route.continue_()


async def fetch_page(context, url):
    started = time.monotonic()
    page = await context.new_page()
    try:
        await page.route("**/*", intercept)
        status = 0
        try:
            response = await page.goto(url, wait_until="domcontentloaded", timeout=GOTO_TIMEOUT_MS)
            if response is not None:
                status = response.status
        except Exception as error:
            return blank(started, str(error), page.url)
        deadline = time.monotonic() + CHALLENGE_WAIT_S
        html = ""
        title = ""
        while True:
            try:
                title = await page.title()
            except Exception:
                title = ""
            try:
                html = await page.content()
            except Exception:
                html = ""
            if not still_interstitial(html, title) or time.monotonic() >= deadline:
                break
            await page.wait_for_timeout(400)
        challenged = is_challenge(html, title)
        if not challenged and status in (403, 503) and not HARD_BLOCK.search(html or ""):
            status = 200
        return {
            "status": status,
            "html": html,
            "finalUrl": page.url or url,
            "ms": elapsed(started),
            "challenge": challenged,
        }
    finally:
        await page.close()


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


async def serve(context):
    loop = asyncio.get_running_loop()
    queue = asyncio.Queue()

    def read_stdin():
        for line in sys.stdin:
            loop.call_soon_threadsafe(queue.put_nowait, line)
        loop.call_soon_threadsafe(queue.put_nowait, None)

    import threading
    threading.Thread(target=read_stdin, daemon=True).start()
    sem = asyncio.Semaphore(MAX_PAGES)
    inflight = set()
    emit({"ready": True})

    async def handle(msg):
        async with sem:
            try:
                result = await fetch_page(context, msg.get("url") or "")
            except Exception as error:
                result = blank(time.monotonic(), str(error), "")
            result["id"] = msg.get("id")
            emit(result)

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
            break
        if "id" not in msg:
            continue
        task = asyncio.create_task(handle(msg))
        inflight.add(task)
        task.add_done_callback(inflight.discard)

    for task in list(inflight):
        task.cancel()
    if inflight:
        await asyncio.gather(*inflight, return_exceptions=True)


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

    options = {
        "headless": True,
        "persistent_context": True,
        "user_data_dir": profile,
    }
    if proxy:
        options["proxy"] = proxy
        options["geoip"] = True
    try:
        async with AsyncCamoufox(**options) as context:
            await serve(context)
    except SystemExit:
        raise
    except Exception as error:
        fail_ready(str(error))


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except Exception:
        pass
    asyncio.run(main())
