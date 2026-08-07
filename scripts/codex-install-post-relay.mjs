#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const HOME = homedir();
const DEFAULT_CONFIG_PATH = path.join(HOME, '.config/the-agency/codex-install-post-relay.json');
const DEFAULT_STATE_PATH = path.join(HOME, '.local/state/the-agency/codex-install-post-relay/state.json');
const DEFAULT_LOCK_PATH = path.join(HOME, '.local/state/the-agency/codex-install-post-relay/relay.lock');
const DEFAULT_PROJECT_DIR = path.join(HOME, 'vault-local/Projects/Mounting-Man/installation-posts-codex');
const THREAD_NAME = 'Installation Posts';
const REQUIRED_MODEL_PROVIDER = 'openai';
const RECEIPT_LIMIT = 500;

const ALLOWED_SEED_KEYS = new Set([
  'city',
  'state',
  'tv-size',
  'tv-brand',
  'wall-surface',
  'metro-area',
  'location-id',
  'gallery-style',
  'fireplace-type',
  'mantelmount',
  'price',
  'performed-by',
  'street-name',
  'mount-type',
  'room-type',
  'bracket-type',
  'cable-management',
  'soundbar-mounting',
  'nearby-cities',
  'seed-index',
  'seed-count',
  'trigger-status',
  'trigger-source-code',
  'trigger-event',
]);

function redactSensitiveText(value, key = '', redactValues = []) {
  let text = String(value);
  text = text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted]');
  text = text.replace(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/g, '[redacted]');
  if (key === 'street-name' || key === 'local-reference') {
    text = text.replace(/^\s*\d+[A-Za-z\-/]*\s+/, '');
  }
  for (const redactValue of redactValues) {
    const needle = String(redactValue || '').trim();
    if (!needle) continue;
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(escaped, 'gi'), '[redacted]');
  }
  return text;
}

export function sanitizeSeed(seed = {}, { redactValues = [] } = {}) {
  const sanitized = {};
  for (const [key, rawValue] of Object.entries(seed || {})) {
    if (!ALLOWED_SEED_KEYS.has(key) || rawValue === undefined || rawValue === null) continue;
    if (Array.isArray(rawValue)) {
      if (key !== 'nearby-cities') continue;
      sanitized[key] = rawValue
        .filter((value) => typeof value === 'string')
        .map((value) => redactSensitiveText(value, key, redactValues));
    } else if (typeof rawValue === 'string') {
      sanitized[key] = redactSensitiveText(rawValue, key, redactValues);
    } else if (['number', 'boolean'].includes(typeof rawValue)) {
      sanitized[key] = rawValue;
    }
  }
  return sanitized;
}

function opaqueQueueRef(key = '') {
  return createHash('sha256').update(String(key)).digest('hex').slice(0, 12);
}

export function receiptKey(key = '') {
  return `r:${createHash('sha256').update(String(key)).digest('hex')}`;
}

export function normalizeRelayState(state = {}) {
  const entries = Object.entries(state.relayed || {});
  const changed = entries.some(([key]) => !key.startsWith('r:'));
  return {
    changed,
    state: {
      threadId: state.threadId || null,
      relayed: Object.fromEntries(
        entries.map(([key, value]) => [key.startsWith('r:') ? key : receiptKey(key), value]),
      ),
    },
  };
}

export function buildCodexSeedPrompt(item = {}) {
  const redactValues = [item.customerName, item.address].filter(Boolean);
  const seeds = (Array.isArray(item.seeds) && item.seeds.length ? item.seeds : [item.seed || {}])
    .map((seed) => sanitizeSeed(seed, { redactValues }));
  const ref = opaqueQueueRef(item.key || JSON.stringify(seeds));
  const seedLabel = seeds.length === 1 ? 'seed' : `${seeds.length} candidate seeds`;
  return [
    `Installation post seed staged (queue reference ${ref}; ${seedLabel}).`,
    'Do not publish, edit files, call tools, or contact anyone during this staging turn.',
    'Acknowledge that the seed is staged, then wait for Mr. Wayne to attach the matching installation photo in this Codex thread and explicitly ask you to publish.',
    'When that happens, follow this project\'s AGENTS.md and use only the seed matching that photo.',
    '',
    'Sanitized installation seed JSON:',
    '```json',
    JSON.stringify(seeds.length === 1 ? seeds[0] : seeds, null, 2),
    '```',
  ].join('\n');
}

