import { useState } from 'react';

const SIGNAL_CARDS = [
  {
    code: 'EBP',
    label: 'Engulfing Body Pattern',
    badgeClass: 'badge-ebp',
    desc: "Current candle sweeps the prior bar's extreme and closes beyond its body. Core directional signal — indicates momentum continuation.",
  },
  {
    code: 'SWEEP',
    label: 'Sweep',
    badgeClass: 'badge-sweep',
    desc: "Current candle sweeps the prior bar's extreme but closes back inside the prior range. Flags a liquidity grab; often precedes reversal.",
  },
  {
    code: 'MSS',
    label: 'Market Structure Shift',
    badgeClass: 'badge-mss',
    desc: 'Price closes beyond the high (bull) or low (bear) of the entire prior pullback run, confirming a structural reversal. Always fires after a sweep.',
  },
  {
    code: 'MODE',
    label: 'Alert Mode',
    badgeClass: 'badge-system',
    desc: 'Controls which direction signals you receive, configured per asset per timeframe on the Assets page.',
    subPoints: [
      { label: 'aligned', desc: 'Only fires when the signal direction matches your configured HTF bias. If you have a manual or SMA bias set, that is what gets checked. Counter-trend signals are suppressed.' },
      { label: 'price_action', desc: "Ignores your configured bias source (manual or SMA). Re-reads the raw HTF candle close direction at alert time using the TTrades engine. Only fires when the signal matches what the market's most recent HTF candle is saying — not what your settings say. Useful when your manual bias is stale or your SMA is lagging." },
      { label: 'all', desc: 'Fires every signal regardless of direction or bias. No filtering applied.' },
    ],
  },
  {
    code: 'BIAS',
    label: 'Bias Mode',
    badgeClass: 'badge-system',
    desc: "Each HTF bias source defaults to auto — computed live from that timeframe's candle-close direction. Override any bias source timeframe to a fixed bullish, bearish, or neutral value from the Assets page; it stays fixed until set back to auto.",
  },
];

const TEMPLATES = [
  {
    key: 'T1',
    title: 'EBP → OTE FVG Entry',
    steps: ['EBP', 'FVG Entry'],
    desc: "4H EBP arms the chain silently (no alert at arm time). Alert fires when an M15 FVG forms inside the EBP candle's OTE zone (0.5–0.768 retracement of the candle's high-to-low) and price body-closes beyond it. No user-configurable sub-options beyond HTF/LTF and FVG rule.",
    subOptions: null,
  },
  {
    key: 'T2',
    title: 'EBP → Zone Entry → CISD / MSS',
    steps: ['EBP', 'Zone Entry', 'Sweep', 'Trigger'],
    desc: 'A 4H EBP arms the chain. Waits for price to enter a zone, then a sweep (if required), then a CISD or MSS trigger. Sends up to 3 stepped alerts labelled /S1, /S2, /S3.',
    subOptions: [
      { option: 'OTE Zone', values: 'Enabled / Disabled', desc: 'When enabled, the zone is the OTE band (0.5–0.768 retrace). When disabled, uses the full discount/premium zone.' },
      { option: 'Sweep Required', values: 'Yes / No', desc: 'When Yes, a sweep of the zone must occur before the trigger step arms. When No, zone entry alone advances the chain.' },
      { option: 'Trigger Type', values: 'CISD / MSS / Either', desc: 'CISD = wait for a CISD level body-close. MSS = wait for a full market structure shift. Either = whichever fires first — MSS takes priority, with CISD as fallback.' },
      { option: 'MSS Timeframe', values: 'M5 / M15 / M30 / 1H / 4H / D', desc: 'The timeframe on which MSS is detected for the trigger step.' },
      { option: 'Bias Mode', values: 'TTrades / HTF SMA / Off', desc: 'TTrades = HTF bias from the TTrades bias engine (candle-close direction). HTF SMA = HTF bias from the higher-timeframe SMA1/SMA9 relationship. Off = disables the automatic engine — set Manual Bias instead.' },
      { option: 'Manual Bias', values: 'Auto / Bullish / Bearish', desc: 'Only active when Bias Mode is Off. Auto = no direction restriction. Bullish / Bearish fixes which direction the chain is allowed to arm in.' },
    ],
  },
  {
    key: 'T3',
    title: 'Daily Candle → FVG Zone → Time Gate → CISD / MSS',
    steps: ['Daily FVG', 'Time Gate', 'Key Level', 'Trigger'],
    desc: "Uses the previous day's NY 17:00 close candle. Looks for an unmitigated 4H FVG (1H fallback) sitting in the 50–75% zone of that candle. Gated on NY 23:00 passing before alerting. S2 fires when the FVG is wicked; S3 fires at CISD or MSS.",
    subOptions: null,
  },
  {
    key: 'T4',
    title: 'Daily Bias → Intraday MSS → FVG Entry',
    steps: ['MSS', 'FVG Entry'],
    desc: 'Requires a daily bias condition (4 scenarios including small body expansion day). After bias confirmed, waits for an intraday MSS on 1H or M30, then a pullback into a premium/discount FVG (priority: 1H → M30 → M15), then an M15 body close beyond the FVG. Hard kill if the previous day\'s high/low is swept before entry fires. Expires NY 17:00 daily.',
    subOptions: null,
  },
];

