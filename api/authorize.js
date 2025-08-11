// api/authorize.js  (Vercel Serverless Function - CommonJS)

const axiosLib = require('axios');
const axios = axiosLib.default || axiosLib;
const tough = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');
const https = require('https');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Use POST' });
    return;
  }

  try {
    const {
      OMADA_BASE,            // e.g. https://98.114.198.237:9444
      OMADA_OPERATOR_USER,   // OC200/Omada operator username
      OMADA_OPERATOR_PASS,   // OC200/Omada operator password
      SESSION_MINUTES = '240'
    } = process.env;

    if (!OMADA_BASE || !OMADA_OPERATOR_USER || !OMADA_OPERATOR_PASS) {
      res.status(500).json({ ok: false, error: 'Missing env vars' });
      return;
    }

    // Params Omada includes in the ext portal URL
    const {
      clientMac,
      apMac,
      ssidName,
      radioId,
      site,
      redirectUrl
    } = req.body || {};

    if (!clientMac || !site) {
      res.status(400).json({ ok: false, error: 'Missing clientMac or site' });
      return;
    }

    // OC200 lives under /omada
    const base = `${OMADA_BASE.replace(/\/$/, '')}/omada`;

    // Accept self-signed certs on OC200; NODE_TLS_REJECT_UNAUTHORIZED=0 is set too
    const agent = new https.Agent({ rejectUnauthorized: false });

    // Keep cookies across requests
    const jar = new tough.CookieJar();
    const http = wrapper(
      axios.create({
        jar,
        withCredentials: true,
        httpsAgent: agent,
        timeout: 10000
      })
    );

    // --- 1) Hotspot login -> CSRF token
    const login = await http.post(
      `${base}/api/v2/hotspot/login`,
      { name: OMADA_OPERATOR_USER, password: OMADA_OPERATOR_PASS },
      { headers: { 'Content-Type': 'application/json', Accept: 'application/json' } }
    );

    if (!login.data || login.data.errorCode !== 0) {
      res.status(502).json({ ok: false, error: 'Hotspot login failed', detail: login.data });
      return;
    }

    const csrf = login.data.result?.token;
    if (!csrf) {
      res.status(502).json({ ok: false, error: 'No CSRF token returned' });
      return;
    }

    // --- 2) Authorize client (time is in microseconds)
    const mins = BigInt(parseInt(SESSION_MINUTES, 10) || 240);
    const timeMicros = (mins * 60n * 1000000n).toString();

    const payload = {
      clientMac,
      apMac,
      ssidName,
      radioId: radioId ? Number(radioId) : 1,
      site,                // passed through from Omada's URL
      time: timeMicros,
      authType: 4          // 4 = External Portal
    };

    const auth = await http.post(
      `${base}/api/v2/hotspot/extPortal/auth`,
      payload,
      {
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Csrf-Token': csrf
        }
      }
    );

    if (!auth.data || auth.data.errorCode !== 0) {
      res.status(502).json({ ok: false, error: 'Authorization failed', detail: auth.data });
      return;
    }

    res.json({ ok: true, redirectUrl: redirectUrl || 'http://neverssl.com' });
  } catch (err) {
    console.error('authorize error:', err?.response?.data || err.message || err);
    res.status(500).json({
      ok: false,
      error: err.message || 'Internal error',
      detail: err?.response?.data
    });
  }
};
