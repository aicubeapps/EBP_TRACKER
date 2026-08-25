export const BIAS_SOURCE_FRONTEND = {
  ebp: {
    'M15': '4H',
    '1H':  'D',
    '4H':  'W',
    'D':   'W',
    'W':   null,
  },
  sweep: {
    'M15': '1H',
    'M30': '4H',
    '1H':  'D',
    '4H':  'W',
  },
  template: {
    'W':   null,
    'D':   'W',
    '4H':  'D',
    '1H':  '4H',
  },
};

export const EBP_TFS   = ['M15', '1H', '4H', 'D', 'W'];
export const SWEEP_TFS = ['M15', 'M30', '1H', '4H', 'D', 'W'];

// NSE — separate TF set and bias map (matches nse-worker's NSE_BIAS_SOURCE).
// NSE M15 maps to 1H bias, not forex's 4H — reusing BIAS_SOURCE_FRONTEND for
// NSE configs would show the wrong bias timeframe (or look up the wrong
// bias_cache row entirely) for any TF that appears in both sets.
export const NSE_BIAS_SOURCE_FRONTEND = {
  ebp:   { 'M1': 'M15', 'M5': 'M30', 'M15': '1H', 'M30': 'D', '1H': 'D', 'D': null },
  sweep: { 'M1': 'M15', 'M5': 'M30', 'M15': '1H', 'M30': 'D', '1H': 'D', 'D': null },
};

export const NSE_EBP_TFS   = ['M1', 'M5', 'M15', 'M30', '1H', 'D'];
export const NSE_SWEEP_TFS = ['M1', 'M5', 'M15', 'M30', '1H', 'D'];

// AI Alert templates (T1-T4) — user-configurable HTF/LTF pairing.
// Matches TEMPLATE_TF_RANK in the worker's PATCH /user/template/:id validator.
export const TEMPLATE_TF_RANK = { 'M5': 1, 'M15': 2, 'M30': 3, '1H': 4, '4H': 5, 'D': 6, 'W': 7 };
export const TEMPLATE_HTF_OPTIONS = ['M15', '1H', '4H', 'D'];
export const TEMPLATE_ALL_TFS     = ['M5', 'M15', 'M30', '1H', '4H', 'D'];

export function templateLtfOptions(htf) {
  return TEMPLATE_ALL_TFS.filter(tf => TEMPLATE_TF_RANK[tf] < TEMPLATE_TF_RANK[htf]);
}

// Forex/Crypto SMA Cloud — matches sweep-worker's FOREX_SMA_VALID_TFS /
// FOREX_SMA_HTF_OPTIONS.
export const FOREX_SMA_TFS = ['M15', 'M30', '1H', '4H'];
export const FOREX_SMA_HTF_OPTIONS = {
  'M15': ['4H'],
  'M30': ['4H'],
  '1H':  ['4H', 'D'],
  '4H':  ['D'],
};

// Bias override TFs per asset type (BiasOverridePanel).
export const FOREX_BIAS_TFS = ['W', 'D', '4H', '1H'];
export const NSE_BIAS_TFS   = ['D', '1H', 'M30', 'M15'];

// HTF override options — shared between EBP and Sweep panels. Must match
// worker/src/ebp-worker.js's VALID_HTF_OVERRIDES exactly, or the PATCH
// that sets htf_override 400s for any TF listed here that the backend
// doesn't also allow.
export const HTF_OVERRIDE_OPTIONS = {
  'M15': ['4H', '1H'],
  'M30': ['4H'],
  '1H':  ['D', '4H'],
  '4H':  ['W', 'D'],
  'D':   ['W'],
};

// NSE indicator TFs (TdiConfigPanel / SmaConfigPanel).
export const TDI_TFS         = ['M15', 'M30'];
export const NSE_SMA_TFS     = ['M5', 'M15', 'M30'];
export const NSE_SMA_HTF_TFS = ['1H', 'D'];

// FVG rule options (T1/T2/T4 template config).
export const FVG_RULE_OPTIONS = [
  { value: '50_percent', label: '50% Fill' },
  { value: 'any_touch',  label: 'Any Touch' },
  { value: 'full_fill',  label: 'Full Fill' },
];

// Template window_mins bounds (T3) — must match ebp-worker.js's
// PATCH /user/template/:id validation.
export const TEMPLATE_WINDOW_MINS_MIN = 15;
export const TEMPLATE_WINDOW_MINS_MAX = 240;
