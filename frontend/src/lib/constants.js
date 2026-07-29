export const BIAS_SOURCE_FRONTEND = {
  ebp: {
    'M15': '4H',
    '1H':  'D',
    '4H':  'W',
    'D':   'W',
    'W':   null,
  },
  sweep: {
    'M5':  '1H',
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
export const SWEEP_TFS = ['M5', 'M15', 'M30', '1H', '4H'];

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
