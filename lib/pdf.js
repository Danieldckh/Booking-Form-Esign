// Puppeteer-core wrapper — connects to a system-installed chromium
// (configured by the Dockerfile) and renders HTML → PDF bytes.
//
// We lazy-launch a single browser on first use and reuse it across
// requests. A launch-lock prevents double-launch under concurrent load.
//
// If chromium fails to start for any reason (missing binary, sandbox
// issues, OOM), renderHtmlToPdfBase64 returns null so callers can still
// persist the HTML snapshot — the PDF is best-effort, the HTML is the
// source of truth.

import puppeteer from "puppeteer-core";

const EXECUTABLE_PATH =
  process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium";

let _browser = null;
let _launching = null;

async function getBrowser() {
  if (_browser) return _browser;
  if (_launching) return _launching;
  _launching = puppeteer
    .launch({
      executablePath: EXECUTABLE_PATH,
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    })
    .then((b) => {
      _browser = b;
      _launching = null;
      b.on("disconnected", () => {
        _browser = null;
      });
      return b;
    })
    .catch((err) => {
      _launching = null;
      throw err;
    });
  return _launching;
}

// Render the given HTML to a base64-encoded PDF. Returns null on failure
// so snapshots still get persisted even if chromium is unavailable.
export async function renderHtmlToPdfBase64(html) {
  if (!html) return null;
  let page = null;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    await page.setContent(html, {
      waitUntil: "networkidle0",
      timeout: 30000,
    });
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "14mm", bottom: "14mm", left: "12mm", right: "12mm" },
    });
    return Buffer.from(pdf).toString("base64");
  } catch (err) {
    console.error("PDF render failed:", err.message);
    return null;
  } finally {
    if (page) {
      try {
        await page.close();
      } catch { /* ignore */ }
    }
  }
}

// Graceful shutdown helper — called from server.js on SIGTERM
export async function closeBrowser() {
  if (_browser) {
    try {
      await _browser.close();
    } catch { /* ignore */ }
    _browser = null;
  }
}
