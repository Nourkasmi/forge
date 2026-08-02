const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execSync } = require('child_process');

let mainWindow = null;
const sessions = new Map();
let nextSessionId = 1;
let CLAUDE_BIN = null;
let NPM_BIN = 'npm';
let setupChild = null;
let loginInFlight = false;
let loginAttemptSeq = 0;

const CLAUDE_PKG = '@anthropic-ai/claude-code';
const IS_WIN = process.platform === 'win32';

function getLogPath() {
  return path.join(app.getPath('userData'), 'setup.log');
}

function getChatLogPath() {
  return path.join(app.getPath('userData'), 'chat.log');
}

function appendLog(text) {
  try {
    const p = getLogPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, text);
  } catch {}
}

function appendChatLog(text) {
  try {
    const p = getChatLogPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, text);
  } catch {}
}

function logHeader(title) {
  const ts = new Date().toISOString();
  appendLog(`\n===== ${ts} — ${title} =====\nplatform=${process.platform} arch=${process.arch} node=${process.versions.node} electron=${process.versions.electron}\n`);
}

function looksLikeAdminError(stderr) {
  const s = (stderr || '').toLowerCase();
  return /eperm|eacces|access is denied|permission denied|operation not permitted|elevation.*required|requires elevation/i.test(s);
}

function resolveNpmPath() {
  const candidates = IS_WIN
    ? [
        'C:\\Program Files\\nodejs\\npm.cmd',
        'C:\\Program Files (x86)\\nodejs\\npm.cmd',
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'npm.cmd'),
        path.join(process.env.APPDATA || '', 'npm', 'npm.cmd'),
      ]
    : [
        '/usr/local/bin/npm',
        '/usr/bin/npm',
        '/opt/homebrew/bin/npm',
        path.join(process.env.HOME || '', '.nvm/versions/node/current/bin/npm'),
      ];
  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) return c; } catch {}
  }
  return 'npm';
}

function resolveClaudePath() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  try {
    const cmd = IS_WIN ? 'where claude' : 'command -v claude 2>/dev/null || which claude 2>/dev/null';
    const opts = IS_WIN ? { encoding: 'utf8' } : { shell: '/bin/bash', encoding: 'utf8' };
    const lines = execSync(cmd, opts).trim().split(/\r?\n/).filter(Boolean);
    if (IS_WIN) {
      // `where` returns every match (e.g. \claude, \claude.cmd, \claude.ps1).
      // Windows spawn cannot execute the extension-less POSIX shim OR .ps1
      // from cmd.exe /c; only .cmd, .bat, and .exe are safe.
      const cmdVar = lines.find((p) => /\.cmd$/i.test(p));
      if (cmdVar && fs.existsSync(cmdVar)) return cmdVar;
      const batVar = lines.find((p) => /\.bat$/i.test(p));
      if (batVar && fs.existsSync(batVar)) return batVar;
      const exeVar = lines.find((p) => /\.exe$/i.test(p));
      if (exeVar && fs.existsSync(exeVar)) return exeVar;
    } else if (lines[0] && fs.existsSync(lines[0])) {
      return lines[0];
    }
  } catch {}
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const candidates = IS_WIN
    ? [
        path.join(process.env.APPDATA || '', 'npm', 'claude.cmd'),
        path.join(home, 'AppData', 'Roaming', 'npm', 'claude.cmd'),
        'C:\\Program Files\\nodejs\\claude.cmd',
      ]
    : [
        path.join(home, '.local/bin/claude'),
        '/usr/local/bin/claude',
        '/opt/homebrew/bin/claude',
        '/usr/bin/claude',
      ];
  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) return c; } catch {}
  }
  return 'claude';
}

