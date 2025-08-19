// api/authorize.js  Vercel Node runtime, ESM style
// Build: 2025-08-19c redis-ledger-live

console.log("DEBUG: authorize.js build version 2025-08-19c");

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
    APP_TZ = 'America/New_York',

    // Credit config (cents)
    BASIC_MONTHLY_CENTS = '5000',    // $50 monthly bucket
    BASIC_SESSION_CENTS = '500',     // $5 per standard session
    BASIC_EXTEND_CENTS  = '500'      // $5 for extend/late window
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

  // Redis ping
  let redis;
  try {
    const { getRedis } = await import('../lib/redis.js');
    log('Redis ping start');
    redis = await getRedis();
    const key = `w2g:auth-ping:${clientMac || 'unknown'}`;
    await redis.set(key, JSON.stringify({ when: new Date().toISOString(), site: site || '(none)' }), { EX: 300 });
    log(`Redis key set ${key}`);
  } catch (e) {
    console.error(`[authorize][${rid}] Redis connect error`, e?.message || e);
    return res.status(502).json({ ok: false, error: 'Redis unavailable' });
  }

  if (!clientMac || !site) {
    err('Missing required fields: clientMac or site.');
    return res.status(400).json({ ok: false, error: 'Missing clientMac or site from splash redirect.' });
  }
  if (!email) {
    err('Missing email for Nexudus lookup.');
    return res.status(400).json({ ok: false, error: 'Email is required on the splash form.' });
  }

  // axios for Omada
  const http = axios.create({
    timeout: 15000,
    httpsAgent: new (https.Agent)({ rejectUnauthorized: false })
  });

  // axios for Nexudus
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

  /* ---------- Redis credit ledger ---------- */

  const MONTHLY_CENTS = toInt(BASIC_MONTHLY_CENTS, 5000);
  const SESSION_CENTS = toInt(BASIC_SESSION_CENTS, 500);
  const EXTEND_CENTS  = toInt(BASIC_EXTEND_CENTS, 500);

  function localCycleKey(date = new Date()) {
    // Use calendar month cycle key like 2025-08
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
  }

  function creditKeys(cycleKey, coworkerId) {
    return {
      ledgerKey: `w2g:credits:${cycleKey}:${coworkerId}`,
      eventsKey: `w2g:ledger:${cycleKey}:${coworkerId}`
    };
  }

  async function getOrInitLedger(redis, ledgerKey, seed) {
    const existing = await redis.get(ledgerKey);
    if (existing) {
      try { return JSON.parse(existing); } catch { /* fall through */ }
    }
    await redis.set(ledgerKey, JSON.stringify(seed));
    return seed;
  }

  function toInt(v, d) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n) : d;
  }

  /* ---------- Flow ---------- */

  // 0) Nexudus precheck
  let coworker;
  try {
    coworker = await nxGetCoworkerByEmail(email);
    if (!coworker) {
      log('Nexudus coworker not found for email', email);
      return res.status(403).json({ ok: false, error: 'Account not found in Nexudus' });
    }
    log(`Nexudus coworker id=${coworker.Id} name=${coworker.FullName}`);

    const contracts = await nxGetActiveContracts(coworker.Id);
    const contractNames = contracts.map(c => String(c.TariffName || '').trim().toLowerCase());
    const hasBasic = contractNames.some(n => n === 'basic' || n.includes('basic'));
    const hasClassic = contractNames.some(n => n.includes('classic'));
    const has247 = contractNames.some(n => n.includes('24') || n.includes('247'));
    log(`Active contracts=${contracts.length} hasBasic=${hasBasic} hasClassic=${hasClassic} has247=${has247}`);

    // SSID policy example: Basic SSID only for Basic/Classic/24/7
    if ((ssidName || '').toLowerCase().includes('basic')) {
      if (!hasBasic && !hasClassic && !has247) {
        return res.status(403).json({ ok: false, error: 'Basic plan required for this SSID' });
      }
    }

    if (hasBasic) {
      const policy = computeBasicPolicy(new Date());
      if (!policy.allowed) return res.status(403).json({ ok: false, error: policy.reason });
    }
  } catch (e) {
    err('Nexudus precheck error:', e?.message || e);
    return res.status(502).json({ ok: false, error: 'Nexudus precheck failed' });
  }

  // 1) If Basic, ensure credits are available in Redis
  const isBasic = true; // we only reach here if Basic was allowed on this SSID; Classic/24/7 skip debits below
  let requiredCents = 0;
  let debitReason = 'none';

  const policyNow = computeBasicPolicy(new Date());
  if (!policyNow.allowed) return res.status(403).json({ ok: false, error: policyNow.reason });

  if (isBasic) {
    if (policyNow.phase === 'standard') {
      requiredCents = SESSION_CENTS + (extend ? EXTEND_CENTS : 0);
      debitReason = extend ? 'standard+extend' : 'standard';
    } else {
      // late window requires extend to continue
      if (!extend) {
        return res.status(402).json({ ok: false, error: 'Extra hour required. Select Extend to continue.' });
      }
      requiredCents = SESSION_CENTS + EXTEND_CENTS;
      debitReason = 'late+extend';
    }
  }

  let ledgerKey, eventsKey, ledger;
  try {
    const cycleKey = localCycleKey(new Date());
    const keys = creditKeys(cycleKey, coworker.Id);
    ledgerKey = keys.ledgerKey;
    eventsKey = keys.eventsKey;

    const seed = {
      coworkerId: coworker.Id,
      email,
      plan: 'basic',
      cycle: cycleKey,
      remainingCents: MONTHLY_CENTS,
      spentCents: 0,
      checkins: 0,
      lastUpdated: new Date().toISOString()
    };

    ledger = await getOrInitLedger(redis, ledgerKey, seed);

    if (isBasic) {
      if (Number(ledger.remainingCents) < requiredCents) {
        log(`Insufficient credits remaining=${ledger.remainingCents} required=${requiredCents}`);
        return res.status(402).json({ ok: false, error: 'Not enough credits for WiFi session' });
      }
    }
  } catch (e) {
    err('Ledger init error:', e?.message || e);
    return res.status(502).json({ ok: false, error: 'Credit ledger unavailable' });
  }

  // 2) Omada hotspot login
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

  // 3) Omada authorize until policy cutoff
  const payload = {
    clientMac,
    apMac,
    ssidName,
    radioId: radioIdRaw ? Number(radioIdRaw) : 1,
    site,
    time: String(Math.max(60000, policyNow.msRemaining)),
    authType: 4
  };

  const cookieHeader = loginCookies.length ? { Cookie: loginCookies.join('; ') } : {};
  log('AUTHORIZE POST ->', AUTH_URL, 'payload:', { ...payload, clientMac: '(present)', apMac: '(present)' });

  const { data: authData, status: authStatus } =
    await postJson(AUTH_URL, payload, { 'Csrf-Token': csrf, ...cookieHeader });

  if (!(authStatus === 200 && authData?.errorCode === 0)) {
    err('AUTH failed status', authStatus, 'detail:', JSON.stringify(authData || {}));
    return res.status(502).json({ ok: false, error: 'Authorization failed', detail: authData });
  }

  // 4) Record successful check-in and apply debit (only after Omada success)
  try {
    const event = {
      when: new Date().toISOString(),
      clientMac,
      apMac,
      ssidName,
      site,
      durationMs: Math.max(60000, policyNow.msRemaining),
      phase: policyNow.phase,
      extend: !!extend,
      debitCents: isBasic ? requiredCents : 0,
      reason: debitReason
    };

    if (isBasic) {
      ledger.remainingCents = Math.max(0, Number(ledger.remainingCents) - requiredCents);
      ledger.spentCents = Number(ledger.spentCents) + requiredCents;
    }
    ledger.checkins = Number(ledger.checkins) + 1;
    ledger.lastUpdated = new Date().toISOString();

    await redis.set(ledgerKey, JSON.stringify(ledger));
    await redis.lpush(eventsKey, JSON.stringify(event));
    log(`Ledger updated ${ledgerKey} remaining=${ledger.remainingCents} spent=${ledger.spentCents}`);
  } catch (e) {
    err('Ledger write error:', e?.message || e);
    // Do not revoke Omada on write failure; log for later reconciliation
  }

  // 5) Success response
  log('AUTH success -> redirect', redirectUrl);
  return res.status(200).json({
    ok: true,
    redirectUrl,
    cutoff: policyNow.cutoffISO,
    extended: !!extend
  });
}

/* ---------- utils ---------- */

function setLocalTime(d, hh, mm, ss) {
  d.setHours(hh, mm, ss, 0);
  return d;
}
