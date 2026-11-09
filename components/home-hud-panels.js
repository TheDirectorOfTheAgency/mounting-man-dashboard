import React from 'react';

import {
  activeAgentsView,
  completionsForHud,
  consoleLinesForHud,
  CONSOLE_QUIET_LABEL,
} from '../lib/home-hud.js';

const h = React.createElement;

function statusDotClass(status) {
  if (status === 'active') return 'bg-hud-green';
  if (status === 'standby') return 'bg-yellow-500';
  if (status === 'offline') return 'bg-hud-red';
  return 'bg-hud-text-dim';
}

function statusTextClass(status) {
  if (status === 'active') return 'text-hud-green';
  if (status === 'standby') return 'text-yellow-500/70';
  return 'text-hud-text-dim/50';
}

function lineTone(level) {
  if (level === 'error') {
    return { icon: '✗', iconClass: 'text-hud-red', msgClass: 'text-hud-red/90' };
  }
  if (level === 'warn') {
    return { icon: '⚠', iconClass: 'text-yellow-500', msgClass: 'text-yellow-400/90' };
  }
  if (level === 'ok') {
    return { icon: '✓', iconClass: 'text-hud-green', msgClass: 'text-hud-green/80' };
  }
  if (level === 'start') {
    return { icon: '▸', iconClass: 'text-cyan-400', msgClass: 'text-cyan-400/90' };
  }
  return { icon: '·', iconClass: 'text-hud-text-dim', msgClass: 'text-hud-white' };
}

function consoleTimestamp(ts) {
  if (!ts || typeof ts !== 'string') return '';
  if (ts.includes('T')) return ts.replace('T', ' ').substring(5, 16);
  return ts;
}

export function ActiveAgentsPanel() {
  const view = activeAgentsView();
  return h('div', { className: 'hud-panel p-4', 'data-hud-panel': 'active-agents' },
    h('div', { className: 'flex items-center justify-between mb-4' },
      h('div', { className: 'hud-panel-header' }, 'ACTIVE AGENTS'),
      h('span', { className: 'text-[10px] text-hud-text-dim font-mono tracking-wider' },
        `${view.activeCount}/${view.totalAgents}`),
    ),
    h('div', { className: 'space-y-0' },
      view.agents.map((agent, index) => h('div', {
        key: agent.id,
        'data-desk': agent.id,
        className: `py-2.5 ${index > 0 ? 'border-t border-hud-border/30' : ''}`,
      },
        h('div', { className: 'flex items-center justify-between mb-1' },
          h('div', { className: 'flex items-center gap-2' },
            h('div', {
              className: `w-1.5 h-1.5 rounded-full ${statusDotClass(agent.status)}`,
              style: agent.status === 'active' ? { boxShadow: '0 0 6px rgba(200,230,50,0.6)' } : undefined,
            }),
            h('span', { className: 'text-[10px] text-hud-text tracking-wider uppercase' }, agent.label),
          ),
          h('span', { className: `text-[7px] font-terminal tracking-[2px] uppercase ${statusTextClass(agent.status)}` },
            (agent.status || 'unknown').toUpperCase()),
        ),
      )),
    ),
  );
}

export function RecentCompletionsPanel({ contextLog = [] }) {
  const view = completionsForHud(contextLog);
  return h('div', { className: 'hud-panel p-4', 'data-hud-panel': 'recent-completions' },
    h('div', { className: 'flex items-center justify-between mb-4' },
      h('div', { className: 'hud-panel-header' }, 'RECENT COMPLETIONS'),
      h('span', { className: 'text-[10px] text-hud-green font-mono tracking-wider font-bold' },
        `${view.okCount} OK`),
    ),
    h('div', { className: 'text-[10px] text-hud-text-dim tracking-wider text-center py-4' },
      view.quietLabel),
  );
}

export function LiveConsoleFeed({ threadLines = [], telemetryLines = [] }) {
  const { lines } = consoleLinesForHud({ threadLines, telemetryLines });
  if (lines.length === 0) {
    return h('div', { className: 'text-hud-text-dim/50 text-center py-6 tracking-widest' },
      CONSOLE_QUIET_LABEL);
  }

  return lines.slice().reverse().map((line, index) => {
    const tone = lineTone(line.level || line.sev || 'info');
    const label = line.label || line.src || '';
    return h('div', {
      key: `${line.ts || 'line'}-${index}`,
      className: 'flex gap-2 py-0.5 hover:bg-white/2',
    },
      h('span', { className: 'text-hud-text-dim/50 select-none w-[75px] shrink-0' }, consoleTimestamp(line.ts)),
      h('span', { className: `${tone.iconClass} w-3 shrink-0 text-center` }, tone.icon),
      h('span', { className: 'text-hud-text-dim/70 w-[70px] shrink-0 truncate' }, `[${label}]`),
      h('span', { className: `${tone.msgClass} break-all` }, line.msg),
    );
  });
}