export function buildMinimalCodexEnvironment(source = process.env) {
  return Object.fromEntries(
    ['HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL']
      .filter((key) => source[key])
      .map((key) => [key, source[key]]),
  );
}

export function assertOpenAIProvider(thread = {}) {
  if (thread.modelProvider !== REQUIRED_MODEL_PROVIDER) {
    throw new Error(`Codex relay requires modelProvider=${REQUIRED_MODEL_PROVIDER}; observed=${thread.modelProvider || 'none'}`);
  }
  return thread;
}

function turnStatus(turn) {
  return String(turn?.status || '').toLowerCase();
}

export class CodexAppServerClient {
  constructor({ command = 'codex', env = buildMinimalCodexEnvironment(), timeoutMs = 180_000 } = {}) {
    this.command = command;
    this.env = env;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.turnWaiters = new Map();
    this.completedTurns = new Map();
    this.stderrBytes = 0;
  }

  async start() {
    if (this.child) return;
    this.child = spawn(this.command, ['app-server'], {
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stderr.on('data', (chunk) => { this.stderrBytes += chunk.length; });
    this.child.on('error', (cause) => {
      const error = new Error(`Codex app-server process error code=${cause?.code || 'unknown'}`);
      for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(error); }
      for (const { reject, timer } of this.turnWaiters.values()) { clearTimeout(timer); reject(error); }
      this.pending.clear();
      this.turnWaiters.clear();
    });
    this.child.on('exit', (code) => {
      const error = new Error(`Codex app-server exited with code ${code}; stderr_bytes=${this.stderrBytes}`);
      for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(error); }
      for (const { reject, timer } of this.turnWaiters.values()) { clearTimeout(timer); reject(error); }
      this.pending.clear();
      this.turnWaiters.clear();
    });
    const lines = readline.createInterface({ input: this.child.stdout });
    lines.on('line', (line) => this.#handleLine(line));

    await this.request('initialize', {
      clientInfo: { name: 'the-agency-install-post-relay', title: 'Installation Posts Relay', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });
    this.notify('initialized', {});
    const accountResponse = await this.request('account/read', { refreshToken: false });
    if (accountResponse?.account?.type !== 'chatgpt') {
      throw new Error(`Codex relay requires ChatGPT subscription auth; observed=${accountResponse?.account?.type || 'none'}`);
    }
  }

  #handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (Object.hasOwn(message, 'id')) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`Codex RPC ${pending.method} failed code=${message.error.code ?? 'unknown'}`));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === 'turn/completed') {
      const turn = message.params?.turn;
      if (!turn?.id) return;
      const waiter = this.turnWaiters.get(turn.id);
      if (waiter) {
        this.turnWaiters.delete(turn.id);
        clearTimeout(waiter.timer);
        waiter.resolve(turn);
      } else {
        this.completedTurns.set(turn.id, turn);
      }
    }
  }

