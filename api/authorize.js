// api/authorize.js  Vercel Node runtime, ESM style like your current build

console.log("DEBUG: authorize.js build version 2025-08-12b");

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
    OMADA_BASE,              // for you: https://98.114.198.237:9443  the port that shows the Omada login page
    OMADA_CONTROLLER_ID,     // fc2b25d44a950a6357313da0afb4c14a
    OMADA_OPERATOR_USER,     // w2g_operator
    OMADA_OPERATOR_PASS,     // W2g!2025Net$Auth
    SESSION_MINUTES = '1440' // default 24 hours
  } = process.env;

  if (!OMADA_BASE || !OMADA_CONTROLLER_ID || !OMADA_OPERATOR_USER || !OMADA_OPERATOR_PASS) {
    err('Missing env vars. Need OMADA_BASE, OMADA_CONTROLLER_ID, OMADA_OPERATOR_USER, OMADA_OPERATOR_PASS.');
    return res.status(500).json({ ok: false, error: 'Missing env vars' });
  }

  const base = OMADA_BASE.replace(/\/+$/, '');
  const LOGIN_URL = `${base}/${OMADA_CONTROLLER_ID}/api/v2/hotspot/login`;
  const AUTH_URL  = `${base}/${OMADA_CONTROLLER_ID}/api/v2/hotspot/extPortal/auth`;

  // read body
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const clientMac   = body.clientMac || body.client_id || '';
  const apMac       = body.apMac || '';
  const ssidName    = body.ssidName || body.ssid || '';
  const radioIdRaw  = body.radioId || body.radio || '';
  const site        = body.site || '';
  const redirectUrl = body.redirectUrl || 'http://neverssl.com';

  log('REQUEST BODY (redacted):', {
    clientMac: clientMac ? '(present)' : '',
    apMac:     apMac ? '(present)' : '',
    ssidName:  ssidName || '',
    radioId:   radioIdRaw || '',
    site:      site || '',
    redirectUrl
  });

  if (!clientMac || !site) {
    err('Missing required fields: clientMac or site.');
    return res.status(400).json({ ok: false, error: 'Missing clientMac or site from splash redirect.' });
  }

  // axios client that accepts self signed cert
  const http = axios.create({
    timeout: 15000,
    httpsAgent: new https.Agent({ rejectUnauthorized: false })
  });

  // helper that posts JSON and returns { data, status, cookies[] }
  const postJson = async (url, json, headers = {}) => {
    const resp = await http.post(url, json, {
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', ...headers },
      validateStatus: () => true
    });
    const cookies = resp.headers?.['set-cookie'] || [];
    return { data: resp.data, status: resp.status, cookies, headers: resp.headers };
  };

  // 1) login
  log('LOGIN try:', LOGIN_URL);
  const loginPayload = { username: OMADA_OPERATOR_USER, password: OMADA_OPERATOR_PASS };

  const { data: loginData, status: loginStatus, cookies: loginCookies, headers: loginHeaders } =
    await postJson(LOGIN_URL, loginPayload);

  if (loginStatus !== 200 || loginData?.errorCode !== 0) {
    err('LOGIN failed', loginStatus, 'detail:', JSON.stringify(loginData || {}));
    return res.status(502).json({ ok: false, error: 'Hotspot login failed', detail: loginData });
  }

  // CSRF can be in header or body
  const csrf =
    loginHeaders?.['csrf-token'] ||
    loginHeaders?.['Csrf-Token'] ||
    loginData?.result?.token || null;

  if (!csrf) {
    err('LOGIN ok but missing CSRF token');
    return res.status(502).json({ ok: false, error: 'Login returned no CSRF token' });
  }

  // 2) authorize
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

  // build Cookie header from login response
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
