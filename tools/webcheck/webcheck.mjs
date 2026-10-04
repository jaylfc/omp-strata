#!/usr/bin/env node
// webcheck: load a page in real headless Chromium, run a few actions, print one JSON report.
// Built for small local models: flat flags, no code to write, same output every time.
//
//   webcheck <url> [--device NAME | --viewport WxH [--mobile]] [--landscape] [--standalone]
//            [--wait MS] [--click SEL] [--tap X,Y] [--key KEY] [--eval EXPR] [--shot PATH]
//            [--timeout S]
//
// Actions (--wait, --click, --tap, --key, --eval, --shot) run in the order given.
// --eval runs EXPR in the page and reports its JSON value. Exit 0 means the report
// was produced (read "ok" and "pageErrors"); exit 2 means webcheck itself failed.
import puppeteer from "puppeteer-core";
import { existsSync } from "node:fs";

const DEVICES = {
  iphone14promax: { width: 430, height: 932, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  iphone15: { width: 393, height: 852, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  iphonese: { width: 375, height: 667, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  pixel7: { width: 412, height: 915, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true },
  ipad: { width: 820, height: 1180, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  desktop: { width: 1280, height: 800, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
};
const IOS_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const USAGE = `usage: webcheck <url> [--device ${Object.keys(DEVICES).join("|")}] [--viewport WxH] [--mobile]
       [--landscape] [--standalone] [--wait MS] [--click SEL] [--tap X,Y] [--key KEY]
       [--eval EXPR] [--shot PATH] [--timeout S]`;

function fail(message) {
  console.log(JSON.stringify({ ok: false, error: message, usage: USAGE }, null, 1));
  process.exit(2);
}

function parse(argv) {
  const opts = { actions: [], viewport: { ...DEVICES.desktop }, landscape: false, standalone: false, timeout: 30 };
  const takes = new Set(["--device", "--viewport", "--wait", "--click", "--tap", "--key", "--eval", "--shot", "--timeout"]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      if (opts.url) fail(`unexpected argument ${arg}`);
      opts.url = arg;
      continue;
    }
    const value = takes.has(arg) ? argv[++i] : undefined;
    if (takes.has(arg) && value === undefined) fail(`${arg} needs a value`);
    switch (arg) {
      case "--device":
        if (!DEVICES[value]) fail(`unknown device ${value}; use one of ${Object.keys(DEVICES).join(", ")}`);
        opts.viewport = { ...DEVICES[value] };
        opts.device = value;
        break;
      case "--viewport": {
        const m = /^(\d+)x(\d+)$/.exec(value);
        if (!m) fail("--viewport is WIDTHxHEIGHT, for example 430x932");
        opts.viewport = { ...opts.viewport, width: +m[1], height: +m[2] };
        break;
      }
      case "--mobile":
        opts.viewport = { ...opts.viewport, isMobile: true, hasTouch: true, deviceScaleFactor: 3 };
        break;
      case "--landscape":
        opts.landscape = true;
        break;
      case "--standalone":
        opts.standalone = true;
        break;
      case "--timeout":
        opts.timeout = Number(value) || 30;
        break;
      case "--wait":
        opts.actions.push({ wait: Number(value) || 0 });
        break;
      case "--click":
        opts.actions.push({ click: value });
        break;
      case "--tap": {
        const m = /^(\d+),(\d+)$/.exec(value);
        if (!m) fail("--tap is X,Y in CSS pixels, for example 120,700");
        opts.actions.push({ tap: [+m[1], +m[2]] });
        break;
      }
      case "--key":
        opts.actions.push({ key: value });
        break;
      case "--eval":
        opts.actions.push({ eval: value });
        break;
      case "--shot":
        opts.actions.push({ shot: value });
        break;
      case "--help":
        console.log(USAGE);
        process.exit(0);
      default:
        fail(`unknown flag ${arg}`);
    }
  }
  if (!opts.url) fail("missing url");
  if (opts.landscape) [opts.viewport.width, opts.viewport.height] = [opts.viewport.height, opts.viewport.width];
  return opts;
}

function chromePath() {
  for (const p of [process.env.WEBCHECK_CHROME, "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"]) {
    if (p && existsSync(p)) return p;
  }
  fail("no Chromium found; set WEBCHECK_CHROME to a Chromium or Chrome binary");
}

const opts = parse(process.argv.slice(2));
const report = { ok: true, url: opts.url, device: opts.device ?? null, viewport: opts.viewport, status: null, title: null,
  console: [], pageErrors: [], failedRequests: [], results: [] };
const browser = await puppeteer.launch({ executablePath: chromePath(), headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--hide-scrollbars", "--mute-audio"] });
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(opts.timeout * 1000);
  await page.setViewport(opts.viewport);
  if (opts.viewport.isMobile) await page.setUserAgent(IOS_UA);
  if (opts.standalone) {
    // Chromium cannot emulate display-mode, so answer that media query in the page, as an
    // installed iOS PWA would, and set navigator.standalone like iOS Safari does.
    await page.evaluateOnNewDocument(() => {
      const real = window.matchMedia.bind(window);
      window.matchMedia = query => {
        const m = /display-mode:\s*(standalone|fullscreen|minimal-ui|browser)/.exec(query);
        if (!m) return real(query);
        const result = real("all");
        Object.defineProperty(result, "matches", { get: () => m[1] === "standalone" });
        Object.defineProperty(result, "media", { get: () => query });
        return result;
      };
      Object.defineProperty(navigator, "standalone", { get: () => true });
    });
  }
  page.on("console", m => {
    if (["error", "warn", "warning"].includes(m.type()) && report.console.length < 30) {
      report.console.push(`${m.type()}: ${m.text()}`.slice(0, 300));
    }
  });
  page.on("pageerror", e => report.pageErrors.push(String(e?.stack ?? e).split("\n").slice(0, 3).join(" | ").slice(0, 400)));
  page.on("requestfailed", r => report.failedRequests.push(`${r.url()} ${r.failure()?.errorText ?? ""}`.slice(0, 200)));
  page.on("response", r => { if (r.status() >= 400) report.failedRequests.push(`${r.status()} ${r.url()}`.slice(0, 200)); });

  const response = await page.goto(opts.url, { waitUntil: "load" });
  report.status = response?.status() ?? null;
  report.title = await page.title();
  for (const action of opts.actions) {
    try {
      if ("wait" in action) {
        await new Promise(r => setTimeout(r, action.wait));
        report.results.push({ wait: action.wait });
      } else if ("click" in action) {
        await page.click(action.click);
        report.results.push({ click: action.click, ok: true });
      } else if ("tap" in action) {
        const [x, y] = action.tap;
        const hit = await page.evaluate((x, y) => {
          const el = document.elementFromPoint(x, y);
          return el ? `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}${el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/).join(".") : ""}` : null;
        }, x, y);
        if (opts.viewport.hasTouch) await page.touchscreen.tap(x, y);
        else await page.mouse.click(x, y);
        report.results.push({ tap: [x, y], element: hit, input: opts.viewport.hasTouch ? "touch" : "mouse" });
      } else if ("key" in action) {
        await page.keyboard.press(action.key);
        report.results.push({ key: action.key, ok: true });
      } else if ("eval" in action) {
        const value = await page.evaluate(`(async () => (${action.eval}))()`);
        report.results.push({ eval: action.eval, value: value === undefined ? null : value });
      } else if ("shot" in action) {
        await page.screenshot({ path: action.shot });
        report.results.push({ shot: action.shot });
      }
    } catch (e) {
      report.ok = false;
      report.results.push({ ...action, error: String(e?.message ?? e).split("\n")[0].slice(0, 300) });
    }
  }
  if (report.pageErrors.length || (report.status ?? 0) >= 400) report.ok = false;
  if (report.status === null && /^https?:/.test(opts.url)) report.ok = false;
} catch (e) {
  report.ok = false;
  report.error = String(e?.message ?? e).split("\n")[0].slice(0, 300);
} finally {
  await browser.close();
}
console.log(JSON.stringify(report, null, 1));
