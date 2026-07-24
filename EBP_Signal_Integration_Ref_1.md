# EBP Tracker — Trade Journal Signal Integration
**Reference Document v1.0 — July 2026**  
**Purpose:** Infrastructure changes required on EBP Tracker to support Trade Journal signal linking  
**Companion app:** Trade Journal (Supabase backend, vanilla JS SPA, Cloudflare Pages)

---

## Context

The Trade Journal is a separate application with its own Supabase database and auth system. It tracks trade entries, closures, win rates, and R-multiples. The goal is to link EBP Tracker signals to Trade Journal trade outcomes so that win rates and R-multiples can be analysed per signal template (T1/T2/T3/T4) over time.

**The Trade Journal is the analytics hub.** Not all EBP signals will be traded — user discretion applies. Only signals the user chooses to trade will be linked. The link is made at trade closure, not at trade entry.

---

## How the Link Works (User Flow)

```
EBP fires T3/T4 signal
        ↓
Telegram message includes Signal ID (e.g. "T3-EURUSD-A4K2")
        ↓
User decides to trade it (or not) — no action required yet
        ↓
Trade executes and closes
        ↓
User opens Close Trade modal in Trade Journal (Intraday section)
        ↓
"Was this a signal-based trade?" → YES
User enters Signal ID from Telegram message
        ↓
Trade Journal fetches signal details from EBP Worker
Signal details stored on trade row in Supabase
EBP D1 signals table updated: traded = 1
        ↓
Analytics: win rate / R-multiple per template — all in Supabase
```

---

## Signal ID Format

**Format:** `{TEMPLATE}-{PAIR}-{4-CHAR-RANDOM}`  
**Examples:** `T3-EURUSD-A4K2` · `T4-XAUUSD-M9PQ` · `T1-GBPUSD-K2NR`

Rules:
- Template prefix: `T1` / `T2` / `T3` / `T4`
- Pair: normalised uppercase, no slash (e.g. `EURUSD` not `EUR/USD`)
- 4-char suffix: uppercase alphanumeric, randomly generated at signal fire time
- Full ID is unique enough for personal-use signal volume
- Human readable in Telegram — user can identify template + pair at a glance before typing it

**Status: Format not finalised — to be confirmed during EBP Tracker build.**  
Trade Journal accepts any free-text signal ID format — no format dependency on Journal side.

---

## D1 Schema Change — New `signals` Table

```sql
CREATE TABLE IF NOT EXISTS signals (
  signal_id      TEXT PRIMARY KEY,
  template_type  TEXT NOT NULL,     -- 'T1' | 'T2' | 'T3' | 'T4'
  symbol         TEXT NOT NULL,     -- e.g. 'EURUSD'
  htf_tf         TEXT,              -- e.g. '4H' — higher timeframe in chain
  ltf_tf         TEXT,              -- e.g. 'M15' — lower timeframe confirmation
  direction      TEXT,              -- 'BULL' | 'BEAR'
  fired_at       TEXT NOT NULL,     -- ISO 8601 timestamp (UTC)
  traded         INTEGER DEFAULT 0  -- 0 = not traded, 1 = linked to a Journal trade
);
```

**Notes:**
- Insert one row per signal at alert fire time
- `traded` flag updated to 1 by Trade Journal after user links the signal at closure
- No `user_id` column needed — personal use, single user
- Table is append-only from EBP Worker side; Trade Journal only PATCHes `traded`

---

## EBP Worker Changes

### 1. Generate Signal ID at Alert Fire

At the point where T3 (and T4, T1, T2 when built) Telegram alert is assembled:

```javascript
function generateSignalId(templateType, symbol) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I ambiguity
  let suffix = '';
  for (let i = 0; i < 4; i++) {
    suffix += chars[Math.floor(Math.random() * chars.length)];
  }
  const normSymbol = symbol.replace('/', '').toUpperCase(); // EUR/USD → EURUSD
  return `${templateType}-${normSymbol}-${suffix}`;
}
```

### 2. Insert into `signals` Table at Fire Time

After generating signal ID, before sending Telegram message:

