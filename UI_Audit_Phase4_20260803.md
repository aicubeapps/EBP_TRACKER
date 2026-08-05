# UI Audit — AssetCard & Config Panels
**Scope:** `AssetCard.jsx`, `EBPConfigPanel.jsx`, `SweepConfigPanel.jsx`, `AIAlertsPanel.jsx`, `TdiConfigPanel.jsx`, `SmaConfigPanel.jsx`, `BiasOverridePanel.jsx`, `Dashboard.jsx`, `useAssets.js`
**Method:** Read-only, full-file reads plus cross-reference against `schema.sql` and `frontend/src/lib/constants.js` / `api.js`. No source file modified.

---

## 1. AssetCard — full render inventory

**File:** `frontend/src/components/AssetCard.jsx` — **152 lines**.

### Top-level structure

A single `<div className="card">` per asset. No internal tabs — every alert-type section is a stacked `check-row` + conditionally-rendered panel, always in the same vertical order regardless of asset type. There is no true "collapsed vs expanded" card-level state; each alert-type panel expands/collapses independently based on its own checkbox.

```jsx
return (
  <div className="card">
    <div className="card-header"> ... symbol, badge, remove button ... </div>
    {lastAlert && ( ... )}
    {/* EBP Alerts */}
    <div className="check-row"> ...checkbox... {ebpEnabled && <override-btn>} </div>
    {ebpEnabled && showBiasOverride && <BiasOverridePanel .../>}
    {ebpEnabled && <EBPConfigPanel .../>}
    {/* Sweep Alerts */}
    <div className="check-row"> ... </div>
    {sweepEnabled && <SweepConfigPanel .../>}
    {/* AI Alerts */}
    <div className="check-row"> ... </div>
    {aiEnabled && <AIAlertsPanel .../>}
    {isNse && ( <> TDI checkbox+panel, SMA checkbox+panel </> )}
    {isForex && ( <> SMA checkbox+panel (ForexSmaConfigPanel) </> )}
  </div>
);
```

The "expand/collapse" mechanism per section is literally a checkbox bound to local state (`ebpEnabled`, `sweepEnabled`, etc.) — checking it does **not** call any API to create a config; it only reveals the panel below it. The panel itself is what creates configs via its own "+ Add ... Alert" button. This means the checkbox states are purely a **derived display flag** initialized from whether any config already exists (see `fetchSummary` below) — checking the box with zero configs underneath just exposes an empty panel with an "Add" button; nothing is persisted by the checkbox itself.

### Data fetched

`fetchSummary` (in a `useCallback`) fires 7 parallel requests via `Promise.allSettled`:

```js
const [ebp, swp, tmpl, hist, bias, ind, forexSma] = await Promise.allSettled([
  api.get(`/user/ebp-configs/${asset.id}`, token),
  api.get(`/user/sweep-configs/${asset.id}`, token),
  api.get(`/user/templates/${asset.id}`, token),
  api.get(`/alerts/history?assetId=${asset.id}&days=2&limit=1`, token),
  api.get(`/user/bias/${encodeURIComponent(asset.symbol)}`, token),
  isNse ? api.get(`/user/nse-indicator-configs/${asset.id}`, token) : Promise.resolve([]),
  isForex ? api.get(`/user/forex-indicator-configs/${asset.id}`, token) : Promise.resolve([]),
]);
```

Polling interval: **every 60,000ms (60s)**, via:
```js
useEffect(() => {
  fetchSummary();
  const id = setInterval(fetchSummary, 60000);
  return () => clearInterval(id);
}, [fetchSummary]);
```
This means **every rendered AssetCard on the Dashboard independently polls all 7 endpoints every 60s** — there is no shared/batched fetch across cards. On a Dashboard with N assets, that's `7×N` requests per minute.

### Collapsed vs expanded state

"Collapsed" (always-visible) state per card:
- Symbol + asset-type badge + remove button (header)
- Last alert line (`Last: {DIRECTION} {ALERT_TYPE} {TF} — {time}`), clickable → navigates to `/alerts`, shown only if `lastAlert` is set
- 3–5 checkbox rows (EBP / Sweep / AI / [TDI + SMA if NSE] / [SMA if forex])

"Expanded" per-section state — each panel only mounts when its checkbox is checked:
- `ebpEnabled` → `BiasOverridePanel` (only if `showBiasOverride` toggled) + `EBPConfigPanel`
- `sweepEnabled` → `SweepConfigPanel`
- `aiEnabled` → `AIAlertsPanel`
- `tdiEnabled` (NSE only) → `TdiConfigPanel`
- `smaEnabled` (NSE or forex/crypto/commodity) → `SmaConfigPanel` (NSE) or `ForexSmaConfigPanel` (forex/crypto/commodity)

### Panels rendered inside AssetCard, in render order

