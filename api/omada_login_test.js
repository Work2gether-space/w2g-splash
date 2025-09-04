// api/omada_login_test.js
// Build: 2025-09-04-3.5e-cloudflared
// Purpose: Verify External Portal flow end-to-end using the shared client.
// Flow: operator login -> CSRF token -> extPortal/auth (variants) -> loginStatus
// Change: Defaults to tunnel host if OMADA_BASE is unset (handled here for visibility and echoed in response).

import { hotspotLogin } from "../lib/omada_hotspot_client.js";

function json(res, code, payload) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({});
      }
    });
  });
}

function pick(obj, ...keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

export default async (req, res) => {
  if (req.method !== "POST") {
    return json(res, 405, { ok: false, error: "Method not allowed. Use POST." });
  }

  const body = await readBody(req);

  // Accept common fallbacks and keep radioId as string
  const site = pick(body, "site", "siteId") || "688c13adee75005c5bb411bd";
  const clientMac = pick(body, "clientMac") || "C8-5E-A9-EE-D9-46";
  const apMac = pick(body, "apMac") || "30-68-93-E9-96-AE";
  const ssidName = pick(body, "ssidName", "ssid") || "W2G_Basic";
  const radioId = pick(body, "radioId", "radio") || "1"; // keep as string

  // Echo which base we intend to use (client also reads env, defaulting to tunnel host)
  const omadaBase = String(process.env.OMADA_BASE || "https://omada-direct.work2gether.space").replace(/\/+$/, "");

  try {
    const result = await hotspotLogin({ site, clientMac, apMac, ssidName, radioId });

    // Success is when a variant was chosen and controller returned errorCode === 0
    const chosen = result?.chosen || null;
    const ok =
      Boolean(chosen) &&
      (Number(chosen?.data?.errorCode) === 0 || Number(chosen?.data?.errCode) === 0 || chosen?.http === 302);

    return json(res, 200, {
      ok,
      mode: "external-portal-auth",
      input: { site, clientMac, apMac, ssidName, radioId },
      omadaBase,
      // Concise probe outputs
      chosen,
      attempts: result?.authAttempts || [],
      operatorLogin: result?.operatorLogin || null,
      status: result?.status || null,
    });
  } catch (err) {
    return json(res, 200, {
      ok: false,
      mode: "external-portal-auth",
      omadaBase,
      error: err?.message || String(err),
    });
  }
};
