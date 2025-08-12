console.log("DEBUG: authorize.js build version 2025-08-11a");

// api/authorize.js  (Vercel, Node 18+; axios only, manual cookie forwarding)

export default async function handler(req, res) {
  const rid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const log = (...a) => console.log(`[authorize][${rid}]`, ...a);
  const err = (...a) => console.error(`[authorize][${rid}]`, ...a);

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Use POST' });
  }

  // --- dynamic imports so we stay ESM-friendly on Vercel Node 18 ---
  const axios = (await import('axios')).default;
  const https = await import('https');

  try {
    const {
      OMADA_BASE,            // e.g. https://98.114.198.237:9444  (public IP + exposed management port)
      OMADA_OPERATOR_USER,   // hotspot operator username
      OMADA_OPERATOR_PASS,   // hotspot operator password
      SESSION_MINUTES = '240'
    } = process.env;

    if (!OMADA_BASE || !OMADA_OPERATOR_USER || !OMADA_OPERATOR_PASS) {
      err('Missing env vars. Need OMADA_BASE, OMADA_OPERATOR_USER, OMADA_OPERATOR_PASS.');
      return res.status(500).json({ ok: false, error: 'Missing env vars.' });
    }

    const base = OMADA_BASE.replace(/\/+$/, '');
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
      return res.status(400).json({
        ok: false,
        error: 'Missing clientMac or site from splash redirect.'
      });
    }

    // Create axios client that accepts self-signed cert (also keep NODE_TLS_REJECT_UNAUTHORIZED=0 in env).
    const http = axios.create({
      timeout: 15000,
      httpsAgent: new https.Agent({ rejectUnauthorized: false })
    });

    // Helper that posts JSON and returns { data, cookies[] }.
    const postJson = async (url, json, headers = {}) => {
      const resp = await http.post(url, json, {
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', ...headers },
        validateStatus: () => true // we handle status ourselves
      });
      const cookies = resp.headers?.['set-cookie'] || [];
      return { data: resp.data, status: resp.status, cookies };
    };

    // Try login on likely path prefixes.
    const prefixes = ['', '/omada', '/omadac'];
    let csrf = null;
    let apiPrefix = null;
    let cookieJar = [];
    const loginPayload = { name: OMADA_OPERATOR_USER, password: OMADA_OPERATOR_PASS };

    for (const p of prefixes) {
      const loginUrl = `${base}${p}/api/v2/hotspot/login`;
      log('LOGIN try:', loginUrl);

      try {
        const { data, status, cookies } = await postJson(loginUrl, loginPayload);
        if (status !== 200) {
          err('LOGIN HTTP status', status, 'on', loginUrl, 'resp:', JSON.stringify(data));
          continue;
        }
        if (data?.errorCode === 0 && data?.result?.token) {
          csrf = data.result.token;
          apiPrefix = p;
          cookieJar = cookies; // store Set-Cookie array
          log('LOGIN success on', loginUrl, 'cookies:', cookieJar.length);
          break;
        } else {
          err('LOGIN failed on', loginUrl, 'detail:', JSON.stringify(data));
        }
      } catch (e) {
        err('LOGIN exception on', loginUrl, e?.message || e);
      }
    }

    if (!csrf || apiPrefix === null) {
      err('LOGIN failed on all bases. Tried paths:', prefixes.join(', '));
      return res.status(502).json({ ok: false, error: 'Login failed on all bases.' });
    }

    // Build Cookie header for next request.
    const cookieHeader = cookieJar.length ? { Cookie: cookieJar.join('; ') } : {};

    // Authorize
    const timeMicros = String(BigInt(SESSION_MINUTES) * 60n * 1000000n);
    const payload = {
      clientMac,
      apMac,
      ssidName,
      radioId: radioIdRaw ? Number(radioIdRaw) : 1,
      site,
      time: timeMicros,
      authType: 4
    };

    const authUrl = `${base}${apiPrefix}/api/v2/hotspot/extPortal/auth`;
    log('AUTHORIZE POST ->', authUrl, 'payload:', {
      clientMac, apMac, ssidName, radioId: payload.radioId, site, time: String(timeMicros)
    });

    const { data: authData, status: authStatus } = await postJson(
      authUrl,
      payload,
      { 'Csrf-Token': csrf, ...cookieHeader }
    );

    if (authStatus === 200 && authData?.errorCode === 0) {
      log('AUTH success -> redirect', redirectUrl);
      return res.status(200).json({ ok: true, redirectUrl });
    }

    err('AUTH failed status', authStatus, 'detail:', JSON.stringify(authData));
    return res.status(502).json({ ok: false, error: 'Authorization failed', detail: authData });

  } catch (e) {
    err('UNCAUGHT', e?.message || e);
    return res.status(500).json({ ok: false, error: e?.message || 'Internal error' });
  }
}