/**
 * The single subprocess-spawning helper for all external tools (claude, npm, etc.).
 *
 * Windows quirks handled in one place:
 *   - .cmd/.bat/.ps1 shims cannot be spawned directly since Node 18.20.2 / 20.12.2
 *     (CVE-2024-27980). We route through cmd.exe /d /s /c.
 *   - Node.spawn does NOT honor PATHEXT for bare names; cmd.exe does.
 *   - `/d`  disables autorun scripts, which is the main cause of stdout pollution
 *          (any AutoRun registry command would otherwise fire and print to stdout).
 *   - `/s`  gives cmd.exe the "wrap entire remainder in quotes" parsing rule,
 *          which lets our carefully-built cmdline pass through with its own
 *          quoting intact.
 *   - `/c`  run and exit — no interactive prompt after the child terminates.
 *   - windowsVerbatimArguments: true — Node passes args to cmd.exe verbatim
 *          (otherwise Node would double-escape our already-escaped cmdline).
 *   - windowsHide: true — no console window flash.
 *   - Arg escaping: each arg is doubled-quote-escaped and wrapped in "..." when it
 *     contains any char cmd.exe would interpret. `%` is doubled to `%%` so cmd.exe's
 *     variable expansion inside quotes leaves the literal `%` intact for the child.
 */
function spawnSafe(bin, args, opts = {}) {
  const { logTo, ...spawnOpts } = opts;
  const options = { env: process.env, ...spawnOpts };
  if (IS_WIN) {
    const escapeArg = (a) => {
      const s = String(a).replace(/%/g, '%%');
      if (s === '' || /[\s"^&|<>()!%]/.test(s)) {
        return '"' + s.replace(/"/g, '""') + '"';
      }
      return s;
    };
    const binQuoted = /\s/.test(bin)
      ? '"' + String(bin).replace(/"/g, '""') + '"'
      : bin;
    const line = [binQuoted, ...args.map(escapeArg)].join(' ');
    if (typeof logTo === 'function') {
      logTo(`[spawn win] cmd.exe /d /s /c <line>  (windowsVerbatimArguments)\n`);
      logTo(`[spawn line] ${line}\n`);
      logTo(`[spawn line-has-newline] ${line.includes('\n')} line-len=${line.length}\n`);
    }
    return spawn('cmd.exe', ['/d', '/s', '/c', line], {
      ...options,
      windowsVerbatimArguments: true,
      windowsHide: true,
    });
  }
  if (typeof logTo === 'function') {
    logTo(`[spawn unix] ${bin} ${args.map((a) => JSON.stringify(a)).join(' ')}\n`);
  }
  return spawn(bin, args, options);
}

function spawnClaude(args, opts) {
  return spawnSafe(CLAUDE_BIN, args, opts);
}

function spawnNpm(args, opts) {
  return spawnSafe(NPM_BIN, args, opts);
}

/**
 * Kill a child process AND its descendants. On Windows, child.kill() only kills
 * the immediate child (cmd.exe in our wrapping); it does NOT cascade to the
 * grandchild (node.exe / npm / claude). Without taskkill /T, killing cmd.exe
 * leaves the actual work process orphaned.
 */
function killChildTree(child) {
  if (!child) return;
  const pid = child.pid;
  if (IS_WIN && pid) {
    try {
      const killer = spawn('taskkill', ['/F', '/T', '/PID', String(pid)], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.on('error', () => {});
    } catch {}
  }
  try { child.kill('SIGKILL'); } catch {}
}

function spawnCollect(cmd, args, options = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawnSafe(cmd, args, options);
    } catch (err) {
      resolve({ ok: false, code: -1, error: err.message, stdout, stderr });
      return;
    }
    let timer;
    if (options.timeoutMs) {
      timer = setTimeout(() => killChildTree(child), options.timeoutMs);
    }
    child.stdout?.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr?.on('data', (d) => { stderr += d.toString('utf8'); });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ ok: false, code: -1, error: err.message, stdout, stderr });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });
}

async function probeClaude(binPath) {
  const bin = binPath || CLAUDE_BIN;
  const res = await spawnCollect(bin, ['--version'], { timeoutMs: 5000 });
  if (res.ok && /\d/.test(res.stdout)) {
    return { ok: true, version: res.stdout.trim(), bin };
  }
  return { ok: false, error: res.stderr || res.error || `Exit ${res.code}` };
}

async function probeNpm() {
  let res = await spawnCollect('npm', ['--version'], { timeoutMs: 5000 });
  if (res.ok && /\d/.test(res.stdout)) {
    NPM_BIN = 'npm';
    return { ok: true, version: res.stdout.trim(), bin: NPM_BIN };
  }
  const disk = resolveNpmPath();
  if (disk !== 'npm') {
    res = await spawnCollect(disk, ['--version'], { timeoutMs: 5000 });
    if (res.ok && /\d/.test(res.stdout)) {
      NPM_BIN = disk;
      return { ok: true, version: res.stdout.trim(), bin: NPM_BIN };
    }
  }
  return { ok: false, error: res.stderr || res.error || `Exit ${res.code}` };
}