  request(method, params = {}) {
    if (!this.child?.stdin?.writable) return Promise.reject(new Error('Codex app-server is not running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex RPC ${method} timed out`));
      }, this.timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  waitForTurn(turnId) {
    const completed = this.completedTurns.get(turnId);
    if (completed) {
      this.completedTurns.delete(turnId);
      return Promise.resolve(completed);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.turnWaiters.delete(turnId);
        reject(new Error('Codex staging turn timed out'));
      }, this.timeoutMs);
      this.turnWaiters.set(turnId, { resolve, reject, timer });
    });
  }

  async stageSeed({ threadId, prompt, projectDir = DEFAULT_PROJECT_DIR }) {
    let activeThreadId = threadId;
    if (activeThreadId) {
      try {
        const resumed = await this.request('thread/resume', {
          threadId: activeThreadId,
          modelProvider: REQUIRED_MODEL_PROVIDER,
          cwd: projectDir,
        });
        assertOpenAIProvider(resumed?.thread);
      } catch {
        activeThreadId = null;
      }
    }
    if (!activeThreadId) {
      const started = await this.request('thread/start', {
        modelProvider: REQUIRED_MODEL_PROVIDER,
        cwd: projectDir,
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
        config: { mcp_servers: {} },
      });
      assertOpenAIProvider(started?.thread);
      activeThreadId = started?.thread?.id;
      if (!activeThreadId) throw new Error('Codex thread/start returned no thread id');
    }
    await this.request('thread/name/set', { threadId: activeThreadId, name: THREAD_NAME });
    let stageError = null;
    try {
      const startedTurn = await this.request('turn/start', {
        threadId: activeThreadId,
        input: [{ type: 'text', text: prompt, text_elements: [] }],
        cwd: projectDir,
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
        effort: 'low',
      });
      const turnId = startedTurn?.turn?.id;
      if (!turnId) throw new Error('Codex turn/start returned no turn id');
      const completed = await this.waitForTurn(turnId);
      if (turnStatus(completed) !== 'completed') {
        throw new Error(`Codex staging turn ended with status=${completed?.status || 'unknown'}`);
      }
      return { threadId: activeThreadId, turnId };
    } catch (error) {
      stageError = error;
      throw error;
    } finally {
      try {
        const restored = await this.request('thread/resume', {
          threadId: activeThreadId,
          modelProvider: REQUIRED_MODEL_PROVIDER,
          cwd: projectDir,
          approvalPolicy: 'on-request',
          sandbox: 'workspace-write',
        });
        assertOpenAIProvider(restored?.thread);
      } catch (restoreError) {
        if (!stageError) throw restoreError;
      }
    }
  }

  async readThread(threadId) {
    return this.request('thread/read', { threadId, includeTurns: true });
  }

  async close() {
    if (!this.child) return;
    this.child.stdin.end();
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill('SIGTERM');
        resolve();
      }, 2_000);
      this.child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
}

export async function relayPendingSeeds({ pending = [], state = {}, stageSeed, saveState, now = () => new Date().toISOString() }) {
  const nextState = normalizeRelayState(state).state;
  let relayed = 0;
  let skipped = 0;
  let lastTurnId = null;
  for (const item of [...pending].reverse()) {
    if (!item?.key) continue;
    const receipt = receiptKey(item.key);
    if (nextState.relayed[receipt]) {
      skipped += 1;
      continue;
    }
    const result = await stageSeed({
      threadId: nextState.threadId,
      prompt: buildCodexSeedPrompt(item),
      item,
    });
    nextState.threadId = result.threadId;
    lastTurnId = result.turnId || null;
    nextState.relayed[receipt] = now();
    const entries = Object.entries(nextState.relayed);
    if (entries.length > RECEIPT_LIMIT) nextState.relayed = Object.fromEntries(entries.slice(-RECEIPT_LIMIT));
    await saveState(nextState);
    relayed += 1;
  }
  return { relayed, skipped, threadId: nextState.threadId, lastTurnId };
}

async function loadJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function atomicWriteJson(filePath, value, mode = 0o600) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temp = `${filePath}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  await rename(temp, filePath);
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

export async function acquireLock(lockPath, allowStaleRecovery = true) {
  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  try {
    const handle = await open(lockPath, 'wx', 0o600);
    await handle.writeFile(String(process.pid));
    return async () => {
      await handle.close();
      await rm(lockPath, { force: true });
    };
  } catch (error) {
    if (error.code === 'EEXIST') {
      if (!allowStaleRecovery) return null;
      let existingPid = null;
      try {
        existingPid = Number.parseInt(await readFile(lockPath, 'utf8'), 10);
      } catch {
        return null;
      }
      if (processIsAlive(existingPid)) return null;
      await rm(lockPath, { force: true });
      return acquireLock(lockPath, false);
    }
    throw error;
  }
}

async function fetchPending(config) {
  const url = new URL(config.pendingUrl);
  url.searchParams.set('all', 'true');
  const response = await fetch(url, {
    headers: { 'x-install-post-secret': config.cronSecret },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Pending endpoint returned HTTP ${response.status}`);
  const body = await response.json();
  return Array.isArray(body.pending) ? body.pending : [];
}

