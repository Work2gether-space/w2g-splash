// api/omada_login_test.js
// Brute-tests Omada /api/v2/hotspot/login with multiple payload schemas.
// Does the same warmup that your probe does, then tries several bodies.

const OMADA_BASE = process.env.OMADA_BASE || "https://omada.work2gether.space";
const CTRL = process.env.OMADA_CONTROLLER_ID || "fc2b25d44a950a6357313da0afb4c14a";

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

function normMacColon(mac) {
  const hex = String(mac).replace(/[^0-9a-f]/gi, "").toUpperCase();
  if (hex.length !== 12) return mac;
  return hex.match(/.{1,2}/g).join(":");
}

function normMacHyphen(mac) {
  const hex = String(mac).replace(/[^0-9a-f]/gi, "").toUpperCase();
  if (hex.length !== 12) return mac;
  return hex.match(/.{1,2}/g).join("-");
}

async function fRaw(url, opts = {}, jar = []) {
  const headers = new Headers(opts.headers || {});
  if (jar.length) headers.set("Cookie", jar.join("; "));
  headers.set("User-Agent", "w2g-splash/test-2025-08-29");
  headers.set("Connection", "close");
  const resp = await fetch(url, {
    method: opts.method || "GET",
    headers,
    body: opts.body,
    redirect: "manual",
  });
  const setCookie = resp.headers.get("set-cookie");
  const cookies = [];
  if (setCookie) {
    const arr = Array.isArray(setCookie) ? setCookie : [setCookie];
    for (const line of arr) {
      const nv = String(line).split(";")[0].trim();
      if (nv.includes("=")) cookies.push(nv);
    }
  }
  const nextJar = mergeCookies(jar, cookies);
  return { resp, jar: nextJar };
}

function mergeCookies(a, b) {
  const m = new Map();
  for (const c of [...a, ...b]) {
    const [n, ...rest] = c.split("=");
    m.set(n.trim(), `${n.trim()}=${rest.join("=")}`);
  }
  return [...m.values()];
}

async function warmup(jar = []) {
  const results = [];
  let j = jar;

  // 1) /portal (probe does this first)
  let r = await fRaw(`${OMADA_BASE}/${CTRL}/portal`, { method: "GET" }, j);
  results.push({ step: "warm_portal", status: r.resp.status });
  j = r.jar;

  // 2) /hotspot/login page
  r = await fRaw(`${OMADA_BASE}/${CTRL}/hotspot/login`, { method: "GET" }, j);
  results.push({ step: "warm_hotspot_page", status: r.resp.status });
  j = r.jar;

  return { jar: j, results };
}

async function tryLogin(jar, body) {
  const url = `${OMADA_BASE}/${CTRL}/api/v2/hotspot/login?_=${Date.now()}`;
  const headers = {
    "Content-Type": "application/json",
    "X-Requested-With": "XMLHttpRequest",
    Referer: `${OMADA_BASE}/${CTRL}/hotspot/login`,
  };
  const { resp, jar: j2 } = await fRaw(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }, jar);

  const txt = await resp.text().catch(() => "");
  let data;
  try { data = JSON.parse(txt); } catch { data = { errorCode: -1, raw: txt }; }
  return { status: resp.status, data, jar: j2 };
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return json(res, 405, { ok: false, error: "Use POST." });
  }

  const b = await readBody(req);
  const site = b.site || "688c13adee75005c5bb411bd";
  const clientMac = b.clientMac || "C8-5E-A9-EE-D9-46";
  const apMac = b.apMac || "30-68-93-E9-96-AE";
  const ssidName = b.ssidName || "W2G_Basic";
  const radioId = b.radioId ?? 0;

  // warmup
  const w = await warmup([]);
  let jar = w.jar;

  // Build candidate bodies
  const macH = normMacHyphen(clientMac);
  const macC = normMacColon(clientMac);
  const apH = normMacHyphen(apMac);
  const apC = normMacColon(apMac);

  const attempts = [
    { name: "A clientMac-hyphen", body: { site, clientMac: macH, apMac: apH, ssidName, radioId } },
    { name: "B clientMac-colon",  body: { site, clientMac: macC, apMac: apC, ssidName, radioId } },
    { name: "C mac-hyphen",       body: { site, mac: macH, apMac: apH, ssidName, radioId } },
    { name: "D mac-colon",        body: { site, mac: macC, apMac: apC, ssidName, radioId } },
    { name: "E username-colon+a4",body: { site, username: macC, authType: 4, apMac: apC, ssidName, radioId } },
  ];

  const results = [];
  for (const t of attempts) {
    const r = await tryLogin(jar, t.body);
    results.push({
      attempt: t.name,
      postedBody: t.body,
      http: r.status,
      errorCode: r.data?.errorCode,
      msg: r.data?.msg,
      token: r.data?.result?.token || r.data?.token || null,
    });
    jar = r.jar;
  }

  return json(res, 200, {
    ok: results.some(x => x.errorCode === 0),
    mode: "login brute-test",
    warmup: w.results,
    results,
  });
};
