// ============================================================================
// Booking Form Esign — single consolidated app that replaces the old
// Editable-booking-form + esign-booking-form pair.
//
// Flow:
//   1. An admin (via the CRM or a direct API call) POSTs a pre-rendered
//      HTML booking form + the booking_form_id to POST /api/admin/create-token.
//      The server stores the HTML snapshot + a random token in
//      booking_form_esign_tokens and returns the URL /sign/:token.
//   2. The client opens /sign/:token. The server reads the snapshot
//      from the token row, injects Sign / Request Changes buttons and
//      the frontend JS, and serves it as a full HTML page. Only the
//      header address and legal strip are editable.
//   3. The client either signs (canvas signature) or requests changes
//      (free-text notes). Either way the frontend POSTs to
//      /api/sign/:token/sign or /api/sign/:token/change-request with
//      the current HTML snapshot + metadata.
//   4. The server renders the snapshot to PDF via puppeteer-core,
//      appends a row to booking_form_revisions (APPEND-ONLY, never
//      updated), and also updates the "latest pointer" columns on
//      booking_forms so CRM queries see the current state.
// ============================================================================

import express from "express";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { pool, toCamelCase } from "./lib/db.js";
import { buildEsignPageHtml } from "./lib/template.js";
import { renderHtmlToPdfBase64, closeBrowser } from "./lib/pdf.js";
import { renderBookingFormHtml } from "./lib/format-deliverables.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "25mb" }));

// Basic CORS — the Sign/Change buttons POST same-origin, but allowing *
// keeps admin tools calling /api/admin/create-token from the CRM working
// without a proxy.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Admin-Secret");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Static assets — logo + sign.css + sign.js
app.use("/public", express.static(path.join(__dirname, "public")));

// ── Health check (Coolify hits GET / for liveness) ──────────────────
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "booking-form-esign" });
});

// ── Token utilities ─────────────────────────────────────────────────
function newToken() {
  return crypto.randomBytes(24).toString("hex"); // 48 char hex
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) return String(forwarded).split(",")[0].trim();
  return req.socket?.remoteAddress || null;
}

