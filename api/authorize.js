// api/authorize.js  Vercel Node runtime, ESM style
// Build: 2025-08-28f  parity with omada_probe (Referer=/portal, X-Requested-With on login), fix timeMsBase

console.log("DEBUG: authorize.js build version 2025-08-28f");

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
    OMADA_BASE,
    OMADA_CONTROLLER_ID,
    OMADA_OPERATOR_USER,
    OMADA_OPERATOR_PASS,
    OMADA_SITE_NAME,
    OMADA_SITE_ID,

    NEXUDUS_BASE,
    NEXUDUS_USER,
    NEXUDUS_PASS,

    APP_TZ = 'America/New_York',

    BASIC_MONTHLY_CENTS = '7500',
    BASIC_SESSION_CENTS = '500',
    BASIC_EXTEND_CENTS  = '500',
    BASIC_EARLY_CENTS   = '500'
  } = process.env;

  if (!OMADA_BASE || !OMADA_CONTROLLER_ID || !OMADA_OPERATOR_USER || !OMADA_OPERATOR_PASS) {
    err('Missing env vars. Need OMADA_BASE, OMADA_CONTROLLER_ID, OMADA_OPERATOR_USER, OMADA_OPERATOR_PASS.');
    return res.status(500).json({ ok: false, error: 'Missing Omada env vars' });
  }
  if (!NEXUDUS_BASE || !NEXUDUS_USER || !NEXUDUS_PASS) {
    err('Missing env vars. Need NEXUDUS_BASE, NEXUDUS_USER, NEXUDUS_PASS.');
  }

  const base = OMADA_BASE.replace(/\/+$/, '');
  const CTRL_ID = OMADA_CONTROLLER_ID;

  // Endpoints
  const PORTAL_URL       = `${base}/${CTRL_ID}/portal`;
  const HOTSPOT_LOGIN    = `${base}/${CTRL_ID}/hotspot/login`;
  const LOGIN_URL_STD    = `${base}/${CTRL_ID}/api/v2/hotspot/login`;
  const LOGIN_URL_ALT    = `${base}/${CTRL_ID}/api/v2/hotspot/extPortal/login`;
  const AUTH_URL         = `${base}/${CTRL_ID}/api/v2/hotspot/extPortal/auth`;
  const LOGIN_STATUS     = (token) => `${base}/${CTRL_ID}/api/v2/hotspot/loginStatus?token=${encodeURIComponent(token || '')}`;

  // Nexudus HTTP auth header
  const NEX_AUTH  = (NEXUDUS_USER && NEXUDUS_PASS)
    ? "Basic " + Buffer.from(`${NEXUDUS_USER}:${NEXUDUS_PASS}`).toString("base64")
    : null;

  // Body + debug flag
  const b = (req.body && typeof req.body === 'object') ? req.body : {};
  const clientMacRaw = b.clientMac || b.client_id || '';
  const apMacRaw     = b.apMac || '';
  const ssidName     = b.ssidName || b.ssid || '';
  const radioIdRaw   = b.radioId || b.radio || 1;
  const siteFromBody = b.site || '';
  const redirectUrl  = b.redirectUrl || 'http://neverssl.com';
  const email        = b.email || '';
  const extend       = !!b.extend;

  const dbgProbe = String(
    (req.headers['x-debug-probe'] || '') ||
    (req.query && (req.query.debug || '')) ||
    (b.debug || '')
  ).toLowerCase().trim();
  const dbg = { enabled: dbgProbe === 'omada' };

  // Site identification
  const looksLikeId = (s) => /^[a-f0-9]{24}$/i.test(String(s || '').trim());
  const siteName = (OMADA_SITE_NAME && OMADA_SITE_NAME.trim())
                || (looksLikeId(siteFromBody) ? '' : siteFromBody)
                || 'Default';
  const siteId = looksLikeId(siteFromBody) ? siteFromBody
             : looksLikeId(OMADA_SITE_ID) ? OMADA_SITE_ID
             : null;

  // MAC helpers
  const macHex = mac => String(mac || '').toUpperCase().replace(/[^0-9A-F]/g, '');
  const macToColons  = mac => {
    const hex = macHex(mac);
    if (hex.length !== 12) return String(mac || '').toUpperCase().replace(/[^0-9A-F]/g, ':');
    return hex.match(/.{1,2}/g).join(':');
  };
  const macToHyphens = mac => {
    const hex = macHex(mac);
    if (hex.length !== 12) return String(mac || '').toUpperCase().replace(/[^0-9A-F]/g, '-');
    return hex.match(/.{1,2}/g).join('-');
  };
  const macPlain = mac => macHex(mac);
  const macPlainLower = mac => macPlain(mac).toLowerCase();

  // Pricing helpers
  function toInt(v, d) { const n = Number(v); return Number.isFinite(n) ? Math.round(n) : d; }
  function amountForCharge(code) {
    if (code === 'daily')       return toInt(BASIC_SESSION_CENTS, 500);
    if (code === 'after_hours') return toInt(BASIC_EXTEND_CENTS, 500);
    if (code === 'early')       return toInt(BASIC_EARLY_CENTS, 500);
    return 0;
  }
  function fieldForCharge(code) {
    if (code === 'daily')       return 'session';
    if (code === 'after_hours') return 'extend';
    if (code === 'early')       return 'early';
    return null;
  }

  function localCycleKey(date = new Date(), tz = APP_TZ) {
    const yFmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric' });
    const mFmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, month: '2-digit' });
    return `${yFmt.format(date)}-${mFmt.format(date)}`;
  }
  function localDateKey(date = new Date(), tz = APP_TZ) {
    const y = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric' }).format(date);
    const m = new Intl.DateTimeFormat('en-CA', { timeZone: tz, month: '2-digit' }).format(date);
    const d = new Intl.DateTimeFormat('en-CA', { timeZone: tz, day: '2-digit' }).format(date);
    return `${y}-${m}-${d}`;
  }

  // ---------- PROBES ----------
  if (dbgProbe === 'redis') {
    try {
      const { getRedis } = await import('../lib/redis.js');
      const url = process.env.REDIS_URL || '';
      let host='(unknown)', port='(default)', db='0';
      try {
        const u = new URL(url);
        host = u.hostname || host; port = u.port || '(default)';
        const p = (u.pathname || '').replace(/^\//,'').trim(); db = p || '0';
      } catch {}
      const r = await getRedis();
      const pong = await r.ping();
      const writeKey = `w2g:probe:${Date.now()}`;
      await r.set(writeKey, 'ok', { EX: 120 });
      const dbsize = Number(await r.sendCommand(['DBSIZE']));
      return res.status(200).json({ ok: true, probe: 'redis', redis: { urlSet: !!url, host, port, db }, ping: pong, writeKey, dbsize });
    } catch (e) { err('redis probe error', e?.message || e); return res.status(500).json({ ok: false, probe: 'redis', error: String(e?.message || e) }); }
  }

  if (dbgProbe === 'ledger') {
    if (!clientMacRaw) return res.status(400).json({ ok:false, error:'Missing clientMac for ledger probe' });
    try {
      const { getRedis } = await import('../lib/redis.js');
      const r = await getRedis();
      const today = localDateKey(new Date(), APP_TZ);
      const macKey = `w2g:session:${macPlainLower(clientMacRaw)}`;
      const sessionJson = await r.get(macKey);
      let coworkerId = null; try { coworkerId = JSON.parse(sessionJson || '{}').coworkerId || null; } catch {}
      const debitKey = coworkerId ? `w2g:debits:${today}:${coworkerId}` : null;
      let debits = null, legacyCounter = null, keyType = null;
      if (debitKey) {
        keyType = await r.sendCommand(['TYPE', debitKey]);
        if (keyType === 'hash') debits = await r.hGetAll(debitKey);
        else if (keyType === 'string') legacyCounter = await r.get(debitKey);
      }
      const eventsKey = `w2g:events:${today}`;
      const eventsSlice = await r.lRange(eventsKey, 0, 19);
      return res.status(200).json({
        ok: true, probe: 'ledger',
        keys: { sessionKey: macKey, debitKey, eventsKey },
        session: sessionJson ? JSON.parse(sessionJson) : null,
        keyType, debits, legacyCounter,
        events: eventsSlice.map(s => { try { return JSON.parse(s); } catch { return s; } })
      });
    } catch (e) { err('ledger read-back error', e?.message || e); return res.status(500).json({ ok:false, probe:'ledger', error:String(e?.message || e) }); }
  }
  // ---------------------------

  // validation
  if (!clientMacRaw || !siteId) return res.status(400).json({ ok: false, error: !clientMacRaw ? 'Missing clientMac' : 'Missing Omada site id' });
  if (!email) return res.status(400).json({ ok: false, error: 'Email is required on the splash form.' });

  log('REQUEST BODY (redacted):', {
    clientMac: clientMacRaw ? '(present)' : '',
    apMac:     apMacRaw ? '(present)' : '',
    ssidName:  ssidName || '',
    radioId:   Number(radioIdRaw) || 1,
    siteName,
    siteId,
    email:     email ? '(present)' : '',
    extend,
    redirectUrl,
    dbgProbe
  });

  // load planner
  let planBasicSession;
  try {
    const tw = await import('../lib/timeWindows.js');
    const mod = tw.default || tw;
    planBasicSession = mod.planBasicSession;
    if (typeof planBasicSession !== 'function') throw new Error('planBasicSession missing');
  } catch (e) { err('Failed to load timeWindows.js:', e?.message || e); return res.status(500).json({ ok: false, error: 'Server config error: timeWindows' }); }

  // redis
  let redis;
  try {
    const { getRedis } = await import('../lib/redis.js');
    log('Redis ping start');
    redis = await getRedis();
    await redis.set(
      `w2g:auth-ping:${clientMacRaw || 'unknown'}`,
      JSON.stringify({ when: new Date().toISOString(), site: siteName, siteId }),
      { EX: 300 }
    );
  } catch (e) { err('Redis connect error', e?.message || e); return res.status(502).json({ ok: false, error: 'Redis unavailable' }); }

  // Nexudus http
  const nx = axios.create({ baseURL: NEXUDUS_BASE?.replace(/\/+$/, ''), timeout: 15000, headers: { Accept: 'application/json', Authorization: NEX_AUTH || '' }, validateStatus: () => true });
  async function nxGetCoworkerByEmail(emailAddr) {
    const url = `/api/spaces/coworkers?Coworker_email=${encodeURIComponent(emailAddr)}&_take=1`;
    const r = await nx.get(url); log('Nexudus coworkers GET status', r.status, 'url', url);
    if (r.status !== 200) throw new Error(`Nexudus coworkers HTTP ${r.status}`);
    return r.data?.Records?.[0] || null;
  }
  async function nxGetActiveContracts(coworkerId) {
    const url = `/api/billing/coworkercontracts?coworkercontract_coworker=${encodeURIComponent(coworkerId)}&coworkercontract_active=true`;
    const r = await nx.get(url); log('Nexudus contracts GET status', r.status, 'url', url);
    if (r.status !== 200) throw new Error(`Nexudus contracts HTTP ${r.status}`);
    return Array.isArray(r.data?.Records) ? r.data.Records : [];
  }

  function creditKeys(cycleKey, coworkerId) {
    return { ledgerKey: `w2g:credits:${cycleKey}:${coworkerId}`, eventsKey: `w2g:ledger:${cycleKey}:${coworkerId}` };
  }
  async function getOrInitLedger(r, ledgerKey, seed) {
    const existing = await r.get(ledgerKey);
    if (existing) { try { return JSON.parse(existing); } catch {} }
    await r.set(ledgerKey, JSON.stringify(seed));
    return seed;
  }

  // Nexudus precheck
  let coworker, hasBasic = false, hasStandard = false, hasPremium = false;
  try {
    coworker = await nxGetCoworkerByEmail(email);
    if (!coworker) return res.status(403).json({ ok: false, error: 'Account not found in Nexudus' });
    log(`Nexudus coworker id=${coworker.Id} name=${coworker.FullName}`);
    const contracts = await nxGetActiveContracts(coworker.Id);
    const names = contracts.map(c => String(c.TariffName || '').trim().toLowerCase());
    hasBasic    = names.some(n => n.includes('basic'));
    hasStandard = names.some(n => n.includes('classic') || n.includes('standard'));
    hasPremium  = names.some(n => n.includes('24') || n.includes('247') || n.includes('premium'));
    log(`Active contracts=${contracts.length} hasBasic=${hasBasic} hasStandard=${hasStandard} hasPremium=${hasPremium}`);
    if ((ssidName || '').toLowerCase().includes('basic') && !hasBasic && !hasStandard && !hasPremium) {
      return res.status(403).json({ ok: false, error: 'Basic plan required for this SSID' });
    }
  } catch (e) { err('Nexudus precheck error:', e?.message || e); return res.status(502).json({ ok: false, error: 'Nexudus precheck failed', detail: String(e?.message || e) }); }

  const isBasic = hasBasic;

  // planner
  let plan;
  try {
    const mod = await import('../lib/timeWindows.js');
    const fn = (mod.default && mod.default.planBasicSession) ? mod.default.planBasicSession : mod.planBasicSession;
    plan = isBasic
      ? await fn({ nowTs: Date.now(), extend: Boolean(extend) })
      : { allow: true, reason: 'Non Basic path', durationMs: 60 * 60 * 1000, charges: [], window: 'open' };
    if (!plan || !plan.allow) return res.status(403).json({ ok: false, error: plan?.reason || 'Denied' });
  } catch (e) { err('Time planner error:', e?.message || e); return res.status(500).json({ ok: false, error: 'Time planner failed' }); }

  // Monthly ledger preview + apply debits
  try {
    const cycleKey = localCycleKey(new Date(), APP_TZ);
    const { ledgerKey, eventsKey } = creditKeys(cycleKey, coworker.Id);
    const seed = {
      coworkerId: coworker.Id, email,
      plan: isBasic ? 'basic' : (hasStandard ? 'standard' : (hasPremium ? 'premium' : 'other')),
      cycle: cycleKey, remainingCents: Number(BASIC_MONTHLY_CENTS), spentCents: 0, checkins: 0, lastUpdated: new Date().toISOString()
    };
    const ledger = await getOrInitLedger(redis, ledgerKey, seed);
    const currentCap = Number(ledger.remainingCents || 0) + Number(ledger.spentCents || 0);
    if (currentCap < Number(BASIC_MONTHLY_CENTS)) {
      const bump = Number(BASIC_MONTHLY_CENTS) - currentCap;
      ledger.remainingCents = Number(ledger.remainingCents || 0) + bump;
      ledger.lastUpdated = new Date().toISOString();
      await redis.set(ledgerKey, JSON.stringify(ledger));
    }
    const required = (plan.charges || []).reduce((sum, ch) => sum + amountForCharge(ch.code), 0);
    if (isBasic && Number(ledger.remainingCents) < required) {
      return res.status(402).json({ ok: false, error: 'Not enough credits for WiFi session' });
    }
    await redis.lPush(eventsKey, JSON.stringify({
      when: new Date().toISOString(),
      type: 'preauth',
      clientMac: macToColons(clientMacRaw),
      apMac: macToColons(apMacRaw),
      ssidName,
      site: siteName,
      siteId,
      preview: true,
      charges: plan.charges || []
    }));
  } catch (e) { err('Ledger preview error', e?.message || e); }

  // ---------- Omada login/auth ----------
  function makeClient(purpose) {
    const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: false, maxSockets: 1 });
    const headers = {
      Accept: 'application/json,text/html;q=0.9,*/*;q=0.1',
      'User-Agent': `w2g-splash-${purpose}/${Math.random().toString(36).slice(2,7)}`,
      Connection: 'close',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
      'Accept-Language': 'en-US,en;q=0.9',
      // IMPORTANT: match probe — use /portal as Referer
      'Referer': PORTAL_URL,
      'Origin': base
    };
    return axios.create({ timeout: 15000, httpsAgent: agent, headers, validateStatus: () => true, maxRedirects: 0 });
  }

  function extractTokenFromHeaders(setCookieArr = [], headers = {}) {
    const sc = (setCookieArr || []).map(String);
    const join = sc.join('; ');
    const m =
      join.match(/csrf[-_]?token=([^;]+)/i) ||
      join.match(/x[-_]?csrf[-_]?token=([^;]+)/i) ||
      join.match(/portal[-_]?csrf=([^;]+)/i);
    if (m) return m[1];
    const hdr = Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    return hdr['csrf-token'] || hdr['x-csrf-token'] || null;
  }

  async function warmupCookies() {
    // Try hotspot login page first, then portal
    const c = [];
    const w1 = await makeClient('warm-hotspot').get(HOTSPOT_LOGIN);
    if (Array.isArray(w1.headers?.['set-cookie'])) c.push(...w1.headers['set-cookie']);
    const w2 = await makeClient('warm-portal').get(PORTAL_URL);
    if (Array.isArray(w2.headers?.['set-cookie'])) c.push(...w2.headers['set-cookie']);
    const cookieHeader = c.length ? { Cookie: c.map(s => String(s).split(';')[0]).join('; ') } : {};
    return { cookies: c, cookieHeader };
  }

  async function controllerLogin() {
    const { cookies: warmSet, cookieHeader } = await warmupCookies();

    let loginStatus = null, token = null, setCookie = warmSet, rawHeaders = {};
    for (const loginUrl of [LOGIN_URL_STD, LOGIN_URL_ALT]) {
      const resp = await makeClient('login').post(
        loginUrl,
        { name: OMADA_OPERATOR_USER, password: OMADA_OPERATOR_PASS },
        { headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', ...cookieHeader } } // <-- add X-Requested-With
      );
      loginStatus = resp.status;
      rawHeaders = resp.headers || {};
      token = (resp.data && resp.data.result && resp.data.result.token) ||
              rawHeaders['csrf-token'] || rawHeaders['Csrf-Token'] || null;

      if (!token) {
        const fromCookies = extractTokenFromHeaders(resp.headers?.['set-cookie'], rawHeaders);
        if (fromCookies) token = fromCookies;
      }

      if (token) {
        // verify with loginStatus, just like probe
        const merged = [...(warmSet || []), ... (resp.headers?.['set-cookie'] || [])];
        const cookieLine = merged.map(s => String(s).split(';')[0]).join('; ');
        const ver = await makeClient('status').get(LOGIN_STATUS(token), {
          headers: {
            Cookie: cookieLine,
            'X-Requested-With': 'XMLHttpRequest',
            'Csrf-Token': token
          }
        });
        if (ver.status === 200 && ver.data && ver.data.result && ver.data.result.login === true) {
          setCookie = merged;
          return { token, setCookie, status: loginStatus, rawHeaders, verified: true };
        } else {
          token = null; // try ALT path if std failed verification
        }
      }
    }
    return { token: null, setCookie, status: loginStatus, rawHeaders, verified: false };
  }

  // small in-memory cache to avoid re-login storms
  const cacheKey = 'omada_login_cache';
  const globalAny = globalThis;
  const nowMs = Date.now();
  let cached = globalAny[cacheKey];
  if (cached && (nowMs - cached.t < 2 * 60 * 1000)) {
    log('Using cached controller login (fresh)');
  } else if (cached && (nowMs - cached.t < 10 * 60 * 1000)) {
    log('Using cached controller login (stale-ok)');
  } else {
    cached = null;
  }

  async function getLoginState() {
    if (cached) return cached.v;
    const v = await controllerLogin();
    globalAny[cacheKey] = { v, t: Date.now() };
    return v;
  }

  const loginState = await getLoginState();
  if (!loginState || !loginState.token) {
    return res.status(502).json({
      ok: false,
      error: 'Hotspot login failed',
      detail: 'controller login did not produce token',
      omada: {
        login: {
          status: loginState?.status ?? null,
          tokenPresent: !!loginState?.token,
          verified: !!loginState?.verified,
          cookies: Array.isArray(loginState?.setCookie) ? loginState.setCookie.length : null,
          headerKeys: loginState?.rawHeaders ? Object.keys(loginState.rawHeaders) : null
        }
      }
    });
  }

  const csrf = loginState.token;
  const loginCookies = loginState.setCookie || [];
  const cookieLine = loginCookies.map(c => String(c).split(';')[0]).join('; ');

  const baseAuthHeaders = {
    Cookie: cookieLine,
    'Csrf-Token': csrf,
    'X-Csrf-Token': csrf,
    'X-Requested-With': 'XMLHttpRequest',
    'Origin': base,
    'Referer': PORTAL_URL, // match probe
    Accept: 'application/json'
  };
  const httpsAgentAuth = new https.Agent({ rejectUnauthorized: false, keepAlive: false, maxSockets: 1 });
  const httpAuth = axios.create({ timeout: 15000, httpsAgent: httpsAgentAuth, headers: { Accept: 'application/json' }, validateStatus: () => true });
  const postJson = async (url, json, headers = {}) => {
    const resp = await httpAuth.post(url, json, { headers: { 'Content-Type': 'application/json', ...headers } });
    return { data: resp.data, status: resp.status };
  };

  // Use the planner's duration directly (fix)
  const timeMsBase = Math.max(60000, Number((plan && plan.durationMs) || 60000));

  const macFormats = [
    { label: 'colons',     cm: macToColons(clientMacRaw), am: macToColons(apMacRaw) },
    { label: 'hyphens',    cm: macToHyphens(clientMacRaw), am: macToHyphens(apMacRaw) },
    { label: 'plain',      cm: macPlain(clientMacRaw), am: macPlain(apMacRaw) },
    { label: 'plainlower', cm: macPlainLower(clientMacRaw), am: macPlainLower(apMacRaw) }
  ];
  const authTypes = [4, 2];

  let authOk = false;
  let last = { status: 0, data: null, note: '' };
  const authAttempts = [];

  outer:
  for (const mf of macFormats) {
    for (const at of authTypes) {
      const payload = {
        clientMac: mf.cm,
        apMac: mf.am,
        ssidName,
        ssid: ssidName,
        radioId: Number(radioIdRaw) || 1,
        site: siteId,
        time: timeMsBase,
        authType: at
      };
      const { data: authData, status: authStatus } = await postJson(AUTH_URL, payload, baseAuthHeaders);
      last = { status: authStatus, data: authData, note: `mac=${mf.label} authType=${at}` };
      authAttempts.push({ status: authStatus, errorCode: authData?.errorCode, note: last.note });
      if (authStatus === 200 && authData?.errorCode === 0) { authOk = true; break outer; }
      if (!(authStatus === 200 && authData?.errorCode === -41501)) break;
    }
  }

  if (!authOk) {
    err('AUTH failed after matrix, last=', last.note, 'status', last.status, 'detail:', JSON.stringify(last.data || {}));
    return res.status(502).json({
      ok: false,
      error: 'Authorization failed',
      detail: last.data,
      attempt: last.note,
      attempts: authAttempts,
      omada: {
        login: { status: loginState?.status || null, tokenPresent: !!loginState?.token, verified: !!loginState?.verified, cookies: (loginState?.setCookie || []).length }
      }
    });
  }

  const nowIso = new Date().toISOString();
  const dateKey = localDateKey(new Date(), APP_TZ);

  try {
    await redis.set(
      `w2g:session:${macPlainLower(clientMacRaw)}`,
      JSON.stringify({
        when: nowIso,
        coworkerId: coworker.Id,
        email,
        ssidName,
        siteId,
        siteName,
        cutoff: new Date(Date.now() + (plan.durationMs || 60000)).toISOString(),
        window: plan.window
      }),
      { EX: 6 * 3600 }
    );
  } catch (e) { err('Session write error', e?.message || e); }

  try {
    await redis.lPush(`w2g:events:${dateKey}`, JSON.stringify({
      when: nowIso,
      type: 'authorize',
      coworkerId: coworker.Id,
      email,
      clientMac: macToColons(clientMacRaw),
      apMac: macToColons(apMacRaw),
      ssidName,
      site: siteName,
      siteId,
      window: plan.window
    }));
  } catch (e) { err('Events write error', e?.message || e); }

  const includeDebug = dbg.enabled ? {
    omada: {
      login: { status: loginState?.status || null, tokenPresent: !!loginState?.token, verified: !!loginState?.verified, cookies: (loginState?.setCookie || []).length },
      auth:  { attempts: authAttempts, chosen: last }
    }
  } : {};

  return res.status(200).json({
    ok: true,
    redirectUrl,
    cutoff: new Date(Date.now() + (plan.durationMs || 60000)).toISOString(),
    extended: !!extend,
    window: plan.window,
    message: plan.reason,
    ...includeDebug
  });
}
