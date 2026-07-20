/**
 * DST-aware market schedule helpers (UTC).
 * US DST: second Sunday March → first Sunday November
 * UK DST: last Sunday March → last Sunday October
 */

function nthSundayUTC(year, month, n) {
  // n=1 first, n=-1 last
  if (n > 0) {
    const d = new Date(Date.UTC(year, month, 1));
    d.setUTCDate(1 + ((7 - d.getUTCDay()) % 7));
    d.setUTCDate(d.getUTCDate() + (n - 1) * 7);
    return d;
  } else {
    const d = new Date(Date.UTC(year, month + 1, 0));
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay()) % 7));
    return d;
  }
}

function isUSDST(date) {
  const y = date.getUTCFullYear();
  const start = nthSundayUTC(y, 2, 2); start.setUTCHours(7);  // 2am ET = 7am UTC
  const end   = nthSundayUTC(y, 10, 1); end.setUTCHours(6);
  return date >= start && date < end;
}

/**
 * Returns the UTC offset (hours) for US Eastern at a given date.
 */
export function getETOffset(date = new Date()) {
  return isUSDST(date) ? -4 : -5;
}

/**
 * NYSE / Nasdaq: Mon–Fri 09:30–16:00 ET (14:30–21:00 UTC during EST, 13:30–20:00 UTC during EDT)
 * Returns true if `date` is within regular trading hours.
 */
export function isUSMarketOpen(date = new Date()) {
  const dow = date.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  const offset = getETOffset(date);
  const etH = date.getUTCHours() + offset;
  const etM = date.getUTCMinutes();
  const etMins = etH * 60 + etM;
  return etMins >= 9 * 60 + 30 && etMins < 16 * 60;
}

/**
 * NSE (India): Mon–Fri 09:15–15:30 IST (IST = UTC+5:30, no DST)
 */
export function isNSEMarketOpen(date = new Date()) {
  const dow = date.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  const istMins = (date.getUTCHours() * 60 + date.getUTCMinutes()) + 330;
  const local   = istMins % (24 * 60);
  return local >= 9 * 60 + 15 && local < 15 * 60 + 30;
}

/**
 * Forex / crypto: always open (24/7). Included for completeness.
 */
export function isForexOpen() { return true; }