1. `BiasOverridePanel` (conditional: `ebpEnabled && showBiasOverride`)
2. `EBPConfigPanel` (conditional: `ebpEnabled`)
3. `SweepConfigPanel` (conditional: `sweepEnabled`)
4. `AIAlertsPanel` (conditional: `aiEnabled`)
5. `TdiConfigPanel` (conditional: `isNse && tdiEnabled`)
6. `SmaConfigPanel` (conditional: `isNse && smaEnabled`)
7. `ForexSmaConfigPanel` (conditional: `isForex && smaEnabled`) — imported but **not in the file list this audit was scoped to**; noted here only because it's directly wired into AssetCard's render tree and materially answers the NSE-vs-forex question below. Not independently audited.

### NSE vs forex/crypto handling

Two boolean flags gate everything:
```js
const isNse   = asset.asset_type === 'nse';
const isForex = ['forex', 'crypto', 'commodity'].includes(asset.asset_type);
```

- `isNse` and `isForex` are mutually exclusive for any given asset (no `asset_type` value satisfies both), so exactly one of the two trailing `<>` blocks renders — never both, never neither (unless `asset_type` is something else entirely, e.g. `'system'` for DXY, in which case **neither** TDI/SMA block renders — DXY gets no indicator alerts at all).
- `fetchSummary` conditionally fetches `/user/nse-indicator-configs/:id` only `if (isNse)`, and `/user/forex-indicator-configs/:id` only `if (isForex)` — the other request resolves to `Promise.resolve([])` (never actually calls the API), so it always "succeeds" with an empty array and skips the corresponding `setTdiEnabled`/`setSmaEnabled` update for the wrong branch.
- **Bug/smell — duplicate DOM `id`:** Both the `isNse` SMA checkbox and the `isForex` SMA checkbox use the identical template `id={`sma-${asset.id}`}`:
  ```jsx
  {/* inside isNse block */}
  <input type="checkbox" id={`sma-${asset.id}`} checked={smaEnabled} .../>
  ...
  {/* inside isForex block */}
  <input type="checkbox" id={`sma-${asset.id}`} checked={smaEnabled} .../>
  ```
  Since the two blocks are mutually exclusive at render time this causes no live collision today, but it's fragile — if `asset_type` logic is ever loosened (e.g. an asset satisfying both conditions), React would render two elements with the same `id`, breaking the `<label htmlFor>` association for one of them.
- Both `isNse` and `isForex` share the **same state variables** (`tdiEnabled`/`smaEnabled`) — there's only one `smaEnabled` boolean total per card, not per-branch. This is harmless since only one branch ever mounts, but it's implicit coupling: renaming/adding a third SMA-capable asset type later would require checking this sharing doesn't leak state between branches.

### CSS / layout approach

Flexbox throughout, backed by CSS custom-property design tokens (no grid usage found in the audited classes). From `global.css`:
```css
.card { background: var(--surface); border: 1.5px solid var(--border); border-radius: var(--radius-lg); padding: var(--sp-md); }
.card-header { display: flex; align-items: center; gap: var(--sp-sm); margin-bottom: var(--sp-md); }
.check-row { display: flex; align-items: center; gap: var(--sp-sm); margin-bottom: var(--sp-sm); }
.config-panel { margin-left: 24px; margin-top: var(--sp-sm); padding: var(--sp-sm) var(--sp-md); background: var(--cream); }
.config-row { display: flex; align-items: center; gap: var(--sp-sm); margin-bottom: var(--sp-sm); }
```
Asset-type badge color is resolved by string-templating the class name: `className={`badge badge-${assetTypeBadge}`}` where `assetTypeBadge = (asset.asset_type ?? 'forex').toLowerCase().replace(/\s/g, '_')`. Matching CSS exists for `forex`, `crypto`, `nse`, `system`, `commodity` — all `asset_type` values actually producible by the backend have a styled badge; no unstyled-badge gap found.

A mobile breakpoint restyles `.config-row` to `flex-wrap: wrap` and reduces `.card` padding to `12px`.

### Dead / commented-out code

None found. No `// TODO`, no commented-out JSX blocks, no unreachable branches. The only two structural smells are the duplicate-`id` issue above and the fact that `smaEnabled` is shared across the mutually-exclusive NSE/forex branches (both are latent risks, not currently dead/broken code).

---

## 2. EBPConfigPanel — exact structure

**File:** `frontend/src/components/EBPConfigPanel.jsx` — **122 lines**.

### One config row

```jsx
<div key={cfg.id} className="config-row">
  <select className="select-sm" value={cfg.timeframe} onChange={e => updateTimeframe(cfg.id, e.target.value)}>
    {tfOptions.map(tf => <option key={tf} value={tf}>{tf}</option>)}
  </select>
  <select className="select-sm" value={cfg.alert_mode} onChange={e => updateConfig(cfg.id, 'alert_mode', e.target.value)}>
    {ALERT_MODES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
  </select>
  {HTF_OVERRIDE_OPTIONS[cfg.timeframe] && (
    <select className="select-sm" value={biasTF} onChange={e => updateConfig(cfg.id, 'htf_override', e.target.value)}>
      {HTF_OVERRIDE_OPTIONS[cfg.timeframe].map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )}
  {biasTF && <span className="bias-label">Bias: {capitalise(bias)} ({biasTF})</span>}
  <button className="icon-btn" onClick={() => deleteConfig(cfg.id)}>✕</button>
</div>
```
Fields per row: **Timeframe select, Alert Mode select (`aligned`/`price_action`/`all`), conditional HTF-override select (1H/4H only), a read-only live bias label, delete button.** No `enabled`/disabled toggle exists in this panel (unlike Sweep/TDI/SMA panels — see gap in §9).

