// api/authorize.js  Vercel Node runtime, ESM style like your current build

console.log("DEBUG: authorize.js build version 2025-08-15a");

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

  const {
    // Omada
    OMADA_BASE,              // for you: https://98.114.198.237:9443
    OMADA_CONTROLLER_ID,     // fc2b25d44a950a6357313da0afb4c14a
    OMADA_OPERATOR_USER,     // w2g_operator
    OMADA_OPERATOR_PASS,     // W2g!2025Net$Auth
    SESSION_MINUTES = '1440',

    // Nexudus
    NEXUDUS_BASE,            // https://w2gdtown.spaces.nexudus.com
    NEXUDUS_USER,            // nick@work2gether.space
    NEXUDUS_PASS             // 2Travelis2Live
  } = process.env;

  if (!OMADA_BASE || !OMADA_CONTROLLER_ID || !OMADA_OPERATOR_USER || !OMADA_OPERATOR_PASS) {
    err('Missing env vars. Need OMADA_BASE, OMADA_CONTROLLER_ID, OMADA_OPERATOR_USER, OMADA_OPERATOR_PASS.');
    return res.status(500).json({ ok: false, error: 'Missing env vars' });
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

  log('REQUEST BODY (redacted):', {
    clientMac: clientMac ? '(present)' : '',
    apMac:     apMac ? '(present)' : '',
    ssidName:  ssidName || '',
    radioId:   radioIdRaw || '',
    site:      site || '',
    email:     email ? '(present)' : '',
    redirectUrl
  });

  if (!clientMac || !site) {
    err('Missing required fields: clientMac or site.');
    return res.status(400).json({ ok: false, error: 'Missing clientMac or site from splash redirect.' });
  }

  if (!email) {
    err('Missing email for Nexudus lookup.');
    return res.status(400).json({ ok: false, error: 'Email is required on the splash form.' });
  }

  // axios client that accepts self signed cert for Omada
  const http = axios.create({
    timeout: 15000,
    httpsAgent: new https.Agent({ rejectUnauthorized: false })
  });

  // plain axios for Nexudus (valid certs)
  const nx = axios.create({
    baseURL: NEXUDUS_BASE,
    timeout: 15000,
    headers: { Accept: 'application/json', Authorization: NEX_AUTH }
  });

  // helpers
  const postJson = async (url, json, headers = {}) => {
    const resp = await http.post(url, json, {
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', ...headers },
      validateStatus: () => true
    });
    const cookies = resp.headers?.['set-cookie'] || [];
    return { data: resp.data, status: resp.status, cookies, headers: resp.headers };
  };

  async function getCoworkerByEmail(email) {
    const url = `/api/spaces/coworkers?Coworker_email=${encodeURIComponent(email)}&_take=1`;
    const r = await nx.get(url, { validateStatus: () => true });
    if (r.status !== 200) throw new Error(`Nexudus coworkers HTTP ${r.status}`);
    const rec = r.data?.Records?.[0] || null;
    return rec;
  }

  async function getActiveContracts(coworkerId) {
    const url = `/api/billing/coworkercontracts?coworkercontract_coworker=${encodeURIComponent(coworkerId)}&coworkercontract_active=true`;
    const r = await nx.get(url, { validateStatus: () => true });
    if (r.status !== 200) throw new Error(`Nexudus contracts HTTP ${r.status}`);
    return Array.isArray(r.data?.Records) ? r.data.Records : [];
  }

  function toBoolBasic(tariffName) {
    return String(tariffName || '').trim().toLowerCase() === 'basic';
  }

  // 0) Nexudus precheck: must have active Basic plan
  try {
    const cw = await getCoworkerByEmail(email);
    if (!cw) {
      log('Nexudus coworker not found for email', email);
      return res.status(403).json({ ok: false, error: 'Account not found in Nexudus' });
    }
    log(`Nexudus coworker id=${cw.Id} name=${cw.FullName}`);

    const contracts = await getActiveContracts(cw.Id);
    const hasBasic = contracts.some(c => toBoolBasic(c.TariffName));
    log(`Nexudus active contracts=${contracts.length} hasBasic=${hasBasic}`);

    if (!hasBasic) {
      return res.status(403).json({ ok: false, error: 'Basic plan required for this SSID' });
    }

    // Money Credit check and deduction will be added next
  } catch (e) {
    err('Nexudus precheck error:', e?.message || e);
    return res.status(502).json({ ok: false, error: 'Nexudus precheck failed' });
  }

  // 1) Omada hotspot login
  log('LOGIN try:', LOGIN_URL);
  const loginPayload = { name: OMADA_OPERATOR_USER, password: OMADA_OPERATOR_PASS };

  const { data: loginData, status: loginStatus, cookies: loginCookies, headers: loginHeaders } =
    await postJson(LOGIN_URL, loginPayload);

  if (loginStatus !== 200 || loginData?.errorCode !== 0) {
    err('LOGIN failed', loginStatus, 'detail:', JSON.stringify(loginData || {}));
    return res.status(502).json({ ok: false, error: 'Hotspot login failed', detail: loginData });
  }

  const csrf =
    loginHeaders?.['csrf-token'] ||
    loginHeaders?.['Csrf-Token'] ||
    loginData?.result?.token || null;

  if (!csrf) {
    err('LOGIN ok but missing CSRF token');
    return res.status(502).json({ ok: false, error: 'Login returned no CSRF token' });
  }

  // 2) Omada authorize
  const timeMs = String(parseInt(SESSION_MINUTES, 10) * 60 * 1000);
  const payload = {
    clientMac,
    apMac,
    ssidName,
    radioId: radioIdRaw ? Number(radioIdRaw) : 1,
    site,
    time: timeMs,
    authType: 4
  };

  const cookieHeader = loginCookies.length ? { Cookie: loginCookies.join('; ') } : {};
  log('AUTHORIZE POST ->', AUTH_URL, 'payload:', { ...payload, clientMac: '(present)', apMac: '(present)' });

  const { data: authData, status: authStatus } =
    await postJson(AUTH_URL, payload, { 'Csrf-Token': csrf, ...cookieHeader });

  if (authStatus === 200 && authData?.errorCode === 0) {
    log('AUTH success -> redirect', redirectUrl);
    return res.status(200).json({ ok: true, redirectUrl });
  }

  err('AUTH failed status', authStatus, 'detail:', JSON.stringify(authData || {}));
  return res.status(502).json({ ok: false, error: 'Authorization failed', detail: authData });
}
