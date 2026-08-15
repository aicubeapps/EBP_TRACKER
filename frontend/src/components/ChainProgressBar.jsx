const STEPS = {
  T1: [
    { key: 'step1', label: 'EBP' },
    { key: 'step2', label: 'FVG Entry' },
  ],
  T2: [
    { key: 'step1', label: 'EBP' },
    { key: 'step2', label: 'Zone Entry' },
    { key: 'step3', label: 'Sweep' },
    { key: 'step4', label: 'Trigger' },
  ],
  T3: [
    { key: 'step1', label: 'Daily FVG' },
    { key: 'step2', label: 'Time Gate' },
    { key: 'step3', label: 'Key Level' },
    { key: 'step4', label: 'Trigger' },
  ],
  T4: [
    { key: 'step1', label: 'MSS' },
    { key: 'step2', label: 'FVG Entry' },
  ],
};

// Completion is derived from chain.state, not from which step*_signal_id
// columns are populated — T1/T2's second step (FVG entry / retracement)
// never gets its own signal_id (only step1 does), so a signal_id-based
// check would always read that step as incomplete even once fired.
const STATE_STEPS = {
  T1: {
    awaiting_fvg_entry: 1,
    complete: 2,
  },
  T2: {
    awaiting_zone_entry: 1,
    awaiting_sweep: 2,
    awaiting_trigger: 3,
    complete: 4,
  },
  T3: {
    awaiting_time_gate: 1,
    awaiting_key_level: 2,
    awaiting_trigger: 3,
    complete: 4,
  },
  T4: {
    awaiting_fvg_entry: 1,
    complete: 2,
  },
};

function getCompletedSteps(chain, templateType) {
  if (!chain) return 0;
  return STATE_STEPS[templateType]?.[chain.state] ?? 0;
}

function humaniseState(state) {
  return state?.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) ?? '—';
}

export function ChainProgressBar({ chain, templateType }) {
  const steps = STEPS[templateType] ?? [];
  const completed = getCompletedSteps(chain, templateType);

  if (!chain) {
    return (
      <div className="chain-bar chain-bar--inactive">
        <span className="chain-bar__label">No active chain</span>
      </div>
    );
  }

  return (
    <div className="chain-bar">
      <div className="chain-bar__steps">
        {steps.map((step, i) => {
          const isDone    = i < completed;
          const isPending = !isDone;
          return (
            <div key={step.key} className={`chain-step ${isDone ? 'chain-step--done' : isPending ? 'chain-step--pending' : ''}`}>
              <div className="chain-step__dot" />
              <span className="chain-step__label">{step.label}</span>
            </div>
          );
        })}
      </div>
      <div className="chain-bar__meta">
        <span className="chain-bar__state">
          {chain.state === 'complete' ? 'Complete ✓' : humaniseState(chain.state)}
        </span>
        {chain.step1_signal_id && (
          <span className="chain-bar__signal">ID: {chain.step1_signal_id}</span>
        )}
        <span className="chain-bar__direction">
          {chain.direction === 'bullish' ? '🟢' : '🔴'} {chain.direction}
        </span>
      </div>
    </div>
  );
}
