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
