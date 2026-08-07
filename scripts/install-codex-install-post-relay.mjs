#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { chmod, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = homedir();
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RELAY_SCRIPT = path.join(SCRIPT_DIR, 'codex-install-post-relay.mjs');
const PLIST_TEMPLATE = path.join(SCRIPT_DIR, 'launchd/ai.theagency.codex-install-post-relay.plist');
const PLIST_DEST = path.join(HOME, 'Library/LaunchAgents/ai.theagency.codex-install-post-relay.plist');
const CONFIG_PATH = path.join(HOME, '.config/the-agency/codex-install-post-relay.json');
const PROJECT_DIR = path.join(HOME, 'vault-local/Projects/Mounting-Man/installation-posts-codex');
const LOG_DIR = path.join(HOME, '.local/state/the-agency/codex-install-post-relay');
const INSTALLED_SCRIPT = path.join(HOME, '.local/lib/the-agency/codex-install-post-relay.mjs');
const PENDING_URL = 'https://mounting-man-dashboard.vercel.app/api/install-post/pending';

function parseEnvFile(content) {
  const values = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value.replace(/\\n/g, '\n');
  }
  return values;
}

async function atomicWrite(filePath, content, mode) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temp = `${filePath}.${process.pid}.tmp`;
  await writeFile(temp, content, { mode });
  await rename(temp, filePath);
  await chmod(filePath, mode);
}

function commandPath(command) {
  return execFileSync('/bin/zsh', ['-lc', `command -v ${command}`], { encoding: 'utf8' }).trim();
}

async function main() {
  const envIndex = process.argv.indexOf('--env-file');
  if (envIndex < 0 || !process.argv[envIndex + 1]) {
    throw new Error('Usage: node scripts/install-codex-install-post-relay.mjs --env-file /secure/path/.env');
  }
  const envFile = path.resolve(process.argv[envIndex + 1]);
  const values = parseEnvFile(await readFile(envFile, 'utf8'));
  if (!values.CRON_SECRET) throw new Error('CRON_SECRET is absent from the supplied environment file');

  const nodePath = commandPath('node');
  const codexPath = commandPath('codex');
  await mkdir(PROJECT_DIR, { recursive: true, mode: 0o700 });
  await mkdir(LOG_DIR, { recursive: true, mode: 0o700 });
  await atomicWrite(CONFIG_PATH, `${JSON.stringify({
    pendingUrl: PENDING_URL,
    cronSecret: values.CRON_SECRET,
    codexCommand: codexPath,
    projectDir: PROJECT_DIR,
  }, null, 2)}\n`, 0o600);
  await mkdir(path.dirname(INSTALLED_SCRIPT), { recursive: true, mode: 0o700 });
  await copyFile(RELAY_SCRIPT, INSTALLED_SCRIPT);
  await chmod(INSTALLED_SCRIPT, 0o700);

  let plist = await readFile(PLIST_TEMPLATE, 'utf8');
  plist = plist
    .replaceAll('__NODE_PATH__', nodePath)
    .replaceAll('__RELAY_SCRIPT__', INSTALLED_SCRIPT)
    .replaceAll('__LOG_DIR__', LOG_DIR)
    .replaceAll('__REPO_DIR__', PROJECT_DIR);
  await atomicWrite(PLIST_DEST, plist, 0o600);
  execFileSync('/usr/bin/plutil', ['-lint', PLIST_DEST], { stdio: 'ignore' });

  const label = 'ai.theagency.codex-install-post-relay';
  const domain = `gui/${process.getuid()}`;
  try {
    execFileSync('/bin/launchctl', ['bootout', `${domain}/${label}`], { stdio: 'ignore' });
  } catch {
    // Fresh install: no previously loaded service to remove.
  }
  execFileSync('/bin/launchctl', ['bootstrap', domain, PLIST_DEST], { stdio: 'ignore' });
  execFileSync('/bin/launchctl', ['kickstart', '-k', `${domain}/${label}`], { stdio: 'ignore' });

  console.log(`install_status=ok label=${label} config_mode=0600 launchd=loaded`);
}

main().catch((error) => {
  console.error(`install_status=error message=${String(error.message || error).replace(/[\r\n]+/g, ' ').slice(0, 240)}`);
  process.exitCode = 1;
});
