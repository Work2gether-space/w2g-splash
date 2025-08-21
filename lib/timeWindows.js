// lib/timeWindows.js
// Encodes Basic member access rules in US Eastern time.
// Returns a plan so authorize.js can allow, timebox, and charge.
// Exports as CommonJS for your current setup.

const ET_TZ = "America/New_York";

// Fixed boundaries in minutes since midnight ET
const EARLY_START_MIN = 8 * 60 + 50;   // 8:50
const DAY_END_MIN     = 16 * 60 + 10;  // 4:10
const HARD_CUTOFF_MIN = 17 * 60 + 15;  // 5:15

function getEtMinutesSinceMidnight(ts = Date.now()) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: ET_TZ,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = fmt.formatToParts(new Date(ts));
  const map = {};
  for (const p of parts) {
    if (p.type !== "literal") map[p.type] = parseInt(p.value, 10);
  }
  const h = Number.isFinite(map.hour) ? map.hour : 0;
  const m = Number.isFinite(map.minute) ? map.minute : 0;
  return h * 60 + m;
}

function minutesUntil(targetMin, nowMin) {
  return Math.max(0, targetMin - nowMin);
}

/**
 * Plan a Basic session based on current ET time and whether this is an extend.
 *
 * Returns an object:
 * {
 *   allow: boolean,
 *   reason: string,
 *   durationMs: number,          // how long to authorize this session
 *   charges: [                   // debits to apply now
 *     { code: "early"|"daily"|"after_hours", amount: 5, label: string }
 *   ],
 *   window: "early"|"day"|"after"|"closed"
 * }
 */
function planBasicSession({ nowTs = Date.now(), extend = false } = {}) {
  const nowMin = getEtMinutesSinceMidnight(nowTs);

  // Hard close after 5:15
  if (nowMin >= HARD_CUTOFF_MIN) {
    return {
      allow: false,
      reason: "Access ends at 5:15 pm",
      durationMs: 0,
      charges: [],
      window: "closed",
    };
  }

  // Extend requests
  if (extend) {
    if (nowMin < DAY_END_MIN) {
      return {
        allow: false,
        reason: "Extend is available after 4:10 pm",
        durationMs: 0,
        charges: [],
        window: "day",
      };
    }
    // After 4:10 and before 5:15
    const toHardCut = minutesUntil(HARD_CUTOFF_MIN, nowMin);
    const durationMin = Math.min(60, toHardCut); // up to 60 minutes, never past 5:15
    if (durationMin <= 0) {
      return {
        allow: false,
        reason: "Access ends at 5:15 pm",
        durationMs: 0,
        charges: [],
        window: "closed",
      };
    }
    return {
      allow: true,
      reason: "After hours extend",
      durationMs: durationMin * 60 * 1000,
      charges: [{ code: "after_hours", amount: 5, label: "After hours 4:10 to 5:15" }],
      window: "after",
    };
  }

  // First time authorize in a day
  if (nowMin < EARLY_START_MIN) {
    // Before 8:50. Allow login, charge early plus daily, run until 4:10.
    const toDayEnd = minutesUntil(DAY_END_MIN, nowMin);
    if (toDayEnd <= 0) {
      return {
        allow: false,
        reason: "Try again shortly",
        durationMs: 0,
        charges: [],
        window: "early",
      };
    }
    return {
      allow: true,
      reason: "Early access before 8:50. Daily will also apply",
      durationMs: toDayEnd * 60 * 1000,
      charges: [
        { code: "early", amount: 5, label: "Early access before 8:50" },
        { code: "daily", amount: 5, label: "Day access 9:00 to 4:10" },
      ],
      window: "early",
    };
  }

  if (nowMin < DAY_END_MIN) {
    // Between 8:50 and 4:10. Charge daily and run until 4:10.
    const toDayEnd = minutesUntil(DAY_END_MIN, nowMin);
    return {
      allow: true,
      reason: "Day access",
      durationMs: toDayEnd * 60 * 1000,
      charges: [{ code: "daily", amount: 5, label: "Day access 9:00 to 4:10" }],
      window: "day",
    };
  }

  // Between 4:10 and 5:15. Charge after hours and allow up to 60 minutes, never beyond 5:15.
  const toHardCut = minutesUntil(HARD_CUTOFF_MIN, nowMin);
  const durationMin = Math.min(60, toHardCut);
  if (durationMin <= 0) {
    return {
      allow: false,
      reason: "Access ends at 5:15 pm",
      durationMs: 0,
      charges: [],
      window: "closed",
    };
  }
  return {
    allow: true,
    reason: "After hours access",
    durationMs: durationMin * 60 * 1000,
    charges: [{ code: "after_hours", amount: 5, label: "After hours 4:10 to 5:15" }],
    window: "after",
  };
}

module.exports = {
  ET_TZ,
  EARLY_START_MIN,
  DAY_END_MIN,
  HARD_CUTOFF_MIN,
  planBasicSession,
};
