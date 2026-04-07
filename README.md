# Booking Form Esign

Client-facing signing + change-request app for ProAgri booking forms.
Replaces the older `Editable-booking-form` + `esign-booking-form` repos
by merging them into a single flow: the esign page **is** the editable
experience. There is no separate "edit first, sign later" step.

## What it does

1. An admin creates a signing session for a booking form via
   `POST /api/admin/create-token`. The server stores the pre-rendered
   booking form HTML in `booking_form_esign_tokens` and returns a URL
   like `/sign/<token>`.
2. The client opens the URL. They see the full booking form. Only the
   header address block and the legal strip at the bottom are
   editable — the services, pricing, and deliverables are locked.
3. The client either:
   - **Signs** (draws a canvas signature, enters their name) → the
     server snapshots the HTML, renders it to PDF via puppeteer-core,
     and **appends** a row to `booking_form_revisions`. The booking
     form status advances to `onboarding` in the CRM.
   - **Requests changes** (free-text notes) → same append flow, but
     action is `change_requested` and the CRM status becomes
     `change_requested`.

**The revisions table is append-only.** Rows are never updated or
deleted — this is the legal audit trail.

## Architecture

- Node 20 + Express (`type: module`)
- Shares the ProAgri CRM Postgres directly (same host/db/creds)
- `puppeteer-core` + system `chromium` (via Dockerfile) for HTML→PDF
- No client-side framework, plain DOM + a signature canvas

```
server.js               # Express routes
lib/
  db.js                 # pg Pool + toCamelCase helper
  template.js           # Builds the final HTML (base + content, locked)
  pdf.js                # Puppeteer wrapper, HTML → base64 PDF
  base.html.template    # Ported from the old Editable repo
  format-deliverables.js # Ported from the old repos (not currently wired;
                        #  left in place for future "render from form_data")
public/
  sign.css              # Action bar + modals + done screen
  sign.js               # Signature canvas + submit handlers
  ProAgriMedia-CheckList.png
```

## Environment variables

| Var | Purpose | Example |
|-----|---------|---------|
| `PORT` | HTTP port | `3000` |
| `DB_HOST` | Shared CRM Postgres host | `postgres.proagrihub.com` |
| `DB_PORT` | Postgres port | `5432` |
| `DB_NAME` | CRM database name | `proagri_crm` |
| `DB_USER` | Postgres user | `postgres` |
| `DB_PASSWORD` | Postgres password | _secret_ |
| `ADMIN_SECRET` | Shared secret for `POST /api/admin/create-token` | random 64-char hex |
| `PUBLIC_BASE_URL` | External URL the sign links resolve to | `https://bookingformesign.proagrihub.com` |
| `PUPPETEER_EXECUTABLE_PATH` | Path to chromium binary | `/usr/bin/chromium` (set by Dockerfile) |

## API

### `POST /api/admin/create-token`

Admin-only. Create a new signing session for a booking form.

```json
{
  "bookingFormId": 123,
  "html": "<div class=\"booking-form\">...</div>",
  "expiresInDays": 14
}
```

Response:

```json
{
  "success": true,
  "token": "abcd1234...",
  "url": "https://bookingformesign.proagrihub.com/sign/abcd1234..."
}
```

### `GET /sign/:token`

Public. Serves the signing page HTML. Returns a "link expired" page if
the token is missing/expired, or an "already signed" page if the
booking form has already been signed.

### `GET /api/sign/:token`

Public. Returns JSON metadata for the token (for the frontend to
decide what to render).

### `POST /api/sign/:token/sign`

Public. Client signs the booking form.

```json
{
  "htmlSnapshot": "<!doctype html>...",
  "signerName": "Jane Smith",
  "signerEmail": "jane@company.com",
  "signatureData": {
    "image": "data:image/png;base64,...",
    "strokes": [[{"x":10,"y":20}, ...]],
    "signedAt": "2026-04-07T12:34:56.789Z"
  }
}
```

Inserts a revision row with `action = 'signed'`, renders a PDF, and
advances `booking_forms.status = 'onboarding'`.

### `POST /api/sign/:token/change-request`

Public. Client requests changes.

```json
{
  "htmlSnapshot": "<!doctype html>...",
  "changeNotes": "Please move the start date to 1 June.",
  "signerName": "Jane Smith"
}
```

Inserts a revision row with `action = 'change_requested'` and sets
`booking_forms.status = 'change_requested'`.

## Database schema

The app shares the CRM's Postgres. Relevant tables live in the CRM repo
and are created there via `api/db.js` + `api/migrations/013_*`:

- `booking_forms` — existing table, extended earlier with
  `signed_pdf`, `signature_data`, `change_request_pdf`, `change_notes`,
  `esign_url` columns. These are **latest-state pointers** for the
  CRM's convenience queries.
- `booking_form_revisions` — **append-only** audit trail. One row per
  sign/change-request event. Columns: `booking_form_id`, `action`,
  `html_snapshot`, `pdf_base64`, `signer_name`, `signer_email`,
  `signature_data`, `change_notes`, `client_ip`, `user_agent`,
  `created_at`.
- `booking_form_esign_tokens` — one row per signing session.
  Columns: `booking_form_id`, `token`, `html_snapshot`, `created_at`,
  `expires_at`, `last_accessed_at`.

## Running locally

```bash
npm install
DB_HOST=localhost DB_PASSWORD=... node server.js
```

Puppeteer will fail to launch unless chromium is installed at
`/usr/bin/chromium` (or wherever `PUPPETEER_EXECUTABLE_PATH` points).
The rest of the app works fine without it — PDF rendering just
returns `null` and snapshots are persisted as HTML only.

## Deploying

Built as a Docker image via the `Dockerfile`. Deployed on Coolify at
`bookingformesign.proagrihub.com`. On deploy the CRM's `db.js`
migrations run first (managed by the CRM container) to ensure the
shared schema exists.
