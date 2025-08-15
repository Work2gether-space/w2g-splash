// api/authorize.js  Vercel Node runtime, ESM style
// Build: 2025-08-15e redis-verified

console.log("DEBUG: authorize.js build version 2025-08-15e");

export default async function handler(req, res) {
  const rid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const log = (...a) => console.log(`[authorize][${rid}]`, ...a);
  const err = (...a) => console.error(`[authorize][${rid}]`, ...a);

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Use POST' });
  }

  // dynamic imports to stay ESM friendly on Vercel
  const axios = (await import('axios')).default;
  const https = await import('https');

  // read env
  const {
    // Omada
    OMADA_BASE,
    OMADA_CONTROLLER_ID,
    OMADA_OPERATOR_USER,
    OMADA_OPERATOR_PASS,

    // Nexudus
    NEXUDUS_BASE,
    NEXUDUS_USER,
    NEXUDUS_PASS,

    // App timezone
    APP_TZ = 'America/New_York'
  } = process.env;

  if (!OMADA_BASE || !OMADA_CONTROLLER_ID || !OMADA_OPERATOR_USER || !OMADA_OPERATOR_PASS) {
    err('Missing env vars. Need OMADA_BASE, OMADA_CONTROLLER_ID, OMADA_OPERATOR_USER, OMADA_OPERATOR_PASS.');
    return res.status(500).json({ ok: false, error: 'Missing Omada env vars' });
  }
  if (!NEXUDUS_BASE || !NEXUDUS_USER || !NEXUDUS_PASS) {
    err('Missing env vars. Need NEXUDUS_BASE, NEXUDUS_USER, NEXUDUS_PASS.');
    return res.status(500).json({ ok: false, error: 'Missing Nexudus env vars' });
  }

  const base = OMADA_BASE.replace(/\/+$/, '');
  const LOGIN_URL = `${base}/${OMADA_CONTROLLER_ID}/api/v2/hotspot/login`;
  const AUTH_URL  = `${base}/${OMADA_CONTROLLER_ID}/api/v2/hotspot/extPortal/auth`;
  const NEX_AUTH  = "Basic " + Buffer.from(`${NEXUDUS_USER}:${NEXUDUS_PASS}`).toString("base64");

  // read body
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const clientMac   = body.clientMac || body.client_id || '';
  const apMac       = body.apMac || '';
  const ssidName    = body.ssidName || body.ssid || '';
  const radioIdRaw  = body.radioId || body.radio || '';
  const site        = body.site || '';
  const redirectUrl = body.redirectUrl || 'http://neverssl.com';
  const email       = body.email || '';
  const extend      = !!body.extend;

  log('REQUEST BODY (redacted):', {
    clientMac: clientMac ? '(present)' : '',
    apMac:     apMac ? '(present)' : '',
    ssidName:  ssidName || '',
    radioId:   radioIdRaw || '',
    site:      site || '',
    email:     email ? '(present)' : '',
    extend,
    redirectUrl
  });

  // Redis ping first thing so we can see it in logs for any path
  try {
    const { getRedis } = await import('../lib/redis.js');
    log('Redis ping start');
    const redis = await getRedis();
    const key = `w2g:auth-ping:${clientMac || 'unknown'}`;
    await redis.set(key, JSON.stringify({ when: new Date().toISOString(), site: site || '(none)' }), { EX: 300 });
    log(`Redis key set ${key}`);
  } catch (e) {
    console.error(`[authorize][${rid}] Redis ping error`, e?.message || e);
  }

  if (!clientMac || !site) {
    err('Missing required fields: clientMac or site.');
    return res.status(400).json({ ok: false, error: 'Missing clientMac or site from splash redirect.' });
  }

  if (!email) {
    err('Missing email for Nexudus lookup.');
    return res.status(400).json({ ok: false, error: 'Email is required on the splash form.' });
  }

  // axios that accepts self signed cert for Omada
  const http = axios.create({
    timeout: 15000,
    httpsAgent: new (https.Agent)({ rejectUnauthorized: false })
  });

  // plain axios for Nexudus
  const nx = axios.create({
    baseURL: NEXUDUS_BASE.replace(/\/+$/, ''),
    timeout: 15000,
    headers: { Accept: 'application/json', Authorization: NEX_AUTH }
  });

  /* ---------- Nexudus helpers ---------- */

  async function nxGetCoworkerByEmail(email) {
    const url = `/api/spaces/coworkers?Coworker_email=${encodeURIComponent(email)}&_take=1`;
    const r = await nx.get(url, { validateStatus: () => true });
    if (r.status !== 200) throw new Error(`Nexudus coworkers HTTP ${r.status}`);
    return r.data?.Records?.[0] || null;
  }

  async function nxGetActiveContracts(coworkerId) {
    const url = `/api/billing/coworkercontracts?coworkercontract_coworker=${encodeURIComponent(coworkerId)}&coworkercontract_active=true`;
    const r = await nx.get(url, { validateStatus: () => true });
    if (r.status !== 200) throw new Error(`Nexudus contracts HTTP ${r.status}`);
    return Array.isArray(r.data?.Records) ? r.data.Records : [];
  }

  async function nxGetMoneyBalance(coworkerId) {
    const url = `/api/billing/moneytransactions?moneytransaction_coworker=${encodeURIComponent(coworkerId)}&_take=500`;
    const r = await nx.get(url, { validateStatus: () => true });
    if (r.status !== 200) throw new Error(`Nexudus moneytransactions HTTP ${r.status}`);
    const txns = Array.isArray(r.data?.Records) ? r.data.Records : [];
    return txns.reduce((sum, t) => sum + (Number(t.MoneyTransaction_Amount) || 0), 0);
  }

  async function nxCreateMoneyHold(coworkerId, amount, note) {
    const payload = {
      MoneyTransaction_Coworker: coworkerId,
      MoneyTransaction_Amount: -Math.abs(Number(amount)),
      MoneyTransaction_Notes: note || 'WiFi session hold',
      MoneyTransaction_Source: 1
    };
    const r = await nx.post(`/api/billing/moneytransactions`, payload, { validateStatus: () => true });
    if (r.status !== 200) throw new Error(`Hold create failed HTTP ${r.status}`);
    return r.data;
  }

  async function nxRefundMoneyHold(hold) {
    const coworkerId = hold.MoneyTransaction_Coworker || hold.Coworker_Id;
    const amt = Math.abs(Number(hold.MoneyTransaction_Amount ?? hold.Amount ?? 0));
    if (!coworkerId || !amt) throw new Error('Refund missing coworker or amount');
    const payload = {
      MoneyTransaction_Coworker: coworkerId,
      MoneyTransaction_Amount: amt,
      MoneyTransaction_Notes: `Refund of hold ${hold.Id || ''}`,
      MoneyTransaction_Source: 1
    };
    const r = await nx.post(`/api/billing/moneytransactions`, payload, { validateStatus: () => true });
    if (r.status !== 200) throw new Error(`Refund failed HTTP ${r.status}`);
    return r.data;
  }

  /* ---------- Time policy for Basic ---------- */
  function computeBasicPolicy(nowUtc) {
    if (!process.env.APP_TZ) {
      console.warn(`[authorize][${rid}] APP_TZ is not set. Defaulting to America/New_York.`);
    }
    const now = new Date(nowUtc);
    const dow = now.getDay();
    if (dow === 0 || dow === 6) return { allowed: false, reason: 'Not available on weekends' };

    const open = setLocalTime(new Date(now), 8, 50, 0);
    const endStd = setLocalTime(new Date(now), 16, 10, 0);
    const endHard = setLocalTime(new Date(now), 17, 15, 0);

    if (now < open) return { allowed: false, reason: 'Access starts at 8:50' };
    if (now >= endHard) return { allowed: false, reason: 'Closed for the day' };

    let phase = 'standard';
    let cutoff = endStd;
    if (now >= endStd && now < endHard) {
      phase = 'late';
      cutoff = endHard;
    }

    const msRemaining = Math.max(60 * 1000, cutoff.getTime() - now.getTime());
    return { allowed: true, phase, msRemaining, cutoffISO: cutoff.toISOString() };
  }

  function setLocalTime(d, hh, mm, ss) {
    d.setHours(hh, mm, ss, 0);
    return d;
  }

  /* ---------- Omada helpers ---------- */

  const postJson = async (url, json, headers = {}) => {
    const resp = await http.post(url, json, {
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', ...headers },
      validateStatus: () => true
    });
    const cookies = resp.headers?.['set-cookie'] || [];
    return { data: resp.data, status: resp.status, cookies, headers: resp.headers };
  };

  /* ---------- Flow ---------- */

  // 0) Nexudus precheck
  let coworker, holds = [];
  try {
    coworker = await nxGetCoworkerByEmail(email);
    if (!coworker) {
      log('Nexudus coworker not found for email', email);
      return res.status(403).json({ ok: false, error: 'Account not found in Nexudus' });
    }
    log(`Nexudus coworker id=${coworker.Id} name=${coworker.FullName}`);

    const contracts = await nxGetActiveContracts(coworker.Id);
    const hasBasic = contracts.some(c => String(c.TariffName || '').trim().toLowerCase() === 'basic');
    log(`Active contracts=${contracts.length} hasBasic=${hasBasic}`);

    if (!hasBasic) {
      return res.status(403).json({ ok: false, error: 'Basic plan required for this SSID' });
    }
  } catch (e) {
    err('Nexudus precheck error:', e?.message || e);
    return res.status(502).json({ ok: false, error: 'Nexudus precheck failed' });
  }

  // 1) Compute Basic policy window
  const policy = computeBasicPolicy(new Date());
  if (!policy.allowed) return res.status(403).json({ ok: false, error: policy.reason });

  // 2) Determine holds
  let requiredHold = 5;
  let useExtend = extend;
  if (policy.phase === 'standard' && extend) requiredHold = 10;
  if (policy.phase === 'late') {
    if (!extend) return res.status(402).json({ ok: false, error: 'Extra hour required. Select Extend to continue.' });
    requiredHold = 5;
    useExtend = true;
  }

  // 3) Check balance and create holds
  try {
    const balance = await nxGetMoneyBalance(coworker.Id);
    log(`Money balance=${balance} requiredHold=${requiredHold}`);
    if (balance < requiredHold) {
      return res.status(402).json({ ok: false, error: 'Not enough credits for WiFi session' });
    }
    const baseHold = await nxCreateMoneyHold(coworker.Id, 5, 'WiFi session hold');
    holds.push(baseHold);
    if (useExtend) {
      const extHold = await nxCreateMoneyHold(coworker.Id, 5, 'WiFi extra hour hold');
      holds.push(extHold);
    }
  } catch (e) {
    err('Money hold error:', e?.message || e);
    return res.status(502).json({ ok: false, error: 'Unable to place credit hold' });
  }

  // 4) Omada hotspot login
  log('LOGIN try:', LOGIN_URL);
  const loginPayload = { name: OMADA_OPERATOR_USER, password: OMADA_OPERATOR_PASS };

  const { data: loginData, status: loginStatus, cookies: loginCookies, headers: loginHeaders } =
    await postJson(LOGIN_URL, loginPayload);

  if (loginStatus !== 200 || loginData?.errorCode !== 0) {
    err('LOGIN failed', loginStatus, 'detail:', JSON.stringify(loginData || {}));
    await refundAll(holds, nxRefundMoneyHold, err);
    return res.status(502).json({ ok: false, error: 'Hotspot login failed', detail: loginData });
  }

  const csrf =
    loginHeaders?.['csrf-token'] ||
    loginHeaders?.['Csrf-Token'] ||
    loginData?.result?.token || null;

  if (!csrf) {
    err('LOGIN ok but missing CSRF token');
    await refundAll(holds, nxRefundMoneyHold, err);
    return res.status(502).json({ ok: false, error: 'Login returned no CSRF token' });
  }

  // 5) Omada authorize until policy cutoff
  const payload = {
    clientMac,
    apMac,
    ssidName,
    radioId: radioIdRaw ? Number(radioIdRaw) : 1,
    site,
    time: String(Math.max(60000, policy.msRemaining)),
    authType: 4
  };

  const cookieHeader = loginCookies.length ? { Cookie: loginCookies.join('; ') } : {};
  log('AUTHORIZE POST ->', AUTH_URL, 'payload:', { ...payload, clientMac: '(present)', apMac: '(present)' });

  const { data: authData, status: authStatus } =
    await postJson(AUTH_URL, payload, { 'Csrf-Token': csrf, ...cookieHeader });

  if (authStatus === 200 && authData?.errorCode === 0) {
    log('AUTH success -> redirect', redirectUrl, 'cutoff:', policy.cutoffISO, 'extended:', useExtend);
    return res.status(200).json({ ok: true, redirectUrl, cutoff: policy.cutoffISO, extended: useExtend });
  }

  err('AUTH failed status', authStatus, 'detail:', JSON.stringify(authData || {}));
  await refundAll(holds, nxRefundMoneyHold, err);
  return res.status(502).json({ ok: false, error: 'Authorization failed', detail: authData });
}

/* ---------- utils ---------- */

async function refundAll(holds, refundFn, logErr) {
  for (const h of holds) {
    try { await refundFn(h); } catch (e) { logErr('Refund error', e?.message || e); }
  }
}