### How many configs per asset

One config **per distinct timeframe** — `addConfig` explicitly finds `tfOptions.find(t => !configs.some(c => c.timeframe === t))`, and once `tfOptions.length === configs.length` the "+ Add EBP Alert" button is replaced by the "no timeframes enabled" message (or simply the add button disappears if all are used — the code path is `tfOptions.length > 0 ? <button/> : <p>...</p>`, but there's no distinct "all TFs already configured" message — it reuses the same "No timeframes enabled for your account" copy regardless of whether the cause is zero `allowedTfs` or all-TFs-already-used). So: up to `tfOptions.length` configs per asset (5 for forex, 6 for NSE).

### TF options — filtering

```js
const fullTfOptions = assetType === 'nse' ? NSE_EBP_TFS : EBP_TFS;
const tfOptions = allowedTfs ? fullTfOptions.filter(tf => allowedTfs.includes(tf)) : fullTfOptions;
```
- `EBP_TFS = ['M15', '1H', '4H', 'D', 'W']` (forex/crypto/commodity)
- `NSE_EBP_TFS = ['M1', 'M5', 'M15', 'M30', '1H', 'D']`
- Filtered by `allowedTfs`, which AssetCard passes through from Dashboard's `userTfAccess`/`userNseTfAccess` (parsed from `user.user_tf_access` / `user.nse_tf_access`, admin-controlled JSON arrays). When `allowedTfs` is `null` (still loading), filtering is skipped entirely (comment: *"skip filtering rather than showing a false 'no timeframes enabled' state"*).

### API calls

- `GET /user/ebp-configs/:assetId` — on mount (`fetchConfigs`)
- `POST /user/ebp-configs/:assetId` `{ timeframe, alert_mode: 'aligned' }` — on "+ Add EBP Alert"
- `PATCH /user/ebp-configs/:id` `{ [field]: value }` — on alert-mode or HTF-override change
- `PATCH /user/ebp-configs/:id` `{ timeframe: newTf }` — on timeframe change (separate function `updateTimeframe`, which also **locally** resets `htf_override: null` to mirror the server-side reset, per its own comment)
- `DELETE /user/ebp-configs/:id` — on ✕ click

### All-or-nothing vs per-TF

Per-TF, not all-or-nothing. Each row is an independent config with its own `enabled`... **except there is no `enabled` field exposed in this panel at all** — every created config is implicitly always-on (deleting the row is the only way to disable a TF). This differs from Sweep/TDI/SMA panels, which all expose an Enabled/Disabled select. See §9.

### EBP TF ↔ Sweep TF linkage

**No linkage.** `EBP_TFS = ['M15', '1H', '4H', 'D', 'W']` does not include `'M30'`; `SWEEP_TFS = ['M15', 'M30', '1H', '4H']` does not include `'D'`/`'W'`. These are two independently-fetched, independently-rendered, independently-added/removed config lists (`user_ebp_configs` and `user_sweep_configs` are separate tables with no foreign key between rows). A user can have a Sweep M30 alert with **no possible corresponding EBP M30 config** (EBP doesn't offer M30 at all), and vice versa for EBP's D/W (Sweep doesn't offer those).

---

## 3. SweepConfigPanel — exact structure

**File:** `frontend/src/components/SweepConfigPanel.jsx` — **122 lines**. Structurally close to identical to EBPConfigPanel (same author pattern, same helper functions duplicated per-file rather than shared).

### One config row
Identical shape to EBP's row: Timeframe select, Alert Mode select, conditional HTF-override select, live bias label, delete button. Same `ALERT_MODES` values (`aligned`/`price_action`/`all`). No `enabled` toggle here either.

### Configs per asset
Same pattern as EBP: one per distinct TF, up to `tfOptions.length` (4 for forex `SWEEP_TFS`, 6 for NSE `NSE_SWEEP_TFS`).

### TF options
```js
const fullTfOptions = assetType === 'nse' ? NSE_SWEEP_TFS : SWEEP_TFS;
const tfOptions = allowedTfs ? fullTfOptions.filter(tf => allowedTfs.includes(tf)) : fullTfOptions;
```
- `SWEEP_TFS = ['M15', 'M30', '1H', '4H']`
- `NSE_SWEEP_TFS = ['M1', 'M5', 'M15', 'M30', '1H', 'D']`
Same `allowedTfs`-gated filtering as EBP, same null-skip-filter behavior while loading.

### API calls
- `GET /user/sweep-configs/:assetId`
- `POST /user/sweep-configs/:assetId` `{ timeframe, alert_mode: 'aligned' }`
- `PATCH /user/sweep-configs/:id` `{ [field]: value }` (alert_mode / htf_override)
- `PATCH /user/sweep-configs/:id` `{ timeframe: newTf }` (separate `updateTimeframe`, same local `htf_override: null` reset mirroring)
- `DELETE /user/sweep-configs/:id`

### Independence from EBP
Fully independent — separate fetch, separate state array, separate endpoints, separate table. The UI does not imply they must match (no shared row, no cross-referencing of EBP's configs from within SweepConfigPanel or vice versa).

### HTF override options in the UI
```js
const HTF_OVERRIDE_OPTIONS = {
  '1H': [{ value: '4H', label: '4H' }, { value: 'D', label: 'Daily' }],
  '4H': [{ value: 'D',  label: 'Daily' }, { value: 'W', label: 'Weekly' }],
};
```
Identical constant (independently defined, not imported/shared) to the one in EBPConfigPanel. Only `1H` and `4H` rows get a visible HTF-override select; M15/M30/D/W stay fixed to `BIAS_SOURCE_FRONTEND`'s default with no override control shown.

---

## 4. AIAlertsPanel — current template UI

**File:** `frontend/src/components/AIAlertsPanel.jsx` — **120 lines**.

### T1–T4 rendering
```js
const TEMPLATES = [
  { id: 't1', label: 'T1', description: 'HTF FVG → Price at zone → LTF confirmation' },
  { id: 't2', label: 'T2', description: 'HTF EBP → LTF FVG retracement → LTF MSS' },
  { id: 't3', label: 'T3', description: 'HTF EBP → LTF Sweep → LTF MSS', comingSoon: false },
  { id: 't4', label: 'T4', description: 'HTF Sweep → HTF FVG pullback → LTF MSS' },
];
```
Each renders as a checkbox + label + static description text, no per-template icon/state beyond enabled/disabled:
```jsx
<div className="ai-template-row">
  <input type="checkbox" checked={!!active?.enabled} onChange={e => toggleTemplate(tmpl.id, e.target.checked)} />
  <span className="ai-template-label">{tmpl.label}</span>
  <span className="ai-template-desc">→ {tmpl.description}</span>
  {tmpl.comingSoon && <span className="ai-template-lock">Coming Soon</span>}
</div>
```
`comingSoon` is `false` on T3's entry (and absent/undefined, i.e. falsy, on T1/T2/T4) — so the "Coming Soon" lock badge is **dead in practice**: no template in the array currently sets it truthy, meaning this UI affordance exists but is never triggered by current data.

When a template is enabled, a second row appears with HTF and LTF selects:
```jsx
{active?.enabled && (
  <div className="config-row" style={{ marginLeft: 28, marginBottom: 8 }}>
    <select className="select-sm" value={htf} onChange={e => handleHtfChange(tmpl.id, e.target.value)}>
      {TEMPLATE_HTF_OPTIONS.map(tf => <option key={tf} value={tf}>{tf}</option>)}
    </select>
    {htf === 'M15' ? (
      <span className="bias-label">LTF: M5</span>
    ) : (
      <select className="select-sm" value={ltf} onChange={e => handleLtfChange(tmpl.id, e.target.value)}>
        {templateLtfOptions(htf).map(tf => <option key={tf} value={tf}>{tf}</option>)}
      </select>
    )}
    {savedId === tmpl.id && <span className="bias-label">Saved ✓</span>}
  </div>
)}
```
`TEMPLATE_HTF_OPTIONS = ['M15', '1H', '4H', 'D']`. LTF is either hardcoded-displayed as "M5" (when HTF is M15, no select shown at all) or a dynamically-filtered select via `templateLtfOptions(htf)` (`TEMPLATE_ALL_TFS.filter(tf => TEMPLATE_TF_RANK[tf] < TEMPLATE_TF_RANK[htf])`). A transient "Saved ✓" indicator flashes for 1.5s after an HTF/LTF change (via `flashSaved`/`savedTimer`), **but only on HTF/LTF changes** — the initial `toggleTemplate` enable action does not flash "Saved".

### `step3_enabled`, `bias_gate`, `fvg_rule` — UI presence

**None of the three are referenced anywhere in this file.** Confirmed by full read: the only fields ever sent to the backend are `template`, `enabled`, `htf`, `ltf`, `window_mins` (create only). `schema.sql`'s `user_templates` table has all three columns:
```sql
step3_enabled  INTEGER DEFAULT 1,
bias_gate      INTEGER DEFAULT 1,
fvg_rule       TEXT DEFAULT '50_percent',
```
— confirmed dead in this UI. Every template a user creates gets the hardcoded defaults (`step3_enabled=1`, `bias_gate=1`, `fvg_rule='50_percent'`) with no way to change them from the frontend.

### `confirmation_mode` for T2

**Not present.** AIAlertsPanel has no `confirmation_mode` field, select, or reference at all. (Note: `confirmation_mode` as a concept exists in this codebase, but only on the NSE/forex **SMA Cloud** config tables — `nse_indicator_configs`/`forex_indicator_configs` — not on `user_templates`/T1–T4. T2's MSS/CISD confirmation, if it has one, is not user-configurable from this panel.)

### POST body on enabling a template

From `toggleTemplate`, the `else` branch (no existing row for this template on this asset):
```js
const res = await api.post(`/user/templates/${assetId}`, {
  template: templateId,
  enabled: 1,
  htf: '4H',
  ltf: 'M15',
  window_mins: 60,
}, token);
```
Exactly `{ template, enabled: 1, htf: '4H', ltf: 'M15', window_mins: 60 }` — every new template starts at a hardcoded 4H/M15 pairing and a hardcoded 60-minute window, regardless of what the user might want at creation time; HTF/LTF can only be changed *after* creation via the second-row selects. `window_mins` itself is **never exposed for editing anywhere in this file** — it's set once at creation and never touched again by any handler in this panel.

If a row already exists (re-enabling a previously-disabled template), the request is instead a `PATCH /user/template/:id` with `{ enabled: 1 }` only — HTF/LTF/window_mins are left as whatever they were.

---

## 5. NSE-specific panels (TdiConfigPanel, SmaConfigPanel)

### TdiConfigPanel

**File:** `frontend/src/components/TdiConfigPanel.jsx` — **83 lines**. Simplest panel in the set.

Fields exposed per row: **Timeframe (read-only text, not editable after creation)**, **Enabled/Disabled select**, delete button:
```jsx
<div key={cfg.id} className="config-row">
  <span className="text-mono" style={{ fontSize: 12 }}>{cfg.timeframe}</span>
  <select className="select-sm" value={cfg.enabled ? '1' : '0'} onChange={e => updateConfig(cfg.id, 'enabled', e.target.value === '1' ? 1 : 0)}>
    <option value="1">Enabled</option>
    <option value="0">Disabled</option>
  </select>
  <button className="icon-btn" onClick={() => deleteConfig(cfg.id)}>✕</button>
</div>
```
`TDI_TFS = ['M15', 'M30']` — hardcoded locally, not imported from `constants.js`, and **not filtered by `allowedTfs`/`nse_tf_access`** at all (unlike every other panel in this audit). A user whose `nse_tf_access` excludes M15/M30 can still add a TDI config for that TF from this UI (the backend cron's `deliverNseIndicatorAlert` would silently drop the alert at delivery time per its own `nse_tf_access` check, but the config itself is created without any client-side warning).

Add flow uses a `showAddForm` toggle (button → inline row with TF select + "Add" button) rather than EBP/Sweep's immediate-add-then-edit-in-place pattern.

**POST body on creating a TDI config:**
```js
const res = await api.post(`/user/nse-indicator-configs/${assetId}`, { indicator: 'tdi', timeframe: pendingTf }, token);
```
Exactly `{ indicator: 'tdi', timeframe }` — no other fields (matches TDI's config surface: `nse_indicator_configs` has no TDI-specific tunables beyond `timeframe`/`enabled`).

### SmaConfigPanel

**File:** `frontend/src/components/SmaConfigPanel.jsx` — **126 lines**.

Fields exposed per row: Timeframe (read-only text), **Bias Mode select**, conditional **HTF Timeframe select**, **Confirmation Mode select**, **Enabled/Disabled select**, delete button:
```jsx
<span className="text-mono" style={{ fontSize: 12 }}>{cfg.timeframe}</span>
<select ... value={cfg.bias_mode ?? 'ttrades'} onChange={... 'bias_mode' ...}>
  <option value="ttrades">HTF TTrades bias</option>
  <option value="htf_sma">HTF SMA alignment</option>
  <option value="none">Same TF momentum only</option>
</select>
{cfg.bias_mode !== 'none' && (
  <select ... value={cfg.htf_timeframe ?? '1H'} onChange={... 'htf_timeframe' ...}>
    {HTF_TFS.map(tf => <option key={tf} value={tf}>HTF: {tf === 'D' ? 'Daily' : tf}</option>)}
  </select>
)}
<select ... value={cfg.confirmation_mode ?? 'either'} onChange={... 'confirmation_mode' ...}>
  <option value="either">Either (MSS or CISD)</option>
  <option value="mss">MSS only</option>
  <option value="cisd">CISD only</option>
</select>
<select ... value={cfg.enabled ? '1' : '0'} ...>Enabled/Disabled</select>
```

`SMA_TFS = ['M15', 'M5']` and `HTF_TFS = ['1H', 'D']`, both hardcoded locally (not imported from `constants.js`, not filtered by `allowedTfs`, same gap as TdiConfigPanel).

### `confirmation_mode` and `bias_mode='none'` — post-revamp state

**Both are fully reflected in this panel**, on both the existing-row selects and the add-form selects (same three options duplicated in both places — `pendingBiasMode`/`pendingConfirmationMode` state mirrors `cfg.bias_mode`/`cfg.confirmation_mode`). This confirms the revamp's frontend piece landed correctly for NSE.

**One gap versus the backend's actual capability:** `SMA_TFS = ['M15', 'M5']` does **not** include `'M30'`, but `schema.sql`'s current comment for `nse_indicator_configs.timeframe` reads:
```sql
timeframe     TEXT NOT NULL,      -- 'M15' | 'M30' for tdi; 'M15' | 'M5' | 'M30' for sma
```
— i.e., the backend/schema was updated (as part of the SMA Cloud revamp) to treat `M30` as a valid SMA signal timeframe, and `SMA_HTF_PAIRING` in the worker includes an `M30` entry, but `SmaConfigPanel.jsx`'s `SMA_TFS` constant was never updated to offer `M30` as a selectable option. A user cannot create an M30 NSE SMA Cloud config from this UI even though the backend fully supports one.

### POST body on creating an SMA config

```js
const res = await api.post(`/user/nse-indicator-configs/${assetId}`, {
  indicator: 'sma', timeframe: pendingTf, confirmation_mode: pendingConfirmationMode,
  bias_mode: pendingBiasMode, htf_timeframe: pendingHtfTf,
}, token);
```
Exactly `{ indicator: 'sma', timeframe, confirmation_mode, bias_mode, htf_timeframe }`.

---

## 6. BiasOverridePanel

**File:** `frontend/src/components/BiasOverridePanel.jsx` — **21 lines**. The smallest and only fully-controlled (no internal state, no API calls) component in this set.

```jsx
const BIAS_TFS     = ['W', 'D', '4H', '1H'];
const BIAS_OPTIONS = ['auto', 'bullish', 'bearish', 'neutral'];

export default function BiasOverridePanel({ overrides, onChange }) {
  return (
    <div className="bias-override-panel">
      <p className="text-muted mb-sm">Override HTF bias per timeframe</p>
      {BIAS_TFS.map(tf => (
        <div key={tf} className="bias-override-row">
          <span className="bias-override-tf">{tf}</span>
          <select className="select-sm" value={overrides?.[tf] ?? 'auto'} onChange={e => onChange(tf, e.target.value)}>
            {BIAS_OPTIONS.map(opt => <option key={opt} value={opt}>{opt.charAt(0).toUpperCase() + opt.slice(1)}</option>)}
          </select>
        </div>
      ))}
    </div>
  );
}
```

### Overrides exposed
One select per TF in `['W', 'D', '4H', '1H']` — always these four, unconditionally, regardless of asset type (no NSE variant, no forex-only filtering — this is the one panel not gated by `assetType`/`allowedTfs` at all). Each select offers `auto | bullish | bearish | neutral`.

### Interaction with bias_cache
**None, directly.** This component receives `overrides` and `onChange` as props and has zero knowledge of `bias_cache` — it doesn't read live bias values, doesn't call any API itself. All persistence and bias_cache interaction happens one level up in **AssetCard**:
```js
const handleOverrideChange = async (tf, value) => {
  const updated = { ...biasOverrides, [tf]: value };
  setBiasOverrides(updated);
  const token = await getToken();
  await api.patch(`/user/assets/${asset.id}/bias-overrides`, { bias_overrides: updated }, token);
};
```
This writes to `user_assets.bias_overrides` (a per-asset JSON blob, independent of `bias_cache` itself — `bias_cache` is a separate symbol+timeframe-keyed table the backend cron reads/writes; `bias_overrides` is only consulted at alert-delivery time to override what `bias_cache` would otherwise report, per `getEffectiveBias()` in the worker code, not modified here).

Also worth noting: `BiasOverridePanel` only renders when `ebpEnabled && showBiasOverride` in AssetCard — **it has no connection to SweepConfigPanel's own HTF-override selects**, even though both ultimately influence which bias a Sweep/EBP alert is judged "aligned" against. These are two different mechanisms (`bias_overrides` JSON blob vs. per-config `htf_override` column) operating on the same underlying bias concept from two different UI surfaces.

---

## 7. Dashboard.jsx

**File:** `frontend/src/pages/Dashboard.jsx` — **144 lines**.

### AssetCard usage
Three separate `AssetCard` render sites:

1. **DXY** (always-first, its own always-rendered slot):
```jsx
{!loading && dxyAsset && (
  <AssetCard key={dxyAsset.id} asset={dxyAsset} allowedTfs={userTfAccess}
    onRemove={async (id) => { await removeAsset(id); fetchAssetCount(); }} />
)}
```
2. **Forex & Crypto** section (maps `forexCryptoAssets`):
```jsx
<AssetCard key={asset.id} asset={asset}
  allowedTfs={asset.asset_type === 'nse' ? userNseTfAccess : userTfAccess}
  onRemove={async (id) => { await removeAsset(id); fetchAssetCount(); }} />
```
3. **NSE Market** section (maps `nseAssets`):
```jsx
<AssetCard key={asset.id} asset={asset} tier={user?.plan ?? 'free'}
  onRemove={async (id) => { await removeAsset(id); fetchAssetCount(); }} />
```

### Props passed
- `asset` — the asset object, always.
- `allowedTfs` — passed on the DXY and Forex/Crypto render sites, **but not on the NSE Market render site** (§9 gap — see below).
- `tier` — passed **only** on the NSE render site; **AssetCard.jsx never destructures or reads a `tier` prop** (confirmed by full read — `AssetCard`'s signature is `({ asset, allowedTfs, onRemove })`), so this prop is silently dropped/unused dead weight.
- `onRemove` — always, same shape across all three sites (`removeAsset` then `fetchAssetCount()`).

**Gap:** the NSE Market `<AssetCard>` call passes neither `allowedTfs` nor `userNseTfAccess`. Since `AssetCard` never itself computes `nse_tf_access`-based filtering (it just forwards `allowedTfs` straight through to `EBPConfigPanel`/`SweepConfigPanel`/`SmaConfigPanel`... except `SmaConfigPanel`/`TdiConfigPanel` don't even accept an `allowedTfs` prop, see §5), any NSE asset rendered from this third call site gets `allowedTfs === undefined` inside `EBPConfigPanel`/`SweepConfigPanel`, which — per their own `allowedTfs ? filter(...) : fullTfOptions` logic — means **TF filtering is silently skipped and every TF option is shown**, not just the ones in `user.nse_tf_access`. Note the second (Forex & Crypto) call site's ternary (`asset.asset_type === 'nse' ? userNseTfAccess : userTfAccess`) implies the author anticipated NSE assets might appear in that loop too (defensive code), but `nseAssets` (used at the third call site) are filtered out of `forexCryptoAssets` beforehand (`asset.asset_type === 'forex' || asset.asset_type === 'crypto'`), so that ternary's NSE branch is realistically unreachable from current data — the dedicated third call site is the one that actually renders NSE assets, and it's the one missing `allowedTfs`.

### DXY-specific handling
```js
const dxyAsset = assets.find(a => a.asset_type === 'system');
```
Comment directly above it: *"DXY — synthetic index, its own asset_type ('system'), doesn't belong in the Forex/Crypto or NSE buckets below, so it needs its own always-first slot rather than falling through a type filter."* DXY is excluded from `forexCryptoAssets` (which filters strictly on `'forex'`/`'crypto'`) and from `nseAssets`, and gets a dedicated always-first `<AssetCard>` call, separate from the "Forex & Crypto" asset-count/limit UI (DXY doesn't count against `assetCount.forex_crypto_count`/`limit` display, since that count block is rendered independently of `dxyAsset`).

Per §1/§4 of the AssetCard section above: because `dxyAsset.asset_type === 'system'`, neither `isNse` nor `isForex` is true for it inside AssetCard — **DXY gets EBP, Sweep, and AI Alert sections, but no TDI/SMA Cloud section at all**, since those are gated on `isNse || isForex` and `'system'` satisfies neither.

### Other notable Dashboard behavior
- Plan-expired overlay: `user?.active === 0` renders a full-screen `.overlay` blocking card, independent of asset rendering.
- `/nse/status` is fetched **without a token** ("Public route — no token needed, works for non-admin users too") purely to show a `~15 min delayed` badge next to "NSE Market" when `upstox_configured` is false.
- Loading state shows 3 skeleton `.card` placeholders only for the Forex & Crypto section — the NSE section has no equivalent skeleton (its render guard is simply `!loading && nseAssets.length > 0 && ...`, so during loading the NSE section shows nothing at all, not even a placeholder).

---

## 8. useAssets hook

**File:** `frontend/src/hooks/useAssets.js` — **48 lines**.

### What it fetches/returns
```js
export function useAssets() {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const [assets, setAssets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);

  const fetchAssets = useCallback(async () => {
    if (!isLoaded) return;
    if (!isSignedIn) { setLoading(false); return; }
    setLoading(true);
    try {
      const token = await getToken();
      const data  = await api.get('/user/assets', token);
      setAssets(Array.isArray(data) ? data : []);
      setLastUpdated(Date.now());
      setError(null);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [isLoaded, isSignedIn, getToken]);

  useEffect(() => { fetchAssets(); }, [fetchAssets]);

  const addAsset = async (symbol, displayName, assetType) => {
    const token = await getToken();
    await api.post('/user/assets', { symbol, displayName, assetType }, token);
    await fetchAssets();
  };

  const removeAsset = async (id) => {
    const token = await getToken();
    await api.delete(`/user/assets/${id}`, token);
    await fetchAssets();
  };

  return { assets, loading, error, addAsset, removeAsset, refetch: fetchAssets, lastUpdated };
}
```
Single endpoint: `GET /user/assets`. Returns `{ assets, loading, error, addAsset, removeAsset, refetch, lastUpdated }`.

### Refetch strategy
**No polling/interval** — this hook only fetches once on mount (`useEffect` with `[fetchAssets]` dependency, and `fetchAssets` itself is stable unless `isLoaded`/`isSignedIn`/`getToken` change). It refetches **only** in response to explicit mutations: after `addAsset` and after `removeAsset`, both of which `await fetchAssets()` inline. There is no `setInterval` anywhere in this file — contrast with `AssetCard`'s own 60s polling of per-asset config summaries. This means the *list* of assets (added/removed) only updates on explicit user action or full page reload, while each individual card's *config summary* (`ebpEnabled`, etc.) polls independently every 60s regardless of whether the asset list itself has changed.

---

## 9. Key gaps and inconsistencies found

### UI fields referencing dropped/renamed schema columns
None found. All fields read by the audited panels (`alert_mode`, `htf_override`, `template`/`htf`/`ltf`/`window_mins`, `indicator`/`timeframe`/`confirmation_mode`/`bias_mode`/`htf_timeframe`/`enabled`) correspond to live columns in their respective backend tables. Notably, `SmaConfigPanel.jsx` and `TdiConfigPanel.jsx` post to `/user/nse-indicator-configs/:assetId` with `confirmation_mode` — this matches the **post-revamp** `nse_indicator_configs.confirmation_mode` column (renamed from the old `stack_mode`), not a stale field.

### Schema columns with no UI surface
| Column | Table | UI status |
|---|---|---|
| `step3_enabled` | `user_templates` | **Dead** — never read/written anywhere in `AIAlertsPanel.jsx`. Always creation-defaults to `1`. |
| `bias_gate` | `user_templates` | **Dead** — same as above, always defaults to `1`. |
| `fvg_rule` | `user_templates` | **Dead** — same as above, always defaults to `'50_percent'`. |
| `window_mins` | `user_templates` | **Write-only** — sent once at creation (hardcoded `60`), never surfaced for editing or even display after creation. |
| `day_filter` | `nse_indicator_configs` | **Dead on both ends** — not read by `nse-cron.js` (per that table's own schema comment: *"sma only, unused since the SMA Cloud corrective patch (column kept, code no longer reads it)"*) and not present in `SmaConfigPanel.jsx`. Consistent dead column, not a UI gap specifically. |
| `enabled` | `user_ebp_configs` | Exists in the schema/API (`EBPConfigPanel`'s `updateConfig` could theoretically PATCH it) but **no select/toggle for it is rendered** in `EBPConfigPanel.jsx` — every other config panel (Sweep... actually see below, Sweep has the same gap) exposes Enabled/Disabled; EBP does not. |

Correcting one entry above on closer read: **SweepConfigPanel also has no Enabled/Disabled select**, same as EBP — only `TdiConfigPanel` and `SmaConfigPanel` (both NSE) expose an explicit enabled/disabled control. So the actual pattern is: **EBP and Sweep configs can only be "disabled" by deleting the row**; TDI and SMA configs can be toggled off without deletion. This is an inconsistency in UX pattern across panel types, not a missing-field bug (both tables do have `enabled INTEGER DEFAULT 1` columns; only two of the four panel types expose a control for it).

### Hardcoded values that should arguably come from the backend
- `AIAlertsPanel`: `htf: '4H', ltf: 'M15', window_mins: 60` on every new template — no per-user or per-asset default fetched from anywhere.
- `TdiConfigPanel`: `TDI_TFS = ['M15', 'M30']` hardcoded locally rather than imported from `constants.js` (where `NSE_EBP_TFS`/`NSE_SWEEP_TFS` etc. already live) — and, per above, not `allowedTfs`-filtered at all, unlike every sibling panel.
- `SmaConfigPanel`: `SMA_TFS = ['M15', 'M5']` (missing `M30`, which the backend now supports) and `HTF_TFS = ['1H', 'D']`, both hardcoded locally rather than imported, and not `allowedTfs`-filtered.
- `BiasOverridePanel`: `BIAS_TFS = ['W', 'D', '4H', '1H']` hardcoded, shown unconditionally for every asset type including NSE (where the actual bias TF set per `NSE_BIAS_SOURCE_FRONTEND` differs — NSE bias timeframes for EBP/Sweep are `M15/M30/1H/D`-sourced, not `W`/`4H`; whether `W`/`4H` overrides on an NSE asset do anything meaningful on the backend wasn't verified in this read-only pass, but the UI offers them regardless of asset type).
- `EBPConfigPanel` / `SweepConfigPanel`: `HTF_OVERRIDE_OPTIONS` is **defined twice**, once per file, with identical contents — a shared-constant candidate that instead lives as a local duplicate in each panel.

### Panels that would break (or degrade) with zero existing configs
None crash — all four config-fetching panels (`EBPConfigPanel`, `SweepConfigPanel`, `TdiConfigPanel`, `SmaConfigPanel`) guard `Array.isArray(data) ? data : []` on fetch and render an explicit "No ... configured" message when `configs.length === 0`. `AIAlertsPanel` similarly defaults to `[]` and each `TEMPLATES` entry falls back to `active?.htf ?? '4H'` / `active?.ltf ?? 'M15'` when no row exists yet. `BiasOverridePanel` defaults every select to `'auto'` via `overrides?.[tf] ?? 'auto'`. No null-pointer-style crash path found for the zero-config case in any of the nine audited files.

The one soft-degradation case already covered above: an NSE `AssetCard` rendered from Dashboard's third call site (missing `allowedTfs`/`userNseTfAccess`) doesn't *break*, but silently shows **all** TF options in `EBPConfigPanel`/`SweepConfigPanel` instead of the admin-restricted subset — a permissions-display gap rather than a crash.