// ── Admin: create a new signing session ─────────────────────────────
//
// Protected by a shared secret so random callers can't mint tokens.
// Pass it as the X-Admin-Secret header; set ADMIN_SECRET in the
// Coolify env. If ADMIN_SECRET is unset, auth is open (useful for
// local dev only — don't deploy without it).
//
// Body:
//   { bookingFormId: number, html: string, expiresInDays?: number }
function requireAdmin(req, res, next) {
  const expected = process.env.ADMIN_SECRET;
  if (!expected) return next(); // open in dev
  const got = req.headers["x-admin-secret"];
  if (got !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

app.post("/api/admin/create-token", requireAdmin, async (req, res) => {
  try {
    const { bookingFormId, html, expiresInDays } = req.body || {};
    if (!bookingFormId) {
      return res.status(400).json({ error: "bookingFormId is required" });
    }

    // Verify the booking form exists AND grab form_data so we can render
    // the HTML on the fly when the caller doesn't pass one. This is the
    // common case from the CRM admin flow — pass an id, get a session.
    const bf = await pool.query(
      "SELECT id, form_data FROM booking_forms WHERE id = $1",
      [bookingFormId]
    );
    if (bf.rows.length === 0) {
      return res.status(404).json({ error: "Booking form not found" });
    }

    // Resolve the HTML snapshot to store on the token. Two paths:
    //   1. Caller provided pre-rendered HTML → use it (legacy / advanced)
    //   2. Caller provided just bookingFormId → render from form_data
    // If form_data is missing AND no html was provided, we can't proceed.
    let snapshotHtml = html;
    if (!snapshotHtml) {
      const formData = bf.rows[0].form_data;
      if (!formData) {
        return res.status(400).json({
          error: "Booking form has no form_data; provide html in the request body or attach form_data first"
        });
      }
      try {
        // renderBookingFormHtml returns just the deliverables rows. We
        // wrap them in a <table class="booking-table"> so base.html's
        // existing styling kicks in, and prepend a small company info
        // table built directly from client_information for the page
        // header (company name, trading name, primary contact, email).
        const innerRows = renderBookingFormHtml(formData);
        const ci = formData.client_information || {};
        const pc = ci.primary_contact || {};
        const escapeHtml = (s) =>
          String(s == null ? "" : s)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;")
            .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
        const companyInfoTable = `
<table class="company-table">
  <tr><td>Full Company Name</td><td>${escapeHtml(ci.company_name)}</td></tr>
  <tr><td>Trading Name</td><td>${escapeHtml(ci.trading_name)}</td></tr>
  <tr><td>Reg Number</td><td>${escapeHtml(ci.company_reg_number)}</td></tr>
  <tr><td>VAT Number</td><td>${escapeHtml(ci.vat_number)}</td></tr>
  <tr><td>Contact Person</td><td>${escapeHtml(pc.name)}</td></tr>
  <tr><td>Email</td><td>${escapeHtml(pc.email)}</td></tr>
  <tr><td>Phone</td><td>${escapeHtml(pc.cell || pc.tel)}</td></tr>
</table>
`;
        const bookingTable = `
<div class="booking-table-wrapper">
  <table class="booking-table">
    <tbody>${innerRows}</tbody>
  </table>
</div>
`;
        snapshotHtml = companyInfoTable + bookingTable;
      } catch (e) {
        console.error("Render from form_data failed:", e);
        return res.status(500).json({ error: "Failed to render booking form HTML: " + e.message });
      }
    }

    const token = newToken();
    const expiresAt = expiresInDays
      ? new Date(Date.now() + Number(expiresInDays) * 86400000)
      : null;

    await pool.query(
      `INSERT INTO booking_form_esign_tokens
        (booking_form_id, token, html_snapshot, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [bookingFormId, token, snapshotHtml, expiresAt]
    );

    // Also write the canonical URL back to booking_forms.esign_url so
    // the CRM's Proposal sheet can display a link without another round-trip
    const baseUrl = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
    const signUrl = `${baseUrl}/sign/${token}`;
    await pool.query(
      "UPDATE booking_forms SET esign_url = $1, updated_at = NOW() WHERE id = $2",
      [signUrl, bookingFormId]
    );

    res.status(201).json({ success: true, token, url: signUrl });
  } catch (err) {
    console.error("Create token error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── Token lookup helper (reused by every /sign and /api/sign route) ─
async function loadTokenRow(token) {
  const result = await pool.query(
    `SELECT bfet.*, bf.status AS booking_status, bf.signed_at
     FROM booking_form_esign_tokens bfet
     LEFT JOIN booking_forms bf ON bf.id = bfet.booking_form_id
     WHERE bfet.token = $1`,
    [token]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  if (row.expires_at && new Date(row.expires_at) < new Date()) return null;
  return row;
}

// ── GET /sign/:token — serve the signing page ──────────────────────
app.get("/sign/:token", async (req, res) => {
  try {
    const row = await loadTokenRow(req.params.token);
    if (!row) {
      return res.status(404).type("html").send(
        `<!doctype html><html><body style="font-family:sans-serif;padding:40px">
         <h1>Link expired or invalid</h1>
         <p>This booking form signing link is no longer valid. Please contact ProAgri for a new one.</p>
         </body></html>`
      );
    }

    // Update last_accessed_at (non-blocking)
    pool.query(
      "UPDATE booking_form_esign_tokens SET last_accessed_at = NOW() WHERE token = $1",
      [req.params.token]
    ).catch((e) => console.error("last_accessed_at update failed:", e.message));

    // If already signed, show a read-only "already signed" view instead
    // of the editable page. Clients shouldn't accidentally re-sign.
    if (row.signed_at) {
      return res.type("html").send(
        `<!doctype html><html><body style="font-family:sans-serif;padding:40px;max-width:700px;margin:0 auto">
         <h1>Already signed</h1>
         <p>This booking form was signed on ${new Date(row.signed_at).toLocaleString()}.
         A copy is on file with ProAgri. If you need to make changes, please contact your account manager.</p>
         </body></html>`
      );
    }

    const fullHtml = buildEsignPageHtml(row.html_snapshot, req.params.token);
    res.type("html").send(fullHtml);
  } catch (err) {
    console.error("Serve sign page error:", err);
    res.status(500).send("Internal server error");
  }
});

// ── GET /api/sign/:token — JSON form metadata for the frontend ──────
app.get("/api/sign/:token", async (req, res) => {
  try {
    const row = await loadTokenRow(req.params.token);
    if (!row) return res.status(404).json({ error: "Token not found or expired" });
    res.json({
      bookingFormId: row.booking_form_id,
      bookingStatus: row.booking_status,
      signedAt: row.signed_at,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    });
  } catch (err) {
    console.error("Get sign metadata error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── Shared revision-append helper ───────────────────────────────────
async function appendRevision({
  bookingFormId,
  action,
  htmlSnapshot,
  signerName,
  signerEmail,
  signatureData,
  changeNotes,
  clientIp,
  userAgent,
}) {
  // Render the final snapshot to PDF. If chromium is unavailable the
  // PDF is null and we still persist the HTML snapshot — the HTML is
  // the legal source of truth, the PDF is a best-effort convenience.
  const pdfBase64 = await renderHtmlToPdfBase64(htmlSnapshot);

  const result = await pool.query(
    `INSERT INTO booking_form_revisions
      (booking_form_id, action, html_snapshot, pdf_base64,
       signer_name, signer_email, signature_data, change_notes,
       client_ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id, created_at`,
    [
      bookingFormId,
      action,
      htmlSnapshot || null,
      pdfBase64,
      signerName || null,
      signerEmail || null,
      signatureData ? JSON.stringify(signatureData) : null,
      changeNotes || null,
      clientIp,
      userAgent,
    ]
  );
  return { id: result.rows[0].id, createdAt: result.rows[0].created_at, pdfBase64 };
}

// ── POST /api/sign/:token/sign — client signs ───────────────────────
app.post("/api/sign/:token/sign", async (req, res) => {
  try {
    const row = await loadTokenRow(req.params.token);
    if (!row) return res.status(404).json({ error: "Token not found or expired" });
    if (row.signed_at) return res.status(409).json({ error: "Already signed" });

    const { htmlSnapshot, signerName, signerEmail, signatureData } = req.body || {};
    if (!htmlSnapshot || !signerName || !signatureData) {
      return res.status(400).json({
        error: "htmlSnapshot, signerName and signatureData are required",
      });
    }

    const rev = await appendRevision({
      bookingFormId: row.booking_form_id,
      action: "signed",
      htmlSnapshot,
      signerName,
      signerEmail,
      signatureData,
      clientIp: getClientIp(req),
      userAgent: req.headers["user-agent"] || null,
    });

    // Update the "latest pointer" columns on booking_forms so the CRM's
    // existing UI keeps working. The append-only revisions table is the
    // source of truth; these columns are just a convenience cache.
    await pool.query(
      `UPDATE booking_forms SET
         signed_pdf = $1,
         signature_data = $2,
         signed_at = NOW(),
         status = 'onboarding',
         department = 'admin-onboarding',
         updated_at = NOW()
       WHERE id = $3`,
      [rev.pdfBase64, JSON.stringify(signatureData), row.booking_form_id]
    );

    res.json({ success: true, revisionId: rev.id, status: "signed" });
  } catch (err) {
    console.error("Sign error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── POST /api/sign/:token/change-request — client requests changes ──
app.post("/api/sign/:token/change-request", async (req, res) => {
  try {
    const row = await loadTokenRow(req.params.token);
    if (!row) return res.status(404).json({ error: "Token not found or expired" });
    if (row.signed_at) return res.status(409).json({ error: "Already signed" });

    const { htmlSnapshot, changeNotes, signerName, signerEmail } = req.body || {};
    if (!htmlSnapshot || !changeNotes) {
      return res.status(400).json({
        error: "htmlSnapshot and changeNotes are required",
      });
    }

    const rev = await appendRevision({
      bookingFormId: row.booking_form_id,
      action: "change_requested",
      htmlSnapshot,
      signerName,
      signerEmail,
      changeNotes,
      clientIp: getClientIp(req),
      userAgent: req.headers["user-agent"] || null,
    });

    await pool.query(
      `UPDATE booking_forms SET
         change_request_pdf = $1,
         change_notes = $2,
         status = 'change_requested',
         updated_at = NOW()
       WHERE id = $3`,
      [rev.pdfBase64, changeNotes, row.booking_form_id]
    );

    res.json({ success: true, revisionId: rev.id, status: "change_requested" });
  } catch (err) {
    console.error("Change-request error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── Boot ────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || "3000", 10);
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`Booking Form Esign running on port ${PORT}`);
});

// Graceful shutdown — close puppeteer + pg pool before the process dies
async function shutdown(signal) {
  console.log(`${signal} received, shutting down...`);
  server.close(async () => {
    await closeBrowser();
    await pool.end().catch(() => {});
    process.exit(0);
  });
  // Force exit after 10s if graceful shutdown stalls
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
