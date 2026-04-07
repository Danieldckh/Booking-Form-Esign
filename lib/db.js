// Shared-Postgres connection. All the tables this app reads/writes
// (booking_forms, booking_form_revisions, booking_form_esign_tokens)
// live in the same Postgres the ProAgri CRM uses — this app just
// opens its own pool with the same credentials.

import pg from "pg";
const { Pool } = pg;

export const pool = new Pool({
  host: process.env.DB_HOST || "localhost",
  port: parseInt(process.env.DB_PORT || "5432", 10),
  database: process.env.DB_NAME || "proagri_crm",
  user: process.env.DB_USER || "postgres",
  password: process.env.DB_PASSWORD || "",
  max: 10,
});

pool.on("error", (err) => {
  console.error("Postgres pool error:", err.message);
});

// camelCase helper — matches the CRM's api/utils.js behaviour so
// responses feel the same as the CRM's API.
export function toCamelCase(row) {
  if (!row) return row;
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    const k = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    out[k] = value;
  }
  return out;
}
