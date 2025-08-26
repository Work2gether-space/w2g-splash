// api/authorize.js  Vercel Node runtime, ESM style
// Build: 2025-08-26b  step 3.4c omada debug + redis probe + daily debit write

console.log("DEBUG: authorize.js build version 2025-08-26b");

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
    BASIC_EXTEND_CENTS  = '500'
  } = process.env;

  if (!OMADA_BASE || !OMADA_CONTROLLER_ID || !OMADA_OPERATOR_USER || !OMADA_OPERATOR_PASS) {
    err('Missing env vars. Need OMADA_BASE, OMADA_CONTROLLER_ID, OMADA_OPERATOR_USER, OMADA_OPERATOR_PASS.');
    return res.status(500).json({ ok: false, error: 'Missing Omada env vars' });
  }
  if (!NEXUDUS_BASE || !NEXUDUS_USER || !NEXUDUS_PASS) {
    err('Missing env vars. Need NEXUDUS_BASE, NEXUDUS_USER, NEXUDUS_PASS.');
    // allow probes to proceed if Nexudus is not configured
  }

  const base = OMADA_BASE.replace(/\/+$/, '');
  const CTRL_ID = OMADA_CONTROLLER_ID;
  const LOGIN_URL_STD = `${base}/${CTRL_ID}/api/v2/hotspot/login`;
  const LOGIN_URL_ALT = `${base}/${CTRL_ID}/api/v2/hotspot/extPortal/login`;
  const AUTH_URL      = `${base}/${CTRL_ID}/api/v2/hotspot/extPortal/auth`;
  const PORTAL_URL    = `${base}/${CTRL_ID}/portal`;

  const NEX_AUTH  = (NEXUDUS_USER && NEXUDUS_PASS)
    ? "Basic " + Buffer.from(`${NEXUDUS_USER}:${NEXUDUS_PASS}`).toString("base64")
    : null;

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

  const looksLikeId = (s) => /^[a-f0-9]{24}$/i.test(String(s || '').trim());
  const siteName = (OMADA_SITE_NAME && OMADA_SITE_NAME.trim())
                || (looksLikeId(siteFromBody) ? '' : siteFromBody)
                || 'Default';
  const siteId = looksLikeId(siteFromBody) ? siteFromBody
             : looksLikeId(OMADA_SITE_ID) ? OMADA_SITE_ID
             : null;

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

  function truncate(obj, n = 500) {
    try {
      const s = typeof obj === 'string' ? obj : JSON.stringify(obj);
      return s.length > n ? s.slice(0, n) + '…' : s;
    } catch { return '(unserializable)'; }
  }
  function pickHeaders(h) {
    const out = {};
    for (const k of Object.keys(h || {})) {
      const lk = k.toLowerCase();
      if (['set-cookie','csrf-token','x-csrf-token','content-type','location'].includes(lk)) {
        out[k] = h[k];
      }
    }
    return out;
  }

  // ---------- PROBE: REDIS (env + connectivity + write test) ----------
  if (dbgProbe === 'redis') {
    try {
      const { getRedis } = await import('../lib/redis.js');
      const url = process.env.REDIS_URL || '';
      let host='(unknown)', port='(unknown)', db='0';
      try {
        const u = new URL(url);
        host = u.hostname || host;
        port = u.port || '(default)';
        const p = (u.pathname || '').replace(/^\//,'').trim();
        db = p || '0';
      } catch {}
      const r = await getRedis();
      const pong = await r.ping();
      const writeKey = `w2g:probe:${Date.now()}`;
      await r.set(writeKey, 'ok', { EX: 120 });
      const dbsize = Number(await r.sendCommand(['DBSIZE']));
      return res.status(200).json({
        ok: true,
        probe: 'redis',
        redis: { urlSet: !!url, host, port, db },
        ping: pong,
        writeKey,
        dbsize
      });
    } catch (e) {
      err('redis probe error', e?.message || e);
      return res.status(500).json({ ok: false, probe: 'redis', error: String(e?.message || e) });
    }
  }
  // -------------------------------------------------------------------

  // request validation
  if (!clientMacRaw || !siteId) {
    return res.status(400).json({ ok: false, error: !clientMacRaw ? 'Missing clientMac' : 'Missing Omada site id' });
  }
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

  // load time windows
  let planBasicSession;
  try {
    const tw = await import('../lib/timeWindows.js');
    const mod = tw.default || tw;
    planBasicSession = mod.planBasicSession;
    if (typeof planBasicSession !== 'function') throw new Error('planBasicSession missing');
  } catch (e) {
    err('Failed to load timeWindows.js:', e?.message || e);
    return res.status(500).json({ ok: false, error: 'Server config error: timeWindows' });
  }

  // redis
  let redis;
  try {
    const { getRedis } = await import('../lib/redis.js');
    log('Redis ping start');
    redis = await getRedis();
    await redis.set(`w2g:auth-ping:${clientMacRaw || 'unknown'}`, JSON.stringify({ when: new Date().toISOString(), site: siteName, siteId }), { EX: 300 });
  } catch (e) {
    console.error(`[authorize][${rid}] Redis connect error`, e?.message || e);
    return res.status(502).json({ ok: false, error: 'Redis unavailable' });
  }

  // Nexudus http
  const nx = axios.create({ baseURL: NEXUDUS_BASE?.replace(/\/+$/, ''), timeout: 15000, headers: { Accept: 'application/json', Authorization: NEX_AUTH || '' }, validateStatus: () => true });

  async function nxGetCoworkerByEmail(emailAddr) {
    const url = `/api/spaces/coworkers?Coworker_email=${encodeURIComponent(emailAddr)}&_take=1`;
    const r = await nx.get(url);
    log('Nexudus coworkers GET status', r.status, 'url', url);
    if (r.status !== 200) throw new Error(`Nexudus coworkers HTTP ${r.status}`);
    return r.data?.Records?.[0] || null;
  }
  async function nxGetActiveContracts(coworkerId) {
    const url = `/api/billing/coworkercontracts?coworkercontract_coworker=${encodeURIComponent(coworkerId)}&coworkercontract_active=true`;
    const r = await nx.get(url);
    log('Nexudus contracts GET status', r.status, 'url', url);
    if (r.status !== 200) throw new Error(`Nexudus contracts HTTP ${r.status}`);
    return Array.isArray(r.data?.Records) ? r.data.Records : [];
  }

  function toInt(v, d) { const n = Number(v); return Number.isFinite(n) ? Math.round(n) : d; }
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
  function creditKeys(cycleKey, coworkerId) {
    return { ledgerKey: `w2g:credits:${cycleKey}:${coworkerId}`, eventsKey: `w2g:ledger:${cycleKey}:${coworkerId}` };
  }
  async function getOrInitLedger(r, ledgerKey, seed) {
    const existing = await r.get(ledgerKey);
    if (existing) { try { return JSON.parse(existing); } catch {} }
    await r.set(ledgerKey, JSON.stringify(seed));
    return seed;
  }
  function centsForCharge(code) {
    if (code === 'daily') return toInt(BASIC_SESSION_CENTS, 500);
    if (code === 'after_hours') return toInt(BASIC_EXTEND_CENTS, 500);
    if (code === 'early') return toInt(BASIC_SESSION_CENTS, 500);
    return 0;
  }

  // Nexudus precheck
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
    return res.status(502).json({ ok: false, error: 'Nexudus precheck failed', detail: String(e?.message || e) });
  }

  const isBasic = hasBasic;
  let plan;
  try {
    const mod = await import('../lib/timeWindows.js');
    const fn = (mod.default && mod.default.planBasicSession) ? mod.default.planBasicSession : mod.planBasicSession;
    plan = isBasic
      ? await fn({ nowTs: Date.now(), extend: Boolean(extend) })
      : { allow: true, reason: 'Non Basic path', durationMs: 60 * 60 * 1000, charges: [], window: 'open' };
    if (!plan || !plan.allow) {
      return res.status(403).json({ ok: false, error: plan?.reason || 'Denied' });
    }
  } catch (e) {
    err('Time planner error:', e?.message || e);
    return res.status(500).json({ ok: false, error: 'Time planner failed' });
  }
  const totalRequiredCents = (plan.charges || []).reduce((sum, ch) => sum + centsForCharge(ch.code), 0);

  if (dbgProbe === 'nexudus') {
    log('Probe mode nexudus short circuit before Omada calls');
    return res.status(200).json({
      ok: true,
      probe: 'nexudus',
      coworkerId: coworker.Id,
      fullName: coworker.FullName,
      plans: { basic: hasBasic, classic: hasClassic, p247: has247 },
      window: plan.window,
      durationMs: plan.durationMs,
      charges: plan.charges,
      requiredCents: totalRequiredCents,
      siteId,
      siteName
    });
  }

  // credits preview and event seed
  try {
    const cycleKey = localCycleKey(new Date(), APP_TZ);
    const { ledgerKey, eventsKey } = creditKeys(cycleKey, coworker.Id);
    const seed = { coworkerId: coworker.Id, email, plan: isBasic ? 'basic' : (hasClassic ? 'classic' : (has247 ? '247' : 'other')), cycle: cycleKey, remainingCents: Number(BASIC_MONTHLY_CENTS), spentCents: 0, checkins: 0, lastUpdated: new Date().toISOString() };
    const ledger = await getOrInitLedger(redis, ledgerKey, seed);
    const currentCap = Number(ledger.remainingCents || 0) + Number(ledger.spentCents || 0);
    if (currentCap < Number(BASIC_MONTHLY_CENTS)) {
      const bump = Number(BASIC_MONTHLY_CENTS) - currentCap;
      ledger.remainingCents = Number(ledger.remainingCents || 0) + bump;
      ledger.lastUpdated = new Date().toISOString();
      await redis.set(ledgerKey, JSON.stringify(ledger));
    }
    if (isBasic && Number(ledger.remainingCents) < totalRequiredCents) {
      return res.status(402).json({ ok: false, error: 'Not enough credits for WiFi session' });
    }
    await redis.lPush(eventsKey, JSON.stringify({ when: new Date().toISOString(), type: 'preauth', clientMac: macToColons(clientMacRaw), apMac: macToColons(apMacRaw), ssidName, site: siteName, siteId, preview: true }));
  } catch (e) {
    err('Ledger preview error', e?.message || e);
  }

  // controller login and auth
  function makeClient(purpose) {
    const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: false, maxSockets: 1 });
    const headers = {
      Accept: 'application/json,text/html;q=0.9,*/*;q=0.1',
      'User-Agent': `w2g-splash-${purpose}/${Math.random().toString(36).slice(2,7)}`,
      Connection: 'close',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
      'Accept-Language': 'en-US,en;q=0.9'
    };
    if (purpose === 'login') { headers['Origin'] = base; headers['Referer'] = PORTAL_URL; }
    return axios.create({ timeout: 15000, httpsAgent: agent, headers, validateStatus: () => true, maxRedirects: 0 });
  }

  async function controllerLogin() {
    const warm = await makeClient('warmup').get(PORTAL_URL);
    const warmCookies = warm.headers?.['set-cookie'] || [];
    const cookieHeader = warmCookies.length ? { Cookie: warmCookies.map(c => String(c).split(';')[0]).join('; ') } : {};

    let loginStatus = null, token = null, setCookie = warmCookies;
    for (const loginUrl of [LOGIN_URL_STD, LOGIN_URL_ALT]) {
      const resp = await makeClient('login').post(
        loginUrl,
        { name: OMADA_OPERATOR_USER, password: OMADA_OPERATOR_PASS },
        { headers: { 'Content-Type': 'application/json', ...cookieHeader } }
      );
      loginStatus = resp.status;
      const hdrs = resp.headers || {};
      token = hdrs['csrf-token'] || hdrs['Csrf-Token'] || resp.data?.result?.token || null;
      if (token) { setCookie = resp.headers?.['set-cookie'] || setCookie; break; }
    }
    return { token, setCookie, status: loginStatus };
  }

  const loginState = await controllerLogin();
  if (!loginState || !loginState.token) {
    return res.status(502).json({ ok: false, error: 'Hotspot login failed', detail: 'controller login did not produce token' });
  }

  const csrf = loginState.token;
  const loginCookies = loginState.setCookie || [];
  const baseAuthHeaders = {
    Cookie: loginCookies.map(c => String(c).split(';')[0]).join('; '),
    'Csrf-Token': csrf,
    'X-Csrf-Token': csrf,
    'X-Requested-With': 'XMLHttpRequest',
    'Origin': base,
    'Referer': PORTAL_URL,
    Accept: 'application/json'
  };
  const httpsAgentAuth = new https.Agent({ rejectUnauthorized: false, keepAlive: false, maxSockets: 1 });
  const httpAuth = axios.create({ timeout: 15000, httpsAgent: httpsAgentAuth, headers: { Accept: 'application/json' }, validateStatus: () => true });

  const postJson = async (url, json, headers = {}) => {
    const resp = await httpAuth.post(url, json, { headers: { 'Content-Type': 'application/json', ...headers } });
    return { data: resp.data, status: resp.status };
  };

  const timeMsBase = Math.max(60000, Number((await import('../lib/timeWindows.js')).planBasicSession ? plan.durationMs : 60000) || 60000);
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
    return res.status(502).json({ ok: false, error: 'Authorization failed', detail: last.data, attempt: last.note, attempts: authAttempts });
  }

  // success write backs
  const nowIso = new Date().toISOString();
  const dateKey = localDateKey(new Date(), APP_TZ);
  try {
    await redis.set(
      `w2g:session:${macPlainLower(clientMacRaw)}`,
      JSON.stringify({ when: nowIso, coworkerId: coworker.Id, email, ssidName, siteId, siteName, cutoff: new Date(Date.now() + (plan.durationMs || 60000)).toISOString(), window: plan.window }),
      { EX: 6 * 3600 }
    );
  } catch (e) {
    err('Session write error', e?.message || e);
  }
  try {
    await redis.lPush(`w2g:events:${dateKey}`, JSON.stringify({ when: nowIso, type: 'authorize', coworkerId: coworker.Id, email, clientMac: macToColons(clientMacRaw), apMac: macToColons(apMacRaw), ssidName, site: siteName, siteId, window: plan.window }));
  } catch (e) {
    err('Events write error', e?.message || e);
  }
  try {
    if (isBasic) {
      await redis.incr(`w2g:debits:${dateKey}:${coworker.Id}`);
    }
  } catch (e) {
    err('Debit counter error', e?.message || e);
  }

  const includeDebug = dbg.enabled ? {
    omada: {
      login: { status: loginState?.status || null, tokenPresent: !!loginState?.token, cookies: (loginState?.setCookie || []).length },
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
