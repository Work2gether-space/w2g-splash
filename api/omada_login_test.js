// api/omada_login_test.js
// Safe test endpoint that exercises the shared Omada hotspot client
// without changing /api/authorize behavior yet.

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
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({});
      }
    });
  });
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return json(res, 405, { ok: false, error: "Method not allowed. Use POST." });
  }

  const body = await readBody(req);

  // Allow override via body; default to known-good test params
  const site = body.site || "688c13adee75005c5bb411bd";
  const clientMac = body.clientMac || "C8-5E-A9-EE-D9-46";
  const apMac = body.apMac || "30-68-93-E9-96-AE";
  const ssidName = body.ssidName || "W2G_Basic";
  const radioId = body.radioId ?? 0;

  try {
    const result = await hotspotLogin({ site, clientMac, apMac, ssidName, radioId });

    return json(res, 200, {
      ok: true,
      test: "omada_login_test",
      input: { site, clientMac, apMac, ssidName, radioId },
      result,
    });
  } catch (err) {
    return json(res, 200, {
      ok: false,
      test: "omada_login_test",
      error: err?.message || String(err),
    });
  }
};
