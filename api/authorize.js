// api/authorize.js  Vercel Node runtime, ESM style
// Build: 2025-08-20k.5  (Basic time windows: 8:50 early, 9:00 to 4:10 day, 4:10 to 5:15 after, hard cut 5:15)

console.log("DEBUG: authorize.js build version 2025-08-20k.5");

export default async function handler(req, res) {
  const rid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const log = (...a) => console.log(`[authorize][${rid}]`, ...a);
  const err = (...a) => console.error(`[authorize][${rid}]`, ...a);

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Use POST' });
  }

  const axios = (await import('axios')).default;
  const https = await import('https');

  const {
    // Omada
    OMADA_BASE,
    OMADA_CONTROLLER_ID,
    OMADA_OPERATOR_USER,
    OMADA_OPERATOR_PASS,
    OMADA_SITE_NAME,

    // Nexudus
    NEXUDUS_BASE,
    NEXUDUS_USER,
    NEXUDUS_PASS,

    // App timezone
    APP_TZ = 'America/New_York',

    // Credit config in cents
    BASIC_MONTHLY_CENTS = '7500',
    BASIC_SESSION_CENTS = '500',
    BASIC_EXTEND_CENTS  = '500'
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
  const hostHeader = (() => { try { return new URL(base).host; } catch { return 'omada.work2gether.space'; } })();

  // body
  const b = (req.body && typeof req.body === 'object') ? req.body : {};
  const clientMacRaw = b.clientMac || b.client_id || '';
  const apMacRaw     = b.apMac || '';
  const ssidName     = b.ssidName || b.ssid || '';
  const radioIdRaw   = b.radioId || b.radio || 1;
  const siteFromBody = b.site || '';
  const redirectUrl  = b.redirectUrl || 'http://neverssl.com';
  const email        = b.email || '';
  const extend       = !!b.extend;

  const omadaSite = (OMADA_SITE_NAME && OMADA_SITE_NAME.trim()) || siteFromBody || 'Default';

  log('REQUEST BODY (redacted):', {
    clientMac: clientMacRaw ? '(present)' : '',
    apMac:     apMacRaw ? '(present)' : '',
    ssidName:  ssidName || '',
    radioId:   Number(radioIdRaw) || 1,
    site:      omadaSite,
    email:     email ? '(present)' : '',
    extend,
    redirectUrl
  });

  // Bring in the time window planner from lib (CommonJS module)
  let planBasicSession, EARLY_START_MIN, DAY_END_MIN, HARD_CUTOFF_MIN;
  try {
    const tw = await import('../lib/timeWindows.js');
    const mod = tw.default || tw; // CJS interop
    planBasicSession = mod.planBasicSession;
    EARLY_START_MIN  = mod.EARLY_START_MIN;
    DAY_END_MIN      = mod.DAY_END_MIN;
    HARD_CUTOFF_MIN  = mod.HARD_CUTOFF_MIN;
    if (typeof planBasicSession !== 'function') {
      throw new Error('timeWindows module did not export planBasicSession');
    }
  } catch (e) {
    err('Failed to load timeWindows.js:', e?.message || e);
    return res.status(500).json({ ok: false, error: 'Server config error: timeWindows' });
  }

  // Redis
  let redis;
  try {
    const { getRedis } = await import('../lib/redis.js');
    log('Redis ping start');
    redis = await getRedis();
    await redis.set(
      `w2g:auth-ping:${clientMacRaw || 'unknown'}`,
      JSON.stringify({ when: new Date().toISOString(), site: omadaSite }),
      { EX: 300 }
    );
  } catch (e) {
    console.error(`[authorize][${rid}] Redis connect error`, e?.message || e);
    return res.status(502).json({ ok: false, error: 'Redis unavailable' });
  }

  if (!clientMacRaw || !omadaSite) return res.status(400).json({ ok: false, error: 'Missing clientMac or site' });
  if (!email) return res.status(400).json({ ok: false, error: 'Email is required on the splash form.' });

  // axios clients
  const http = axios.create({
    timeout: 15000,
    httpsAgent: new (https.Agent)({ rejectUnauthorized: false }),
    headers: {
      Accept: 'application/json',
      'User-Agent': 'w2g-splash/1.0',
      Host: hostHeader
    }
  });
  const nx = axios.create({
    baseURL: NEXUDUS_BASE.replace(/\/+$/, ''),
    timeout: 15000,
    headers: { Accept: 'application/json', Authorization: NEX_AUTH }
  });

  /* Nexudus helpers */
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

  /* Omada helpers */
  const postJson = async (url, json, headers = {}) => {
    const resp = await http.post(url, json, {
      headers: { 'Content-Type': 'application/json', ...headers },
      validateStatus: () => true
    });
    const cookies = resp.headers?.['set-cookie'] || [];
    return { data: resp.data, status: resp.status, cookies, headers: resp.headers };
  };

  /* Ledger helpers */
  const MONTHLY_CENTS = toInt(BASIC_MONTHLY_CENTS, 7500);
  const SESSION_CENTS = toInt(BASIC_SESSION_CENTS, 500);
  const EXTEND_CENTS  = toInt(BASIC_EXTEND_CENTS, 500);

  function localCycleKey(date = new Date(), tz = APP_TZ) {
    const yFmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric' });
    const mFmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, month: '2-digit' });
    return `${yFmt.format(date)}-${mFmt.format(date)}`;
  }
  function creditKeys(cycleKey, coworkerId) {
    return {
      ledgerKey: `w2g:credits:${cycleKey}:${coworkerId}`,
      eventsKey: `w2g:ledger:${cycleKey}:${coworkerId}`
    };
  }
  async function getOrInitLedger(redis, ledgerKey, seed) {
    const existing = await redis.get(ledgerKey);
    if (existing) { try { return JSON.parse(existing); } catch { /* ignore parse issue */ } }
    await redis.set(ledgerKey, JSON.stringify(seed));
    return seed;
  }
  function toInt(v, d) { const n = Number(v); return Number.isFinite(n) ? Math.round(n) : d; }
  const macToColons  = mac => {
    const hex = String(mac || '').toUpperCase().replace(/[^0-9A-F]/g, '');
    if (hex.length !== 12) return String(mac || '').toUpperCase().replace(/[^0-9A-F]/g, ':');
    return hex.match(/.{1,2}/g).join(':');
  };
  const macToHyphens = mac => {
    const hex = String(mac || '').toUpperCase().replace(/[^0-9A-F]/g, '');
    if (hex.length !== 12) return String(mac || '').toUpperCase().replace(/[^0-9A-F]/g, '-');
    return hex.match(/.{1,2}/g).join('-');
  };

  // Map charge codes from planner to cents in your ledger
  function centsForCharge(code) {
    if (code === 'daily') return SESSION_CENTS;       // 5 dollars
    if (code === 'after_hours') return EXTEND_CENTS;  // 5 dollars
    if (code === 'early') return SESSION_CENTS;       // 5 dollars
    return 0;
  }

  /* Flow */

  // 0) Nexudus precheck for membership
  let coworker, hasBasic = false, hasClassic = false, has247 = false;
  try {
    coworker = await nxGetCoworkerByEmail(email);
    if (!coworker) return res.status(403).json({ ok: false, error: 'Account not found in Nexudus' });

    log(`Nexudus coworker id=${coworker.Id} name=${coworker.FullName}`);
    const contracts = await nxGetActiveContracts(coworker.Id);
    const names = contracts.map(c => String(c.TariffName || '').trim().toLowerCase());
    hasBasic = names.some(n => n.includes('basic'));
    hasClassic = names.some(n => n.includes('classic'));
    has247 = names.some(n => n.includes('24') || n.includes('247'));
    log(`Active contracts=${contracts.length} hasBasic=${hasBasic} hasClassic=${hasClassic} has247=${has247}`);

    if ((ssidName || '').toLowerCase().includes('basic') && !hasBasic && !hasClassic && !has247) {
      return res.status(403).json({ ok: false, error: 'Basic plan required for this SSID' });
    }
  } catch (e) {
    err('Nexudus precheck error:', e?.message || e);
    return res.status(502).json({ ok: false, error: 'Nexudus precheck failed' });
  }

  // 1) Build the time-window plan and compute debit requirement
  const isBasic = hasBasic;
  let plan;
  try {
    plan = isBasic
      ? planBasicSession({ nowTs: Date.now(), extend: Boolean(extend) })
      : { allow: true, reason: 'Non Basic path', durationMs: 60 * 60 * 1000, charges: [], window: 'open' };

    if (!plan.allow) {
      log(`Basic plan deny: reason="${plan.reason}" window="${plan.window}" email=${email}`);
      return res.status(403).json({ ok: false, error: plan.reason });
    }
  } catch (e) {
    err('Time planner error:', e?.message || e);
    return res.status(500).json({ ok: false, error: 'Time planner failed' });
  }

  // Sum required cents for this authorization
  const totalRequiredCents = plan.charges.reduce((sum, ch) => sum + centsForCharge(ch.code), 0);

  // 2) Ensure credits exist and are sufficient for this authorization
  let ledgerKey, eventsKey, ledger;
  try {
    const cycleKey = localCycleKey(new Date(), APP_TZ);
    ({ ledgerKey, eventsKey } = creditKeys(cycleKey, coworker.Id));
    const seed = {
      coworkerId: coworker.Id,
      email,
      plan: isBasic ? 'basic' : (hasClassic ? 'classic' : (has247 ? '247' : 'other')),
      cycle: cycleKey,
      remainingCents: MONTHLY_CENTS,
      spentCents: 0,
      checkins: 0,
      lastUpdated: new Date().toISOString()
    };
    ledger = await getOrInitLedger(redis, ledgerKey, seed);

    const currentCap = Number(ledger.remainingCents || 0) + Number(ledger.spentCents || 0);
    if (currentCap < MONTHLY_CENTS) {
      const bump = MONTHLY_CENTS - currentCap;
      ledger.remainingCents = Number(ledger.remainingCents || 0) + bump;
      ledger.lastUpdated = new Date().toISOString();
      await redis.set(ledgerKey, JSON.stringify(ledger));
      log(`Ledger reconciled ${ledgerKey} +${bump} to match MONTHLY_CENTS=${MONTHLY_CENTS}`);
    }

    if (isBasic && Number(ledger.remainingCents) < totalRequiredCents) {
      log(`Insufficient credits remaining=${ledger.remainingCents} required=${totalRequiredCents}`);
      return res.status(402).json({ ok: false, error: 'Not enough credits for WiFi session' });
    }
  } catch (e) {
    err('Ledger init or check error:', e?.message || e);
    return res.status(502).json({ ok: false, error: 'Credit ledger unavailable' });
  }

  // 3) Omada login with stronger retry
  async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  async function loginWithRetry(max = 8) {
    const backoffs = [300, 600, 1000, 1500, 2500, 3500, 5000, 7000];
    for (let i = 1; i <= max; i++) {
      log(`LOGIN attempt ${i}/${max}:`, LOGIN_URL);
      const r = await postJson(
        LOGIN_URL,
        { name: OMADA_OPERATOR_USER, password: OMADA_OPERATOR_PASS },
        { Host: hostHeader, Accept: 'application/json' }
      );
      const isHtml = typeof r.data === 'string' && /<html/i.test(r.data);
      const ok = r.status === 200 && !isHtml && r.data?.errorCode === 0;
      if (ok) return r;

      const retryableStatus = (r.status >= 500 && r.status <= 599) || r.status === 530;
      const retryable = isHtml || retryableStatus;
      if (!retryable || i === max) {
        err('LOGIN failed', r.status, 'detail:', isHtml ? '(html)' : JSON.stringify(r.data || {}));
        return null;
      }
      await sleep(backoffs[i - 1] || 1000);
    }
    return null;
  }

  const loginResp = await loginWithRetry(8);
  if (!loginResp) {
    return res.status(502).json({ ok: false, error: 'Hotspot login failed (gateway)', detail: 'controller 5xx or html' });
  }

  const { data: loginData, headers: loginHeaders, cookies: loginCookies } = loginResp;
  const csrf = loginHeaders?.['csrf-token'] || loginHeaders?.['Csrf-Token'] || loginData?.result?.token || null;
  if (!csrf) return res.status(502).json({ ok: false, error: 'Login returned no CSRF token' });

  // Cookies header
  const cookiePairs = Array.isArray(loginCookies) ? loginCookies.map(c => String(c).split(';')[0]).filter(Boolean) : [];
  const cookieHeader = cookiePairs.length ? { Cookie: cookiePairs.join('; ') } : {};
  log('Login cookies parsed count=', cookiePairs.length, 'csrf(len)=', String(csrf || '').length);

  // 4) Omada authorize with duration from plan
  const timeMsBase = Math.max(60000, Number(plan.durationMs || 0) || 60000);
  const timeUnits = [
    { label: 'ms', value: timeMsBase },
    { label: 'us', value: timeMsBase * 1000 },
    { label: 's',  value: Math.floor(timeMsBase / 1000) }
  ];
  const macFormats = [
    { label: 'colons',  cm: macToColons(clientMacRaw), am: macToColons(apMacRaw) },
    { label: 'hyphens', cm: macToHyphens(clientMacRaw), am: macToHyphens(apMacRaw) }
  ];
  const authTypes = [4, 2];

  const strictHeaders = {
    ...cookieHeader,
    'Csrf-Token': csrf,
    'X-Csrf-Token': csrf,
    'X-Requested-With': 'XMLHttpRequest',
    'Origin': base,
    'Referer': `${base}/${OMADA_CONTROLLER_ID}/portal`,
    Host: hostHeader,
    Accept: 'application/json'
  };

  let authOk = false, last = { status: 0, data: null, note: '' };
  outer:
  for (const mf of macFormats) {
    for (const tu of timeUnits) {
      for (const at of authTypes) {
        const payload = {
          clientMac: mf.cm,
          apMac: mf.am,
          ssidName,
          ssid: ssidName,
          radioId: Number(radioIdRaw) || 1,
          site: omadaSite,
          time: tu.value,
          authType: at
        };
        log(`AUTHORIZE TRY mac=${mf.label} time=${tu.label} authType=${at} ->`, AUTH_URL, 'payload:', { ...payload, clientMac: '(present)', apMac: '(present)' });
        const { data: authData, status: authStatus } = await postJson(AUTH_URL, payload, strictHeaders);
        last = { status: authStatus, data: authData, note: `mac=${mf.label} time=${tu.label} authType=${at}` };
        if (authStatus === 200 && authData?.errorCode === 0) { authOk = true; break outer; }
        if (!(authStatus === 200 && authData?.errorCode === -41501)) break;
      }
    }
  }

  if (!authOk) {
    err('AUTH failed after matrix, last=', last.note, 'status', last.status, 'detail:', JSON.stringify(last.data || {}));
    return res.status(502).json({ ok: false, error: 'Authorization failed', detail: last.data, attempt: last.note });
  }

  // 5) Record debit and event
  try {
    const debitCents = isBasic ? totalRequiredCents : 0;

    if (isBasic && debitCents > 0) {
      const current = JSON.parse(await redis.get(ledgerKey));
      current.remainingCents = Math.max(0, Number(current.remainingCents) - debitCents);
      current.spentCents = Number(current.spentCents) + debitCents;
      current.checkins = Number(current.checkins) + 1;
      current.lastUpdated = new Date().toISOString();
      await redis.set(ledgerKey, JSON.stringify(current));
      log(`Ledger debited ${debitCents}c -> remaining=${current.remainingCents} spent=${current.spentCents}`);
    }

    const event = {
      when: new Date().toISOString(),
      clientMac: macToColons(clientMacRaw),
      apMac: macToColons(apMacRaw),
      ssidName,
      site: omadaSite,
      durationMs: timeMsBase,
      window: plan.window,
      extend: !!extend,
      debitCents,
      charges: plan.charges,
      reason: plan.reason
    };
    await redis.lPush(eventsKey, JSON.stringify(event));
  } catch (e) {
    err('Ledger write error:', e?.message || e);
  }

  // 6) Success
  log('AUTH success -> redirect', redirectUrl);
  return res.status(200).json({
    ok: true,
    redirectUrl,
    cutoff: new Date(Date.now() + timeMsBase).toISOString(),
    extended: !!extend,
    window: plan.window,
    message: plan.reason
  });
}

/* utils */
function toInt(v, d) { const n = Number(v); return Number.isFinite(n) ? Math.round(n) : d; }
function macToColons(mac) {
  const hex = String(mac || '').toUpperCase().replace(/[^0-9A-F]/g, '');
  if (hex.length !== 12) return String(mac || '').toUpperCase().replace(/[^0-9A-F]/g, ':');
  return hex.match(/.{1,2}/g).join(':');
}
function macToHyphens(mac) {
  const hex = String(mac || '').toUpperCase().replace(/[^0-9A-F]/g, '');
  if (hex.length !== 12) return String(mac || '').toUpperCase().replace(/[^0-9A-F]/g, '-');
  return hex.match(/.{1,2}/g).join('-');
}