async function findClaudeAfterInstall() {
  // Ask npm exactly where it installed things. Never accept the bare name
  // 'claude' as a resolved bin — Windows spawn needs the concrete .cmd path.
  const prefixRes = await spawnCollect(NPM_BIN, ['config', 'get', 'prefix'], { timeoutMs: 5000 });
  const prefix = prefixRes.ok ? prefixRes.stdout.trim() : null;

  const home = process.env.HOME || process.env.USERPROFILE || '';
  const candidates = IS_WIN
    ? [
        prefix && path.join(prefix, 'claude.cmd'),
        prefix && path.join(prefix, 'claude.ps1'),
        path.join(process.env.APPDATA || '', 'npm', 'claude.cmd'),
        path.join(home, 'AppData', 'Roaming', 'npm', 'claude.cmd'),
        'C:\\Program Files\\nodejs\\claude.cmd',
      ]
    : [
        prefix && path.join(prefix, 'bin', 'claude'),
        prefix && path.join(prefix, 'claude'),
        path.join(home, '.local/bin/claude'),
        '/usr/local/bin/claude',
        '/opt/homebrew/bin/claude',
      ];

  appendLog(`findClaudeAfterInstall: npm prefix=${prefix}\n`);
  for (const c of candidates) {
    if (c && fs.existsSync(c)) {
      appendLog(`  probing ${c}\n`);
      const probe = await probeClaude(c);
      if (probe.ok) {
        appendLog(`  resolved: ${c} (version ${probe.version})\n`);
        return probe;
      }
    }
  }

  // Last-ditch: fall back to bare 'claude' via shell resolution. This is
  // only safe because every downstream spawn goes through spawnClaude, which
  // routes through cmd.exe on Windows and can resolve PATHEXT itself.
  const bare = await probeClaude('claude');
  if (bare.ok) {
    appendLog(`  resolved via shell PATH (bin=claude, no absolute path found)\n`);
    return bare;
  }

  return { ok: false, error: 'Installed, but the claude binary was not found on disk.' };
}

/**
 * Authoritative auth check via `claude auth status --json`.
 * Returns { loggedIn, email?, subscriptionType?, authMethod?, error?, reason? }.
 * `reason` is a stable code for the renderer to branch on:
 *   - 'ok'         loggedIn = true
 *   - 'no_bin'     claude binary is missing or unusable
 *   - 'no_auth'    binary works, user isn't signed in
 *   - 'unknown'    something else went wrong
 */
async function checkAuthStatus() {
  let child;
  try {
    child = spawnClaude(['auth', 'status', '--json'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    return { loggedIn: false, reason: 'no_bin', error: e.message };
  }
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => killChildTree(child), 10000);
    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ loggedIn: false, reason: 'no_bin', error: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const combined = (stdout + stderr).trim();
      // Try to find the JSON payload inside whatever the CLI printed.
      const match = stdout.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          const parsed = JSON.parse(match[0]);
          if (parsed && typeof parsed.loggedIn === 'boolean') {
            return resolve({
              loggedIn: parsed.loggedIn,
              email: parsed.email || null,
              authMethod: parsed.authMethod || null,
              subscriptionType: parsed.subscriptionType || null,
              orgName: parsed.orgName || null,
              reason: parsed.loggedIn ? 'ok' : 'no_auth',
            });
          }
        } catch {}
      }
      // Fall back to string heuristics.
      if (/not (logged|signed) in|no.*auth|please (log|sign) in/i.test(combined)) {
        return resolve({ loggedIn: false, reason: 'no_auth', error: combined.slice(0, 400) });
      }
      if (code === 0) {
        // Command succeeded but we couldn't parse — treat as unknown, don't lie.
        return resolve({ loggedIn: false, reason: 'unknown', error: combined.slice(0, 400) || 'auth status returned no parseable output' });
      }
      resolve({ loggedIn: false, reason: 'unknown', error: combined.slice(0, 400) || `auth status exit ${code}` });
    });
  });
}

// Back-compat shim for older callers.
async function isAuthenticated() {
  const s = await checkAuthStatus();
  return s.loggedIn;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Forge',
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  CLAUDE_BIN = resolveClaudePath();
  createWindow();
});

