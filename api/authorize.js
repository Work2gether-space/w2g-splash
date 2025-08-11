console.log("DEBUG: authorize.js build version 2025-08-11a");

// api/authorize.js  (Vercel, Node 18+)

export default async function handler(req, res) {
  // Simple request-id for correlating logs
  const rid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

  const log = (...args) => console.log(`[authorize][${rid}]`, ...args);
  const err = (...args) => console.error(`[authorize][${rid}]`, ...args);

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Use POST' });
  }

  // --- Load deps (ESM-compatible for Vercel Node 18) ---
  const axios = (await import('axios')).default;
  const https = await import('https');
  const { CookieJar } = await import('tough-cookie');
  const { wrapper } = await import('axios-cookiejar-support');

  try {
    const {
      OMADA_BASE,            // e.g. https://98.114.198.237:9444   (public IP + exposed management port)
      OMADA_OPERATOR_USER,   // hotspot operator username
      OMADA_OPERATOR_PASS,   // hotspot operator password
      SESSION_MINUTES = '240'
    } = process.env;

    // --- Validate env ---
    if (!OMADA_BASE || !OMADA_OPERATOR_USER || !OMADA_OPERATOR_PASS) {
      err('Missing env vars. Need OMADA_BASE, OMADA_OPERATOR_USER, OMADA_OPERATOR_PASS.');
      return res.status(500).json({ ok: false, error: 'Missing env vars.' });
    }

    const base = OMADA_BASE.replace(/\/+$/, ''); // no trailing slash
    const body = (req.body && typeof req.body === 'object') ? req.body : {};

    // These should come from the splash redirect (client page reads URL params and posts them).
    // We also accept alternative names just in case.
    const clientMac = body.clientMac || body.client_id || '';
    const apMac     = body.apMac || '';
    const ssidName  = body.ssidName || body.ssid || '';
    const radioId   = body.radioId || body.radio || '';
    const site      = body.site || '';
    const clientIp  = body.clientIp || req.headers['x-forwarded-for'] || '';
    const redirectUrl = body.redirectUrl || 'http://neverssl.com';

    log('REQUEST BODY (redacted):', {
      clientMac: clientMac ? '(present)' : '',
      apMac:     apMac ? '(present)' : '',
      ssidName:  ssidName || '',
      radioId:   radioId || '',
      site:      site || '',
      clientIp:  clientIp || '',
      redirectUrl
    });

    // --- Validate required fields from splash redirect ---
    // If these are empty, authorization will fail. Better to return a 400 so we know early.
    if (!clientMac || !site) {
      err('Missing required fields from splash: clientMac or site is empty.');
      return res.status(400).json({
        ok: false,
        error: 'Missing clientMac or site from splash redirect.',
        hint: 'Ensure your Omada portal passes clientMac, site, apMac, ssidName, radioId in the redirect URL.'
      });
    }

    // --- HTTP client with cookie jar & self-signed cert allowed ---
    const jar = new CookieJar();
    const agent = new https.Agent({ rejectUnauthorized: false }); // self-signed on OC200
    const http = wrapper(
      axios.create({
        jar,
        withCredentials: true,
        timeout: 15000,
        httpsAgent: agent
      })
    );

    // Try a few likely controller path prefixes:
    // OC200 often serves API at /omada; sometimes it is directly at root.
    const pathCandidates = ['', '/omada', '/omadac'];

    // helper to login at a given path, returning {csrf, usedPath} or throwing error
    const tryLogin = async (prefix) => {
      const loginUrl = `${base}${prefix}/api/v2/hotspot/login`;
      log('LOGIN try:', loginUrl);

      try {
        const resp = await http.post(
          loginUrl,
          { name: OMADA_OPERATOR_USER, password: OMADA_OPERATOR_PASS },
          { headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' } }
        );

        // Omada v5 returns { errorCode: 0, result: { token } } on success
        const data = resp && resp.data ? resp.data : {};
        if (data.errorCode === 0 && data.result && data.result.token) {
          log('LOGIN success on', loginUrl);
          return { csrf: data.result.token, usedPath: prefix };
        }

        err('LOGIN failed on', loginUrl, 'detail:', JSON.stringify(data));
        throw new Error(`login failed: ${JSON.stringify(data)}`);
      } catch (e) {
        // Axios error: capture response body if present
        const detail = e?.response?.data || e.message || String(e);
        err('LOGIN HTTP error on', loginUrl, '-', detail);
        throw e;
      }
    };

    // Attempt login across candidates
    let csrf = null;
    let apiPrefix = null;
    let loginErrs = [];
    for (const p of pathCandidates) {
      try {
        const r = await tryLogin(p);
        csrf = r.csrf;
        apiPrefix = p;
        break;
      } catch (e) {
        loginErrs.push(p);
      }
    }

    if (!csrf || apiPrefix === null) {
      err('LOGIN failed on all bases. Tried paths:', loginErrs.join(', '));
      return res.status(502).json({ ok: false, error: 'Login failed on all bases.' });
    }

    // --- Authorize the client ---
    // Time is in microseconds per Omada API.
    const timeMicros = String(BigInt(SESSION_MINUTES) * 60n * 1000000n);

    const authUrl = `${base}${apiPrefix}/api/v2/hotspot/extPortal/auth`;
    const payload = {
      clientMac,
      apMac,
      ssidName,
      radioId: radioId ? Number(radioId) : 1,
      site,
      time: timeMicros,
      authType: 4
    };

    log('AUTHORIZE POST ->', authUrl, 'payload:', {
      clientMac, apMac, ssidName, radioId: payload.radioId, site, time: String(timeMicros)
    });

    try {
      const auth = await http.post(
        authUrl,
        payload,
        {
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Csrf-Token': csrf
          }
        }
      );

      const a = auth && auth.data ? auth.data : {};
      if (a.errorCode === 0) {
        log('AUTH success. Redirecting to', redirectUrl);
        return res.status(200).json({ ok: true, redirectUrl });
      }

      err('AUTH failed detail:', JSON.stringify(a));
      return res.status(502).json({ ok: false, error: 'Authorization failed', detail: a });
    } catch (e) {
      const detail = e?.response?.data || e.message || String(e);
      err('AUTH HTTP error:', detail);
      return res.status(502).json({ ok: false, error: 'Authorization HTTP error', detail });
    }
  } catch (e) {
    err('UNCAUGHT:', e?.message || e);
    return res.status(500).json({ ok: false, error: e?.message || 'Internal error' });
  }
}