```javascript
await env.DB.prepare(`
  INSERT INTO signals (signal_id, template_type, symbol, htf_tf, ltf_tf, direction, fired_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`)
.bind(signalId, templateType, symbol, htfTf, ltfTf, direction, new Date().toISOString())
.run();
```

### 3. Append Signal ID to Telegram Message

Add to the bottom of existing T3/T4 alert format:

```
🔗 Signal ID: T3-EURUSD-A4K2
```

### 4. New Route — `GET /signals/:id`

Returns signal details to Trade Journal when user enters a Signal ID.

```
GET /signals/:id
Headers: X-Journal-Secret: <shared_secret>
Response: 200 { signal_id, template_type, symbol, htf_tf, ltf_tf, direction, fired_at, traded }
Response: 404 { error: "Signal not found" }
Response: 401 { error: "Unauthorised" }
```

Implementation:
```javascript
if (req.method === 'GET' && path.startsWith('/signals/')) {
  const secret = req.headers.get('X-Journal-Secret');
  if (secret !== env.JOURNAL_API_SECRET) {
    return new Response(JSON.stringify({ error: 'Unauthorised' }), { status: 401 });
  }
  const signalId = path.replace('/signals/', '');
  const row = await env.DB.prepare('SELECT * FROM signals WHERE signal_id = ?')
    .bind(signalId).first();
  if (!row) return new Response(JSON.stringify({ error: 'Signal not found' }), { status: 404 });
  return new Response(JSON.stringify(row), { 
    status: 200, 
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}
```

### 5. New Route — `PATCH /signals/:id/traded`

Called by Trade Journal after user links a signal to a closed trade.

```
PATCH /signals/:id/traded
Headers: X-Journal-Secret: <shared_secret>
Response: 200 { ok: true }
Response: 404 { error: "Signal not found" }
Response: 401 { error: "Unauthorised" }
```

Implementation:
```javascript
if (req.method === 'PATCH' && path.match(/^\/signals\/[^/]+\/traded$/)) {
  const secret = req.headers.get('X-Journal-Secret');
  if (secret !== env.JOURNAL_API_SECRET) {
    return new Response(JSON.stringify({ error: 'Unauthorised' }), { status: 401 });
  }
  const signalId = path.split('/')[2];
  const result = await env.DB.prepare(
    'UPDATE signals SET traded = 1 WHERE signal_id = ?'
  ).bind(signalId).run();
  if (result.changes === 0) {
    return new Response(JSON.stringify({ error: 'Signal not found' }), { status: 404 });
  }
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
}
```

### 6. CORS — OPTIONS Preflight

Trade Journal is a browser app. Add OPTIONS handler for both new routes:

```javascript
if (req.method === 'OPTIONS') {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, PATCH, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Journal-Secret'
    }
  });
}
```

---

## Wrangler Secret

Add one new secret to the EBP Worker:

```bash
npx wrangler secret put JOURNAL_API_SECRET --name ebp-tracker-worker
```

**Value:** Generate a strong random string (32+ chars). Example generation:
```bash
openssl rand -hex 32
```

This same value is pasted into Trade Journal Settings → EBP Tracker Integration → API Secret field. Stored in Trade Journal's localStorage. Never exposed in code.

---

## Which Templates Get Signal IDs

| Template | Signal ID now | Notes |
|---|---|---|
| T3 | ✅ Yes | Live in production — implement immediately |
| T4 | ✅ Yes | Live in production — implement immediately |
| T1 | 📋 When built | Phase E in roadmap — add signal ID at build time |
| T2 | 📋 When built | Phase G in roadmap — add signal ID at build time |

---

## What Trade Journal Will Do (for EBP Tracker awareness)

These changes happen on the Trade Journal side — listed here so EBP Tracker build can be verified against expected behaviour:

1. **New Supabase columns** on `trades` table:
   - `signal_id TEXT` — stores the signal ID string
   - `signal_data JSONB` — stores full signal object snapshot (so data persists even if EBP D1 is cleared)

2. **Intraday Close Modal** — new section:
   - Radio: "Was this a signal-based trade?" Yes / No
   - Yes → Signal ID text input + fetch button
   - Fetch button → calls `GET /signals/:id` on EBP Worker
   - Renders signal summary: template, pair, direction, HTF/LTF chain, fired time
   - On save → stores signal_id + signal_data on trade, calls `PATCH /signals/:id/traded`

3. **Settings page** — new EBP Integration card:
   - Worker URL field (base URL of EBP Worker)
   - API Secret field (masked, matches `JOURNAL_API_SECRET` Wrangler secret)
   - Test Connection button → calls `GET /signals/TEST` and expects a 404 (confirms auth works)

---

## Verification Checklist (After EBP Build)

- [ ] T3 alert fires → row appears in `signals` D1 table with correct fields
- [ ] T4 alert fires → row appears in `signals` D1 table with correct fields
- [ ] Telegram message includes Signal ID line at bottom
- [ ] `GET /signals/:id` with correct secret → returns signal JSON
- [ ] `GET /signals/:id` with wrong secret → returns 401
- [ ] `GET /signals/INVALID` with correct secret → returns 404
- [ ] `PATCH /signals/:id/traded` with correct secret → `traded` flips to 1 in D1
- [ ] CORS preflight (OPTIONS) returns correct headers

---

## Build Sequence

```
1. Add signals table to schema.sql + run against live D1
2. Add generateSignalId() function to ebp-worker.js
3. Wire signal ID generation + D1 insert into T3 alert fire path
4. Wire signal ID generation + D1 insert into T4 alert fire path  
5. Append Signal ID line to Telegram message format (T3 + T4)
6. Add GET /signals/:id route
7. Add PATCH /signals/:id/traded route
8. Add OPTIONS preflight handler for both routes
9. Add JOURNAL_API_SECRET via wrangler secret put
10. Deploy worker
11. Fire a test T3/T4 signal → verify D1 row + Telegram message
12. Test GET /signals/:id via curl/Postman with correct secret
13. Hand secret value to Trade Journal Settings
```

---

*Reference v1.0 — July 2026*  
*Covers EBP Tracker infrastructure changes only. Trade Journal changes are handled separately in Trade Journal planning chat.*  
*Signal ID format subject to change — Trade Journal accepts any free-text format.*
