#!/usr/bin/env node
// Install, reinstall, or remove the M1 install-post publish worker as a launchd agent.
//
//   node scripts/install-m1-install-post-worker.mjs --env-file /secure/path/.env
//   node scripts/install-m1-install-post-worker.mjs --uninstall
//
// First install and worker code updates both use the same command: it copies the
// current worker from this repo, refreshes the plist, and reloads launchd.
// The env file must hold INSTALL_POST_RUNNER_SECRET (same value as Vercel).
// It is copied into a 0600 secret file; the plist only carries its path.

import { execFileSync } from 'node:child_process';
import { access, chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LABEL = 'com.themountingman.install-post-worker';
const HOME = homedir();
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER_SRC = path.join(REPO_ROOT, 'm1/install-post-worker/install-post-worker.mjs');
const PLIST_TEMPLATE = path.join(REPO_ROOT, `m1/install-post-worker/${LABEL}.plist`);
const PLIST_DEST = path.join(HOME, `Library/LaunchAgents/${LABEL}.plist`);
const APP_DIR = path.join(HOME, '.local/share/themountingman/install-post-worker');
const WORKER_DEST = path.join(APP_DIR, 'install-post-worker.mjs');
const STATE_DIR = path.join(HOME, '.local/state/themountingman/install-post-worker');
const SECRET_FILE = path.join(HOME, '.config/themountingman/install-post-worker/runner-secret');
const DEFAULT_WRAPPER = path.join(HOME, 'jewel-way-run/bin/run_fast_install_post.sh');

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function parseEnvFile(content) {
  const values = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const match = rawLine.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
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

function launchctl(args) {
  execFileSync('/bin/launchctl', args, { stdio: 'ignore' });
}

function bootout(domain) {
  try {
    launchctl(['bootout', `${domain}/${LABEL}`]);
  } catch {
    // Not loaded yet.
  }
}

async function uninstall(domain) {
  bootout(domain);
  await rm(PLIST_DEST, { force: true });
  console.log(`install_status=ok label=${LABEL} launchd=removed`);
}

async function install(domain) {
  const envFile = argValue('--env-file');
  if (!envFile) {
    throw new Error('Usage: node scripts/install-m1-install-post-worker.mjs --env-file /secure/path/.env [--wrapper PATH]');
  }
  const secret = String(parseEnvFile(await readFile(path.resolve(envFile), 'utf8')).INSTALL_POST_RUNNER_SECRET || '').trim();
  if (!secret) throw new Error('INSTALL_POST_RUNNER_SECRET is absent from the supplied environment file');

  const wrapper = path.resolve(argValue('--wrapper') || DEFAULT_WRAPPER);
  await access(wrapper, fsConstants.X_OK);
  const nodePath = execFileSync('/bin/zsh', ['-lc', 'command -v node'], { encoding: 'utf8' }).trim();

  await atomicWrite(SECRET_FILE, `${secret}\n`, 0o600);
  await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  await mkdir(APP_DIR, { recursive: true, mode: 0o700 });
  await copyFile(WORKER_SRC, WORKER_DEST);
  await chmod(WORKER_DEST, 0o700);

  const plist = (await readFile(PLIST_TEMPLATE, 'utf8'))
    .replaceAll('__NODE_PATH__', nodePath)
    .replaceAll('__WORKER_SCRIPT__', WORKER_DEST)
    .replaceAll('__HOME__', HOME)
    .replaceAll('__SECRET_FILE__', SECRET_FILE)
    .replaceAll('__WRAPPER__', wrapper)
    .replaceAll('__STATE_DIR__', STATE_DIR);
  await atomicWrite(PLIST_DEST, plist, 0o600);
  execFileSync('/usr/bin/plutil', ['-lint', PLIST_DEST], { stdio: 'ignore' });

  bootout(domain);
  launchctl(['bootstrap', domain, PLIST_DEST]);
  console.log(`install_status=ok label=${LABEL} secret_mode=0600 launchd=loaded`);
}

async function main() {
  const domain = `gui/${process.getuid()}`;
  if (process.argv.includes('--uninstall')) return uninstall(domain);
  return install(domain);
}

main().catch((error) => {
  console.error(`install_status=error message=${String(error.message || error).replace(/[\r\n]+/g, ' ').slice(0, 240)}`);
  process.exitCode = 1;
});
