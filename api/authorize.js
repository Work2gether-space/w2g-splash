console.log("DEBUG: authorize.js build version 2025-08-12b");

// api/authorize.js  Vercel Serverless Function  Node 18+  axios only

export default async function handler(req, res) {
  const rid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const log = (...a) => console.log(`[authorize][${rid}]`, ...a);
  const err = (...a) => console.error(`[authorize][${rid}]`, ...a);

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Use POST' });
  }

  // dynamic imports keep this working on Vercel Node 18
  const axios = (await import('axios')).default;
  const https = await import('https');

  try {
    // Use env if present, else fall back to your confirmed values
    const {
      OMADA_BASE = 'https://192.168.0.2',
      OMADA_PREFIX = '/fc2b25d44a950a6357313da0afb4c14a',
      OMADA_OPERATOR_USER = 'w2g_operator',
      OMADA_OPERATOR_PASS = 'W2g!2025Net$Auth',
      SESSION_MS = '86400000' // one day in ms
    } = process.env;

    const base = OMADA_BASE.replace(/\/+$/, '');
    const apiPrefix = OMADA_PREFIX.startsWith('/') ? OMADA_PREFIX : `/${OMADA_PREFIX}`;

    const body = (req.body && typeof req.body === 'object') ? req.body : {};

    const clientMac   = body.clientMac || body.client_id || '';
    const apMac       = body.apMac || '';
    const ssidName    = body.ssidName || body.ssid || '';
    const radioIdRaw  = body.radioId || body.radio || '1';
    const site        = body.site || '';
    const redirectUrl = body.redirectUrl || 'http://neverssl.com';

    log('REQUEST BODY (presence only):', {
      clientMac: !!clientMac, apMac: !!apMac, ssidName: !!ssidName, radioId: radioIdRaw, site: !!site
    });

    if (!clientMac || !site) {
      err('Missing required fields clientMac or site');
      return res.status(400).json({ ok: false, error: 'Missing clientMac or site from splash redirect' });
    }

    // axios client that accepts self signed cert during LAN testing
    const http = axios.create({
      timeout: 15000,
      httpsAgent: new https.Agent({ rejectUnauthorized: false })
    });

    const postJson = async (url, json, headers = {}) => {
      const resp = await http.post(url, json, {
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', ...headers },
        validateStatus: () => true
      });
      const cookies = resp.headers?.['set-cookie'] || [];
      return { data: resp.data, status: resp.status, cookies };
    };

    // Login at the confirmed API path
    const loginUrl = `${base}${apiPrefix}/api/v2/hotspot/login`;
    log('LOGIN ->', loginUrl);

    // Some controllers expect username or name field. We send both.
    const loginPayload = { username: OMADA_OPERATOR_USER, name: OMADA_OPERATOR_USER, password: OMADA_OPERATOR_PASS };
    const { data: loginData, status: loginStatus, cookies } = await postJson(loginUrl, loginPayload);

    if (loginStatus !== 200 || !(loginData?.errorCode === 0)) {
      err('LOGIN failed', loginStatus, JSON.stringify(loginData));
      return res.status(502).json({ ok: false, stage: 'login', detail: loginData });
    }

    const csrf =
      loginData?.result?.token ||
      loginData?.result?.['Csrf-Token'] ||
      loginData?.['Csrf-Token'] ||
      null;

    if (!csrf) {
      err('LOGIN missing Csrf-Token in response');
      return res.status(502).json({ ok: false, stage: 'login', error: 'Missing Csrf-Token' });
    }

    const cookieHeader = cookies.length ? { Cookie: cookies.join('; ') } : {};
    log('LOGIN ok. Cookies:', cookies.length, 'CSRF present:', Boolean(csrf));

    // Authorize
    const timeMs = Number(SESSION_MS) || 86400000;
    const payload = {
      clientMac,
      apMac,
      ssidName,
      radioId: Number(radioIdRaw) || 1,
      site,
      time: timeMs,
      authType: 4
    };

    const authUrl = `${base}${apiPrefix}/api/v2/hotspot/extPortal/auth`;
    log('AUTH POST ->', authUrl, 'payload:', {
      clientMac, apMac, ssidName, radioId: payload.radioId, site, time: String(timeMs)
    });

    const { data: authData, status: authStatus } = await postJson(
      authUrl,
      payload,
      { 'Csrf-Token': csrf, ...cookieHeader }
    );

    if (authStatus === 200 && authData?.errorCode === 0) {
      log('AUTH success. Redirect ->', redirectUrl);
      // Keep the same success shape you were using
      return res.status(200).json({ ok: true, redirectUrl });
    }

    err('AUTH failed', authStatus, JSON.stringify(authData));
    return res.status(502).json({ ok: false, error: 'Authorization failed', detail: authData });

  } catch (e) {
    err('UNCAUGHT', e?.message || e);
    return res.status(500).json({ ok: false, error: e?.message || 'Internal error' });
  }
}