const COMMON_SETTINGS = [
  { setting: 'HTF (Higher Time Frame)', desc: 'The timeframe where the primary signal (EBP or sweep) is detected to arm the chain. Options: M15, 1H, 4H, D.' },
  { setting: 'LTF (Lower Time Frame)', desc: 'The timeframe where entry confirmation (FVG, CISD, MSS) is checked. Must rank below HTF among M5, M15, M30, 1H, 4H, D.' },
  { setting: 'FVG Rule', values: 'Any Touch / 50% Fill / Full Fill', desc: 'How strictly price must enter the FVG. Any Touch = a wick into the zone is enough. 50% Fill = close past the midpoint. Full Fill = close past the far edge.' },
  { setting: 'Window Mins', desc: 'How long (in minutes) the chain stays active after arming. If no trigger fires within this window, the chain expires. Range: 15–240 min.' },
  { setting: 'Bias Gate', values: 'On / Off', desc: 'When On, the chain only arms if the signal direction matches the current HTF bias. Prevents counter-trend entries.' },
];

const SMA_CLOUD_SETTINGS = [
  { setting: 'Timeframe', values: 'M15 / M30 / 1H / 4H', desc: 'The timeframe on which SMA1 vs SMA9 crossover behaviour is monitored.' },
  { setting: 'Bias Mode', values: 'TTrades / HTF SMA / None', desc: 'TTrades = HTF bias from the TTrades bias engine. HTF SMA = HTF bias from the HTF Timeframe’s own SMA9 relationship. None = same-timeframe momentum only, no HTF bias check.' },
  { setting: 'HTF Timeframe', desc: 'The higher timeframe whose bias gates the signal. Only shown when Bias Mode isn’t None — options depend on the selected Timeframe (e.g. M15/M30 → 4H, 1H → 4H or D, 4H → D).' },
  { setting: 'Confirmation Mode', values: 'Either / MSS only / CISD only', desc: 'Either = a Type-2 continuation signal confirms on MSS or CISD, whichever fires first. MSS only / CISD only = requires that specific confirmation.' },
];

const NSE_SETTINGS = [
  { setting: 'TDI (Trend Direction Indicator)', desc: 'Available on M15 and M30. Fires when the trend and signal lines cross in the configured direction. No further configuration beyond timeframe and enable/disable.' },
  { setting: 'SMA (NSE)', desc: 'SMA Cloud equivalent for NSE assets. Available on M5, M15, and M30.' },
  { setting: 'Bias Mode', values: 'TTrades / HTF SMA / None', desc: 'Same three-way choice as Forex SMA Cloud.' },
  { setting: 'HTF Timeframe', values: '1H / D', desc: 'Gates the signal when Bias Mode isn’t None.' },
  { setting: 'Confirmation Mode', values: 'Either / MSS only / CISD only', desc: 'Same semantics as Forex SMA Cloud — unrelated to TDI.' },
];

const BREADTH_VIEWS = [
  { view: 'Intraday Strength', desc: 'Cumulative bullish/bearish strength per currency from the current NY session start (5:00 PM), resets daily, updates hourly.' },
  { view: 'Daily Strength', desc: "Compares a selected NY trading day's strength against the prior day — up to the 5 most recent days." },
  { view: 'Weekly Strength', desc: 'Aggregates daily strength into ISO weeks and compares a selected week against the prior one — up to the 5 most recent weeks.' },
];