function syntheticCanaryItem() {
  return {
    key: `canary:${Date.now()}`,
    seed: {
      city: 'Canary City',
      state: 'MN',
      'tv-size': '65"',
      'wall-surface': 'Drywall',
      'performed-by': 'Canary',
      price: '$0',
      'job-notes': 'Synthetic routing canary only',
      'trigger-source-code': 'codex-relay-canary',
    },
  };
}

async function runCli() {
  const args = new Set(process.argv.slice(2));
  const configPath = process.env.CODEX_INSTALL_POST_RELAY_CONFIG || DEFAULT_CONFIG_PATH;
  const statePath = process.env.CODEX_INSTALL_POST_RELAY_STATE || DEFAULT_STATE_PATH;
  const lockPath = process.env.CODEX_INSTALL_POST_RELAY_LOCK || DEFAULT_LOCK_PATH;
  const config = await loadJson(configPath, null);
  if (!config?.pendingUrl || !config?.cronSecret) throw new Error('Relay config is missing pendingUrl or cronSecret');
  const release = await acquireLock(lockPath);
  if (!release) {
    console.log('relay_status=skipped reason=already_running');
    return;
  }

  let client;
  try {
    const loadedState = await loadJson(statePath, { threadId: null, relayed: {} });
    const normalizedState = normalizeRelayState(loadedState);
    const state = normalizedState.state;
    if (normalizedState.changed) await atomicWriteJson(statePath, state);
    const pending = args.has('--canary') ? [syntheticCanaryItem()] : await fetchPending(config);
    if (args.has('--dry-run')) {
      const unrelayed = pending.filter((item) => item?.key && !state.relayed?.[receiptKey(item.key)] && !state.relayed?.[item.key]);
      console.log(`relay_status=dry_run pending=${pending.length} unrelayed=${unrelayed.length}`);
      return;
    }
    const unrelayed = pending.filter((item) => item?.key && !state.relayed?.[receiptKey(item.key)] && !state.relayed?.[item.key]);
    if (!args.has('--canary') && unrelayed.length === 0) {
      console.log(`relay_status=ok relayed=0 skipped=${pending.length} canary=false`);
      return;
    }
    client = new CodexAppServerClient({ command: config.codexCommand || 'codex' });
    await client.start();
    const result = await relayPendingSeeds({
      pending,
      state,
      stageSeed: ({ threadId, prompt }) => client.stageSeed({
        threadId,
        prompt,
        projectDir: config.projectDir || DEFAULT_PROJECT_DIR,
      }),
      saveState: (value) => atomicWriteJson(statePath, value),
    });
    if (args.has('--canary') && result.threadId) {
      const readBack = await client.readThread(result.threadId);
      const thread = readBack?.thread;
      const stagedTurnPresent = Array.isArray(thread?.turns)
        && thread.turns.some((turn) => turn?.id === result.lastTurnId && turn?.status === 'completed');
      if (thread?.id !== result.threadId || thread?.name !== THREAD_NAME || !stagedTurnPresent) {
        throw new Error('Codex canary read-back did not confirm the named thread and completed staging turn');
      }
    }
    console.log(`relay_status=ok relayed=${result.relayed} skipped=${result.skipped} canary=${args.has('--canary')}`);
  } finally {
    await client?.close();
    await release();
  }
}

const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isEntrypoint) {
  runCli().catch((error) => {
    console.error(`relay_status=error message=${String(error.message || error).replace(/[\r\n]+/g, ' ').slice(0, 240)}`);
    process.exitCode = 1;
  });
}