app.on('window-all-closed', () => {
  for (const child of sessions.values()) killChildTree(child);
  sessions.clear();
  if (setupChild) {
    killChildTree(setupChild);
    setupChild = null;
  }
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

ipcMain.handle('app:info', () => ({ claudeBin: CLAUDE_BIN, home: process.env.HOME }));

ipcMain.handle('auth:status', async () => {
  // Cheap when there's no binary yet; the CLI path is validated up-front.
  if (!CLAUDE_BIN) return { loggedIn: false, reason: 'no_bin' };
  return await checkAuthStatus();
});

ipcMain.handle('setup:status', async () => {
  if (process.env.FORGE_FORCE_SETUP) {
    const npm = await probeNpm();
    return { needsSetup: true, hasClaude: false, hasNpm: npm.ok, forced: true };
  }
  const claude = await probeClaude();
  if (claude.ok) {
    CLAUDE_BIN = claude.bin;
    // Also fold in an authoritative auth check — a "hasClaude but not signed in"
    // state is a real one and the renderer wants to know without a second RTT.
    const auth = await checkAuthStatus();
    return {
      needsSetup: false,
      hasClaude: true,
      claudeVersion: claude.version,
      auth,
    };
  }
  const npm = await probeNpm();
  return { needsSetup: true, hasClaude: false, hasNpm: npm.ok, npmVersion: npm.version };
});

ipcMain.handle('setup:install', async () => {
  return new Promise((resolve) => {
    logHeader(`npm install -g ${CLAUDE_PKG}`);
    appendLog(`npm bin: ${NPM_BIN}\n`);
    let child;
    try {
      child = spawnNpm(['install', '-g', CLAUDE_PKG], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      appendLog(`spawn threw: ${err.message}\n`);
      resolve({
        ok: false,
        error: friendlyInstallError(err.message),
        details: err.message,
        logPath: getLogPath(),
      });
      return;
    }
    setupChild = child;
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      const s = d.toString('utf8');
      stdout += s;
      appendLog(s);
      sendToRenderer('setup:progress', { phase: 'installing' });
    });
    child.stderr.on('data', (d) => {
      const s = d.toString('utf8');
      stderr += s;
      appendLog(s);
      sendToRenderer('setup:progress', { phase: 'installing' });
    });
    child.on('error', (err) => {
      setupChild = null;
      appendLog(`\nchild error: ${err.message}\n`);
      resolve({
        ok: false,
        error: friendlyInstallError(err.message),
        details: err.message,
        logPath: getLogPath(),
      });
    });
    child.on('close', async (code) => {
      setupChild = null;
      appendLog(`\nexit code: ${code}\n`);
      if (code !== 0) {
        const combined = (stderr + '\n' + stdout).trim();
        const needsAdmin = IS_WIN && looksLikeAdminError(combined);
        if (needsAdmin) {
          resolve({
            ok: false,
            errorKind: 'needs_admin',
            error: 'Windows blocked the installer because Forge does not have administrator access. Close Forge, right-click its icon, choose "Run as administrator", and then run the setup again. You only need to do this once.',
            details: combined.slice(-3000),
            logPath: getLogPath(),
          });
          return;
        }
        resolve({
          ok: false,
          errorKind: 'generic',
          error: friendlyInstallError(stderr, code),
          details: combined.slice(-3000),
          logPath: getLogPath(),
        });
        return;
      }
      const found = await findClaudeAfterInstall();
      if (!found.ok) {
        appendLog(`\npost-install lookup failed: ${found.error}\n`);
        resolve({
          ok: false,
          error: 'Installed successfully, but Forge could not find the new tools. Restarting your computer usually fixes this.',
          details: found.error,
          logPath: getLogPath(),
        });
        return;
      }
      CLAUDE_BIN = found.bin;
      appendLog(`\nresolved claude bin: ${found.bin} (version ${found.version})\n`);
      resolve({ ok: true, version: found.version, bin: found.bin });
    });
  });
});

function friendlyInstallError(raw, code) {
  const s = (raw || '').toLowerCase();
  if (/eacces|permission denied/i.test(s)) {
    return 'The installer did not have permission to add the tools. On Windows, right-click Forge and choose "Run as administrator". On Mac/Linux, contact whoever set up your computer.';
  }
  if (/enotfound|econnrefused|network|proxy|timeout|etimedout|getaddrinfo/i.test(s)) {
    return 'Could not reach the internet. Check your Wi-Fi and try again.';
  }
  if (/enoent/i.test(s)) {
    return 'Node.js seems to have moved or been uninstalled. Please reinstall it and try again.';
  }
  return code ? `The installer stopped unexpectedly (code ${code}). Try again.` : 'The installer stopped unexpectedly. Try again.';
}

ipcMain.handle('log:debug', (_e, text) => {
  if (typeof text === 'string' && text.length > 0) appendLog(text.endsWith('\n') ? text : text + '\n');
});

ipcMain.handle('setup:login', async () => {
  // HARD MUTEX. Two rapid-fire clicks (or two concurrent entry points — top-bar
  // Sign in, setup flow, pre-send check — racing each other) would otherwise
  // each spawn `claude auth login --claudeai`, each opening a browser tab with
  // its own OAuth session. When the user pastes a code, it goes to whichever
  // subprocess was assigned to setupChild last — usually the wrong one.
  if (loginInFlight) {
    appendLog(`\n[setup:login] REJECTED — another sign-in already in flight (attempt #${loginAttemptSeq})\n`);
    return { ok: false, error: 'A sign-in is already in progress.', alreadyInFlight: true };
  }
  loginInFlight = true;
  const attemptId = ++loginAttemptSeq;
  logHeader(`sign-in attempt #${attemptId} — claude auth login --claudeai`);
  appendLog(`claude bin: ${CLAUDE_BIN}\n`);

  try {
    // Kill any leftover subprocess from a previous attempt (belt-and-suspenders).
    if (setupChild) {
      appendLog(`[attempt #${attemptId}] killing stray setupChild before starting\n`);
      killChildTree(setupChild);
      setupChild = null;
    }

    const already = await checkAuthStatus();
    appendLog(`[attempt #${attemptId}] pre-check: ${JSON.stringify(already)}\n`);
    if (already.loggedIn) return { ok: true, auth: already, attemptId };

    const result = await runAuthLogin(attemptId);
    appendLog(`\n[attempt #${attemptId}] runAuthLogin summary: ok=${result.ok} exitCode=${result.code ?? '?'} killedForAuth=${result.killedForAuth ?? false}\n`);

    const finalStatus = await checkAuthStatus();
    appendLog(`[attempt #${attemptId}] post-login: ${JSON.stringify(finalStatus)}\n`);
    if (finalStatus.loggedIn) return { ok: true, auth: finalStatus, attemptId };

    const details = [
      `Attempt #${attemptId}`,
      'Command: claude auth login --claudeai',
      `Bin: ${CLAUDE_BIN}`,
      `Exit code: ${result.code ?? '(killed)'}`,
      `Killed by us after successful auth: ${result.killedForAuth ?? false}`,
      '',
      '--- Subprocess output (last 3KB) ---',
      (result.combined || '(no output captured)').slice(-3000),
      '',
      '--- Final auth status probe ---',
      JSON.stringify(finalStatus, null, 2),
    ].join('\n');

    return {
      ok: false,
      error: 'Sign-in did not complete. Please try again, or open the setup log for details.',
      details,
      logPath: getLogPath(),
      authReason: finalStatus.reason,
      attemptId,
    };
  } finally {
    loginInFlight = false;
    appendLog(`[attempt #${attemptId}] setup:login handler released mutex\n`);
  }
});

/**
 * Drive `claude auth login --claudeai` — the CLI's dedicated OAuth-via-browser
 * command for Claude subscriptions. Unlike the interactive `claude` wizard,
 * this subcommand:
 *   - is scriptable (doesn't require a real TTY for the login step itself)
 *   - prints its OAuth URL to stdout in a stable format
 *   - waits for the OAuth callback on a local port, then exits with code 0
 *
 * We open the URL in the OS browser as soon as we see it, and poll
 * `claude auth status --json` for authoritative completion — the subprocess
 * exit code is treated as informational only.
 */
function runAuthLogin(attemptId = '?') {
  const tag = `[attempt #${attemptId}]`;
  return new Promise((resolve) => {
    appendLog(`\n${tag} >>> spawn: ${CLAUDE_BIN} auth login --claudeai\n`);
    let child;
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      resolve(payload);
    };
    try {
      child = spawnClaude(['auth', 'login', '--claudeai'], {
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', TERM: 'dumb' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      appendLog(`spawn threw: ${err.message}\n`);
      finish({ ok: false, code: -1, combined: err.message });
      return;
    }
    setupChild = child;
    // IMPORTANT: keep stdin OPEN. The CLI's OAuth flow uses an
    // authorization-code paste-back model — after the user completes the
    // browser flow, it waits on stdin for the code to be pasted. We forward
    // that code via the `setup:submitCode` IPC handler below.

    let combined = '';
    let urlOpened = false;
    const openUrlIfSeen = () => {
      if (urlOpened) return;
      // Match any https URL; prefer known Anthropic hosts if multiple appear.
      const urls = combined.match(/https?:\/\/[^\s\r\n"'`)>]+/g) || [];
      const preferred = urls.find((u) => /anthropic|claude/i.test(u)) || urls[0];
      if (preferred) {
        urlOpened = true;
        appendLog(`${tag} [detected url] ${preferred}\n`);
        shell.openExternal(preferred).catch(() => {});
        sendToRenderer('setup:progress', { phase: 'loggingIn', urlOpened: true, url: preferred });
      }
    };

    child.stdout.on('data', (d) => {
      const s = d.toString('utf8');
      combined += s;
      appendLog(`${tag} [stdout] ${s}`);
      openUrlIfSeen();
    });
    child.stderr.on('data', (d) => {
      const s = d.toString('utf8');
      combined += s;
      appendLog(`${tag} [stderr] ${s}`);
      openUrlIfSeen();
    });

    let doneChecks = 0;
    const MAX_CHECKS = 60; // 5 min at 5s intervals
    const checkInterval = setInterval(async () => {
      if (settled) return;
      doneChecks++;
      const status = await checkAuthStatus();
      appendLog(`${tag} [poll ${doneChecks}] loggedIn=${status.loggedIn} reason=${status.reason}\n`);
      if (status.loggedIn) {
        clearInterval(checkInterval);
        killChildTree(child);
        setupChild = null;
        finish({ ok: true, code: null, combined, killedForAuth: true });
      } else if (doneChecks >= MAX_CHECKS) {
        clearInterval(checkInterval);
        appendLog(`${tag} [timeout after ${MAX_CHECKS * 5}s]\n`);
        killChildTree(child);
        setupChild = null;
        finish({ ok: false, code: null, combined });
      }
    }, 5000);

    child.on('error', (e) => {
      clearInterval(checkInterval);
      setupChild = null;
      appendLog(`${tag} [child error] ${e.message}\n`);
      finish({ ok: false, code: -1, combined: combined + '\n' + e.message });
    });
    child.on('close', async (code) => {
      clearInterval(checkInterval);
      setupChild = null;
      appendLog(`${tag} [exit] code=${code} (after ${doneChecks} auth polls)\n`);
      if (settled) return;
      // One last authoritative check — the CLI may exit before our poll fires.
      const status = await checkAuthStatus();
      appendLog(`${tag} [final check] loggedIn=${status.loggedIn} reason=${status.reason}\n`);
      finish({ ok: status.loggedIn, code, combined });
    });
  });
}

ipcMain.handle('setup:submitCode', async (_e, code) => {
  if (!setupChild || !setupChild.stdin || setupChild.stdin.destroyed) {
    return { ok: false, error: 'The sign-in helper is not currently running.' };
  }
  const trimmed = String(code || '').trim();
  if (!trimmed) return { ok: false, error: 'Please paste the code first.' };
  try {
    // Newline commits the paste in every stdin-driven CLI prompt library
    // (readline, prompts, inquirer, clack).
    setupChild.stdin.write(trimmed + '\n');
    appendLog(`[stdin] <code submitted, length=${trimmed.length}>\n`);
    return { ok: true };
  } catch (e) {
    appendLog(`[stdin write error] ${e.message}\n`);
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('setup:cancel', () => {
  if (setupChild) {
    killChildTree(setupChild);
    setupChild = null;
    return { ok: true };
  }
  return { ok: false };
});

ipcMain.handle('setup:revealLog', async () => {
  const p = getLogPath();
  try {
    if (!fs.existsSync(p)) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, '(setup has not written a log entry yet)\n');
    }
    shell.showItemInFolder(p);
    return { ok: true, path: p };
  } catch (e) {
    return { ok: false, error: e.message, path: p };
  }
});

ipcMain.handle('chat:revealLog', async () => {
  const p = getChatLogPath();
  try {
    if (!fs.existsSync(p)) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, '(no chat activity yet)\n');
    }
    shell.showItemInFolder(p);
    return { ok: true, path: p };
  } catch (e) {
    return { ok: false, error: e.message, path: p };
  }
});

ipcMain.handle('shell:openExternal', async (_e, url) => {
  if (!url || typeof url !== 'string') return { ok: false };
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'invalid_url' };
  try {
    await shell.openExternal(url);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('app:commonPaths', () => {
  const home = os.homedir();
  const candidates = [
    { key: 'home', label: 'Home', icon: '🏠', path: home },
    { key: 'desktop', label: 'Desktop', icon: '🖥️', path: path.join(home, 'Desktop') },
    { key: 'documents', label: 'Documents', icon: '📄', path: path.join(home, 'Documents') },
    { key: 'downloads', label: 'Downloads', icon: '⬇️', path: path.join(home, 'Downloads') },
  ];
  return candidates.filter((c) => {
    try { return fs.statSync(c.path).isDirectory(); } catch { return false; }
  });
});

ipcMain.handle('dialog:openFolder', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  return res.filePaths[0];
});

ipcMain.handle('fs:listFolder', async (_e, folderPath) => {
  if (!folderPath) return { entries: [], error: 'No folder selected' };
  try {
    const raw = fs.readdirSync(folderPath, { withFileTypes: true });
    const items = raw.map((entry) => {
      let size = null;
      let mtime = null;
      try {
        const st = fs.statSync(path.join(folderPath, entry.name));
        size = st.size;
        mtime = st.mtimeMs;
      } catch {}
      return {
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
        size,
        mtime,
      };
    });
    return { entries: items };
  } catch (err) {
    return { entries: [], error: err.message };
  }
});

ipcMain.handle('shell:openPath', async (_e, fullPath) => {
  if (!fullPath || typeof fullPath !== 'string') return { ok: false, error: 'invalid_path' };
  try {
    if (!fs.existsSync(fullPath)) return { ok: false, error: 'not_found' };
    const err = await shell.openPath(fullPath);
    if (err) return { ok: false, error: err };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('fs:parent', (_e, folderPath) => {
  if (!folderPath) return null;
  const parent = path.dirname(folderPath);
  return parent === folderPath ? null : parent;
});

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

ipcMain.handle('claude:start', async (_e, { cwd, prompt, resumeSessionId }) => {
  if (!cwd || !fs.existsSync(cwd)) return { ok: false, reason: 'invalid_cwd' };
  if (!prompt || !prompt.trim()) return { ok: false, reason: 'empty_prompt' };

  // Authoritative pre-flight: never spawn a chat if we know we're not signed in.
  // This is the "single source of truth" contract — a stale login is caught
  // here instead of surfacing as a cryptic subprocess error mid-turn.
  const auth = await checkAuthStatus();
  if (!auth.loggedIn) {
    return { ok: false, reason: 'not_authenticated', auth };
  }

  const sessionId = String(nextSessionId++);
  // CRITICAL: the prompt goes via STDIN, not via -p's argv value.
  //
  // Passing prompt as -p <value> on Windows meant that Windows CreateProcess
  // built a cmd.exe command line with literal \n characters embedded in the
  // quoted arg (context prefix has newlines). cmd.exe then interpreted each
  // \n as an end-of-command, silently truncating the arg and leaving the CLI
  // to fall back to interactive-idle mode ("What would you like help with?").
  //
  // `-p --input-format text` tells the CLI to read the prompt from stdin.
  // Stdin is a raw byte stream — no cmd.exe interpretation, no escaping,
  // no length limits from CreateProcess (~32k). Works identically on all OSes.
  const args = [];
  if (resumeSessionId) args.push('--resume', resumeSessionId);
  args.push(
    '-p',
    '--input-format', 'text',
    '--output-format', 'stream-json',
    '--verbose',
    // Forge runs the CLI headlessly — there is no terminal for the user to
    // approve mid-task permission prompts. Without this flag the agent
    // stops and gives up on any risky operation (shell commands, writes
    // outside its immediate cwd, etc.).
    '--dangerously-skip-permissions',
  );

  const started = Date.now();
  appendChatLog(`\n===== ${new Date().toISOString()} — session ${sessionId} =====\ncwd=${cwd} bin=${CLAUDE_BIN} resume=${resumeSessionId || '(none)'}\n`);
  appendChatLog(`[argv unescaped] (prompt is NOT in argv — it goes via stdin)\n`);
  args.forEach((a, i) => appendChatLog(`  [${i}] ${JSON.stringify(a)}\n`));
  appendChatLog(`[prompt via stdin] bytes=${Buffer.byteLength(prompt, 'utf8')} lines=${prompt.split('\n').length}\n`);
  const preview = prompt.slice(0, 240).replace(/\n/g, '\\n');
  appendChatLog(`[prompt preview] ${preview}${prompt.length > 240 ? '…' : ''}\n`);

  let child;
  try {
    child = spawnClaude(args, {
      cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      logTo: appendChatLog,
    });
  } catch (err) {
    appendChatLog(`[spawn error] ${err.message}\n`);
    return { ok: false, reason: 'spawn_failed', message: err.message };
  }
  sessions.set(sessionId, child);

  // Send the prompt over stdin and close it, so the CLI stops reading.
  try {
    child.stdin.write(prompt, 'utf8');
    child.stdin.end();
    appendChatLog(`[stdin] wrote ${Buffer.byteLength(prompt, 'utf8')} bytes and closed\n`);
  } catch (err) {
    appendChatLog(`[stdin write error] ${err.message}\n`);
  }

  let eventCount = 0;
  let skipCount = 0;

  const tryEmit = (rawLine) => {
    // Tolerate CRLF from Windows subprocesses; strip surrounding whitespace.
    const line = rawLine.replace(/^﻿/, '').replace(/\r$/, '').trim();
    if (!line) return;
    // Fast-path: a stream-json line always starts with '{'. Anything else is
    // almost certainly stray output from cmd.exe / shim / stderr-on-stdout —
    // log it for debugging but don't crash the response or the UI.
    if (line[0] !== '{') {
      skipCount++;
      appendChatLog(`[skip:non-json] ${line.slice(0, 400)}\n`);
      return;
    }
    let evt;
    try {
      evt = JSON.parse(line);
    } catch (err) {
      skipCount++;
      appendChatLog(`[skip:parse-error] ${err.message} :: ${line.slice(0, 400)}\n`);
      return;
    }
    if (!evt || typeof evt !== 'object') {
      skipCount++;
      appendChatLog(`[skip:not-object] ${line.slice(0, 400)}\n`);
      return;
    }
    eventCount++;
    sendToRenderer('claude:event', { sessionId, event: evt });
  };

  let stdoutBuffer = '';
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString('utf8');
    let nl;
    while ((nl = stdoutBuffer.indexOf('\n')) >= 0) {
      const line = stdoutBuffer.slice(0, nl);
      stdoutBuffer = stdoutBuffer.slice(nl + 1);
      tryEmit(line);
    }
  });

  child.stderr.on('data', (chunk) => {
    const s = chunk.toString('utf8');
    appendChatLog(`[stderr] ${s}`);
    sendToRenderer('claude:stderr', { sessionId, text: s });
  });

  child.on('error', (err) => {
    appendChatLog(`[child error] ${err.message}\n`);
    sendToRenderer('claude:error', { sessionId, message: err.message });
  });

  child.on('close', (code, signal) => {
    // Flush any trailing partial line.
    if (stdoutBuffer.trim()) tryEmit(stdoutBuffer);
    stdoutBuffer = '';
    sessions.delete(sessionId);
    appendChatLog(`[exit] code=${code} signal=${signal} events=${eventCount} skipped=${skipCount} durationMs=${Date.now() - started}\n`);
    sendToRenderer('claude:closed', { sessionId, code, signal, eventCount, skipCount });
  });

  return { ok: true, sessionId, bin: CLAUDE_BIN };
});

ipcMain.handle('claude:stop', async (_e, { sessionId }) => {
  const child = sessions.get(sessionId);
  if (!child) return { ok: false, reason: 'not_found' };
  killChildTree(child);
  return { ok: true };
});