function TemplateStepBar({ steps }) {
  return (
    <div className="chain-bar">
      <div className="chain-bar__steps">
        {steps.map(label => (
          <div key={label} className="chain-step">
            <div className="chain-step__dot" />
            <span className="chain-step__label">{label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TemplateGuideCard({ tmpl }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="template-card">
      <button className="user-card-header" onClick={() => setOpen(o => !o)}>
        <div className="template-card__title">
          <span className="template-card__type">{tmpl.key}</span>
          <span className="template-card__label">{tmpl.title}</span>
        </div>
        <span className={`user-card-chevron ${open ? 'expanded' : ''}`}>▸</span>
      </button>

      {open && (
        <div className="user-card-body">
          <p className="template-card__desc">{tmpl.desc}</p>

          <span className="template-card__chain-label">Chain</span>
          <TemplateStepBar steps={tmpl.steps} />

          {tmpl.subOptions && (
            <div className="table-wrap mt-md">
              <table className="alert-table">
                <thead>
                  <tr>
                    <th>Option</th>
                    <th>Values</th>
                    <th>What it does</th>
                  </tr>
                </thead>
                <tbody>
                  {tmpl.subOptions.map(o => (
                    <tr key={o.option}>
                      <td className="asset-cell">{o.option}</td>
                      <td>{o.values}</td>
                      <td>{o.desc}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SettingsTable({ rows }) {
  return (
    <div className="table-wrap">
      <table className="alert-table">
        <thead>
          <tr>
            <th>Setting / Concept</th>
            <th>What it does</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.setting || r.view}>
              <td className="asset-cell">
                {r.setting || r.view}
                {r.values && <div className="text-muted mt-xs">{r.values}</div>}
              </td>
              <td>{r.desc}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function GuidePage() {
  return (
    <div className="shell">
      <div className="page-title">Guide</div>
      <p className="page-subtitle">How EBP Tracker works and what each setting does.</p>

      {/* Section 1 — Signal Types */}
      <div className="section-heading">Signal Types</div>
      <div className="banner banner-info">
        All signals are delivered via Telegram. Enable Telegram in Settings before configuring alerts.
      </div>
      {SIGNAL_CARDS.map(s => (
        <div key={s.code} className="card">
          <div className="template-card__title mb-sm">
            <span className={`badge ${s.badgeClass}`}>{s.code}</span>
            <span className="template-card__label">{s.label}</span>
          </div>
          <p className="template-card__desc" style={{ margin: 0 }}>{s.desc}</p>
          {s.subPoints && (
            <div className="table-wrap mt-sm">
              <table className="alert-table">
                <thead>
                  <tr>
                    <th>Value</th>
                    <th>Behavior</th>
                  </tr>
                </thead>
                <tbody>
                  {s.subPoints.map(sp => (
                    <tr key={sp.label}>
                      <td className="asset-cell">{sp.label}</td>
                      <td>{sp.desc}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}

      {/* Section 2 — Template Chains */}
      <div className="section-heading mt-md">Template Chains</div>
      <div className="banner banner-info">
        Templates are multi-step signal sequences. Each step must fire in order before the final alert is sent. Forex only — NSE assets are excluded.
      </div>
      {TEMPLATES.map(tmpl => (
        <TemplateGuideCard key={tmpl.key} tmpl={tmpl} />
      ))}

      {/* Section 3 — Common Template Settings */}
      <div className="section-heading mt-md">Common Template Settings</div>
      <div className="card">
        <SettingsTable rows={COMMON_SETTINGS} />
      </div>

      {/* Section 4 — SMA Cloud (Forex) */}
      <div className="section-heading mt-md">SMA Cloud</div>
      <div className="card">
        <SettingsTable rows={SMA_CLOUD_SETTINGS} />
      </div>

      {/* Section 5 — NSE (India) */}
      <div className="section-heading mt-md">NSE Signals</div>
      <div className="banner banner-info">
        NSE signals require Upstox to be configured by the admin. Session runs 09:15–15:30 IST on weekdays.
      </div>
      <div className="card">
        <SettingsTable rows={NSE_SETTINGS} />
      </div>

      {/* Section 6 — Market Breadth */}
      <div className="section-heading mt-md">Market Breadth</div>
      <div className="card">
        <SettingsTable rows={BREADTH_VIEWS} />
      </div>
    </div>
  );
}
