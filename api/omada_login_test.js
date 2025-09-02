// api/omada_login_test.js
// Verifies External Portal flow using the shared client:
// operator login -> CSRF token -> extPortal/auth (with variants) -> loginStatus

const { hotspotLogin } = require("../lib/omada_hotspot_client");

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
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
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

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return json(res, 405, { ok: false, error: "Method not allowed. Use POST." });
  }

  const body = await readBody(req);

  // Accept common fallbacks and keep radioId as string
  const site    = pick(body, "site", "siteId") || "688c13adee75005c5bb411bd";
  const clientMac = pick(body, "clientMac") || "C8-5E-A9-EE-D9-46";
  const apMac     = pick(body, "apMac") || "30-68-93-E9-96-AE";
  const ssidName  = pick(body, "ssidName", "ssid") || "W2G_Basic";
  const radioId   = pick(body, "radioId", "radio") || "1"; // keep as string

  try {
    const result = await hotspotLogin({ site, clientMac, apMac, ssidName, radioId });

    // With the new client, success is when a variant was chosen and errorCode === 0
    const ok = Boolean(result?.chosen && Number(result.chosen?.data?.errorCode) === 0);

    return json(res, 200, {
      ok,
      mode: "external-portal-auth",
      input: { site, clientMac, apMac, ssidName, radioId },
      // Expose concise probe info
      chosen: result?.chosen || null,
      attempts: result?.authAttempts || [],
      operatorLogin: result?.operatorLogin || null,
      status: result?.status || null
    });
  } catch (err) {
    return json(res, 200, {
      ok: false,
      mode: "external-portal-auth",
      error: err?.message || String(err),
    });
  }
};
