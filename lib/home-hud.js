// Home HUD roster for the current Grok Bot desks.
// Agency Redis agent status, completion history, and console lines are not
// the source for these panels.

export const COMPLETIONS_QUIET_LABEL = 'NO RECENT ACTIVITY';
export const CONSOLE_QUIET_LABEL = 'AWAITING GATEWAY SIGNAL...';

export const GROK_BOT_DESKS = [
  { id: 'q', name: 'Q', role: 'Chief Technology Officer', status: 'active' },
  { id: 'moneypenny', name: 'MoneyPenny', role: 'Chief of Staff', status: 'active' },
  { id: 'spectre', name: 'SPECTRE', role: 'The Mastermind', status: 'active' },
];

export function activeAgentsView() {
  const agents = GROK_BOT_DESKS.map((desk) => ({
    id: desk.id,
    label: `${desk.name} — ${desk.role}`,
    status: desk.status,
  }));
  const activeCount = agents.filter((agent) => agent.status === 'active').length;
  return {
    agents,
    totalAgents: agents.length,
    activeCount,
  };
}

// Stored completion entries stay off the HUD until a current desk feed exists.
export function completionsForHud(contextLog = []) {
  if (!Array.isArray(contextLog)) {
    return { items: [], okCount: 0, quietLabel: COMPLETIONS_QUIET_LABEL };
  }
  return {
    items: [],
    okCount: 0,
    quietLabel: COMPLETIONS_QUIET_LABEL,
  };
}

// Thread lines are the only console source. Redis console payloads are counted
// and then left out of the lines returned to the board.
export function consoleLinesForHud({ threadLines = [], telemetryLines = [] } = {}) {
  const telemetry = Array.isArray(telemetryLines) ? telemetryLines : [];
  const threads = Array.isArray(threadLines) ? threadLines : [];
  const lines = threads
    .filter((line) => line && typeof line.msg === 'string' && line.msg.trim())
    .slice(-40);
  return {
    lines,
    ignoredTelemetryLines: telemetry.length,
  };
}
