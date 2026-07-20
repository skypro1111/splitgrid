#!/usr/bin/env node

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, chmodSync, existsSync, unlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOOK_EVENT_NAMES } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOME = homedir();
const CLAUDE_DIR = join(HOME, '.claude');
const HOOKS_DIR = join(CLAUDE_DIR, 'hooks');
const SETTINGS_PATH = join(CLAUDE_DIR, 'settings.json');
const PLIST_LABEL = 'com.splitgrid.claude-hooks-daemon';
const PLIST_PATH = join(HOME, 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`);
const REPORTER_DEST = join(HOOKS_DIR, 'hook-reporter.sh');

const command = process.argv[2];

function printUsage(): void {
  console.log('Usage: claude-hooks-install <command>');
  console.log('');
  console.log('Commands:');
  console.log('  install     Register hooks in ~/.claude/settings.json + launchd service');
  console.log('  uninstall   Remove hooks and launchd service');
  console.log('  status      Check daemon status');
}

function installReporterScript(): void {
  mkdirSync(HOOKS_DIR, { recursive: true });
  const src = join(__dirname, 'hook-reporter.sh');
  if (!existsSync(src)) {
    // fallback: write inline
    writeFileSync(REPORTER_DEST, `#!/bin/bash
DAEMON_PORT="\${CLAUDE_HOOKS_PORT:-19557}"
cat | curl -s -X POST "http://127.0.0.1:\${DAEMON_PORT}/event" \\
  -H "Content-Type: application/json" -d @- > /dev/null 2>&1
exit 0
`);
  } else {
    copyFileSync(src, REPORTER_DEST);
  }
  chmodSync(REPORTER_DEST, 0o755);
  console.log(`  Installed ${REPORTER_DEST}`);
}

function registerHooks(): void {
  let settings: Record<string, unknown> = {};
  if (existsSync(SETTINGS_PATH)) {
    try {
      settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'));
    } catch {
      console.warn('  Warning: could not parse existing settings.json, creating new one');
    }
  }

  const hooks: Record<string, Array<{ hooks: Array<{ type: string; command: string }> }>> =
    (settings.hooks as typeof hooks) || {};

  // Events that don't support matchers — register without matcher
  const noMatcherEvents = new Set([
    'UserPromptSubmit', 'Stop', 'TeammateIdle',
    'TaskCreated', 'TaskCompleted', 'WorktreeCreate', 'WorktreeRemove',
    'CwdChanged',
  ]);

  for (const eventName of HOOK_EVENT_NAMES) {
    // Skip SessionStart — only supports type: "command", already fine
    const existing = hooks[eventName] || [];

    // Check if our hook is already registered
    const alreadyRegistered = existing.some((group) =>
      group.hooks?.some((h) => h.command?.includes('hook-reporter.sh'))
    );
    if (alreadyRegistered) continue;

    const hookEntry = {
      type: 'command' as const,
      command: `"${REPORTER_DEST}"`,
    };

    if (noMatcherEvents.has(eventName)) {
      existing.push({ hooks: [hookEntry] });
    } else {
      existing.push({ matcher: '*' as never, hooks: [hookEntry] } as never);
    }

    hooks[eventName] = existing;
  }

  settings.hooks = hooks;
  mkdirSync(CLAUDE_DIR, { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
  console.log(`  Updated ${SETTINGS_PATH}`);
}

function installLaunchd(): void {
  const serverPath = join(__dirname, 'server.js');
  const nodePath = process.execPath;
  const logPath = join(CLAUDE_DIR, 'hooks-daemon.log');
  const errPath = join(CLAUDE_DIR, 'hooks-daemon.err');

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${serverPath}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${errPath}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>`;

  mkdirSync(dirname(PLIST_PATH), { recursive: true });
  writeFileSync(PLIST_PATH, plist);
  console.log(`  Created ${PLIST_PATH}`);

  try {
    execSync(`launchctl unload "${PLIST_PATH}" 2>/dev/null`, { stdio: 'ignore' });
  } catch { /* ignore */ }
  execSync(`launchctl load "${PLIST_PATH}"`);
  console.log(`  Loaded launchd service: ${PLIST_LABEL}`);
}

function uninstallLaunchd(): void {
  try {
    execSync(`launchctl unload "${PLIST_PATH}" 2>/dev/null`);
    console.log(`  Unloaded launchd service`);
  } catch { /* ignore */ }

  if (existsSync(PLIST_PATH)) {
    unlinkSync(PLIST_PATH);
    console.log(`  Removed ${PLIST_PATH}`);
  }
}

function removeHooks(): void {
  if (!existsSync(SETTINGS_PATH)) return;

  try {
    const settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'));
    const hooks = settings.hooks as Record<string, unknown[]> | undefined;
    if (!hooks) return;

    for (const eventName of Object.keys(hooks)) {
      const groups = hooks[eventName] as Array<{ hooks?: Array<{ command?: string }> }>;
      hooks[eventName] = groups.filter((group) =>
        !group.hooks?.some((h) => h.command?.includes('hook-reporter.sh'))
      );
      if ((hooks[eventName] as unknown[]).length === 0) {
        delete hooks[eventName];
      }
    }

    if (Object.keys(hooks).length === 0) {
      delete settings.hooks;
    }

    writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
    console.log(`  Cleaned hooks from ${SETTINGS_PATH}`);
  } catch {
    console.warn('  Warning: could not clean settings.json');
  }
}

async function checkStatus(): Promise<void> {
  try {
    const res = await fetch('http://127.0.0.1:19557/status');
    const data = await res.json();
    console.log('Daemon is running:');
    console.log(`  Port: ${(data as { port: number }).port}`);
    console.log(`  Uptime: ${Math.round((data as { uptime: number }).uptime / 1000)}s`);
    console.log(`  Active sessions: ${(data as { sessions: number }).sessions}`);
    console.log(`  Total events: ${(data as { totalEvents: number }).totalEvents}`);
  } catch {
    console.log('Daemon is not running.');
  }
}

// --- Main ---

switch (command) {
  case 'install':
    console.log('Installing claude-hooks-daemon...\n');
    installReporterScript();
    registerHooks();
    installLaunchd();
    console.log('\nDone! Daemon is running on port 19557.');
    break;

  case 'uninstall':
    console.log('Uninstalling claude-hooks-daemon...\n');
    uninstallLaunchd();
    removeHooks();
    console.log('\nDone!');
    break;

  case 'status':
    await checkStatus();
    break;

  default:
    printUsage();
    break;
}
