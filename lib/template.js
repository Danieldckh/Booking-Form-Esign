// Assembles the final booking-form HTML that the client signs.
//
// The base.html template provides the page chrome: head, styles, header
// with address (contenteditable — the client's allowed to correct their
// own details here), and the legal strip at the bottom (also editable).
// Between them is a <!--CONTENT_SNIPPET--> placeholder where the booking
// section lives: services, pricing, deliverables. That section is
// rendered by format-deliverables.js and is STRICTLY read-only — the
// client cannot rewrite their own quote.
//
// The shared format-deliverables.js (carried over from the old Editable
// repo) emits cells marked contenteditable. We strip that attribute in
// this module before injecting into base.html so the booking section
// stays locked while base.html's header + legal strip stay editable.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEMPLATE_PATH = path.join(__dirname, "base.html.template");

let _baseHtmlCache = null;
function loadBaseHtml() {
  if (_baseHtmlCache) return _baseHtmlCache;
  _baseHtmlCache = fs.readFileSync(TEMPLATE_PATH, "utf8");
  return _baseHtmlCache;
}

/**
 * Lock down the content snippet (booking section) before injection.
 * Strips contenteditable/class="editable" from every element that has
 * it, so the client can only edit base.html's own header + legal strip.
 */
function lockContentSnippet(snippet) {
  return String(snippet || "")
    .replace(/\s+contenteditable="true"/gi, "")
    .replace(/\s+class="editable"/gi, "")
    .replace(/<div class="editable">/gi, "<div>")
    .replace(/<div\s+class="editable"\s*>/gi, "<div>");
}

/**
 * Patch the base.html so the old "Send booking form to ProAgri" flow
 * is replaced with Sign / Request Changes buttons that wire into the
 * new /api/sign endpoints.
 */
function patchForEsignFlow(html, token) {
  let patched = html;

  // Replace the single send button with two buttons (Sign + Request Changes)
  patched = patched.replace(
    /<div class="btn-row">[\s\S]*?<\/div>\s*<div class="status-line"[^>]*><\/div>/,
    `<div class="btn-row esign-actions">
      <button class="esign-btn esign-btn-changes" type="button" id="esign-request-changes">
        Request Changes
      </button>
      <button class="esign-btn esign-btn-sign" type="button" id="esign-sign">
        Sign Booking Form
      </button>
    </div>
    <div class="status-line" id="esign-status"></div>`
  );

  // Drop the old send-to-n8n / save-to-same-url script block. We leave the
  // header-editing helpers (logo upload, header persistence) intact because
  // they still apply to the editable header+legal strip.
  patched = patched.replace(
    /document\.getElementById\("send-booking-to-n8n"\)\.addEventListener[\s\S]*?\}\);\s*<\/script>/,
    '</script>'
  );

  // Inject the esign frontend: signature modal, change-request modal,
  // POST handlers, etc. The ESIGN_TOKEN global tells it which token to use.
  patched = patched.replace(
    /<\/body>/,
    `<link rel="stylesheet" href="/public/sign.css">
    <script>window.ESIGN_TOKEN = ${JSON.stringify(token || "")};</script>
    <script src="/public/sign.js"></script>
  </body>`
  );

  return patched;
}

/**
 * Given a content snippet (from format-deliverables.js) and a session
 * token, produce the full signed-ready HTML page.
 */
export function buildEsignPageHtml(contentSnippet, token) {
  const base = loadBaseHtml();
  const locked = lockContentSnippet(contentSnippet);
  const withContent = base.replace("<!--CONTENT_SNIPPET-->", locked);
  return patchForEsignFlow(withContent, token);
}
