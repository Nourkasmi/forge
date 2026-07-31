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

const CLAUDE_PKG = '@anthropic-ai/claude-code';
const IS_WIN = process.platform === 'win32';

function getLogPath() {
  return path.join(app.getPath('userData'), 'setup.log');
}

function appendLog(text) {
  try {
    const p = getLogPath();
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
      // Node's spawn cannot execute the extension-less POSIX shim on Windows,
      // so prefer a real Windows-executable variant.
      const cmdVar = lines.find((p) => /\.cmd$/i.test(p));
      if (cmdVar && fs.existsSync(cmdVar)) return cmdVar;
      const exeVar = lines.find((p) => /\.exe$/i.test(p));
      if (exeVar && fs.existsSync(exeVar)) return exeVar;
      // Do NOT fall through to a bare-name shim; keep searching disk.
    } else if (lines[0] && fs.existsSync(lines[0])) {
      return lines[0];
    }
  } catch {}
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const candidates = IS_WIN
    ? [
        path.join(process.env.APPDATA || '', 'npm', 'claude.cmd'),
        path.join(process.env.APPDATA || '', 'npm', 'claude.ps1'),
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

function spawnClaude(args, opts = {}) {
  const options = { env: process.env, ...opts };
  if (IS_WIN) {
    // On Windows, always route through cmd.exe /d /s /c so:
    //   1. .cmd/.bat/.ps1 shims work (Node cannot spawn these directly since v18.20.2 / 20.12.2).
    //   2. Bare-name resolution honors PATHEXT.
    //   3. Extension-less POSIX shims that would ENOENT are bypassed.
    const escape = (a) => (/[\s"^&|<>()%]/.test(a) ? '"' + String(a).replace(/"/g, '""') + '"' : String(a));
    const binQuoted = /\s/.test(CLAUDE_BIN) ? `"${CLAUDE_BIN}"` : CLAUDE_BIN;
    const line = [binQuoted, ...args.map(escape)].join(' ');
    return spawn('cmd.exe', ['/d', '/s', '/c', line], {
      ...options,
      windowsVerbatimArguments: true,
    });
  }
  return spawn(CLAUDE_BIN, args, options);
}

function spawnCollect(cmd, args, options = {}) {
  return new Promise((resolve) => {
    const opts = { env: process.env, shell: IS_WIN, ...options };
    let stdout = '';
    let stderr = '';
    let child;
    try {
      const quoted = IS_WIN && opts.shell && cmd.includes(' ') ? `"${cmd}"` : cmd;
      child = spawn(quoted, args, opts);
    } catch (err) {
      resolve({ ok: false, code: -1, error: err.message, stdout, stderr });
      return;
    }
    if (options.timeoutMs) {
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
      }, options.timeoutMs);
    }
    child.stdout?.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr?.on('data', (d) => { stderr += d.toString('utf8'); });
    child.on('error', (err) => resolve({ ok: false, code: -1, error: err.message, stdout, stderr }));
    child.on('close', (code) => resolve({ ok: code === 0, code, stdout, stderr }));
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

async function isAuthenticated() {
  const tmpCwd = os.tmpdir();
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnClaude(['-p', 'ok', '--output-format', 'stream-json', '--verbose'], {
        cwd: tmpCwd,
      });
    } catch {
      resolve(false);
      return;
    }
    let sawResult = false;
    let sawAuthError = false;
    const buffer = { s: '' };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
    }, 15000);
    child.stdout.on('data', (d) => {
      buffer.s += d.toString('utf8');
      let nl;
      while ((nl = buffer.s.indexOf('\n')) >= 0) {
        const line = buffer.s.slice(0, nl);
        buffer.s = buffer.s.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line);
          if (evt.type === 'result' && !evt.is_error) sawResult = true;
          if (evt.type === 'result' && evt.is_error) sawAuthError = true;
        } catch {}
      }
    });
    child.stderr.on('data', (d) => {
      const s = d.toString('utf8').toLowerCase();
      if (/(not authenticated|invalid.*api key|401|log ?in|sign ?in|please run|no api key)/i.test(s)) {
        sawAuthError = true;
      }
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(sawResult && !sawAuthError && code === 0);
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
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
  for (const child of sessions.values()) {
    try { child.kill('SIGKILL'); } catch {}
  }
  sessions.clear();
  if (setupChild) {
    try { setupChild.kill('SIGKILL'); } catch {}
    setupChild = null;
  }
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

ipcMain.handle('app:info', () => ({ claudeBin: CLAUDE_BIN, home: process.env.HOME }));

ipcMain.handle('setup:status', async () => {
  if (process.env.FORGE_FORCE_SETUP) {
    const npm = await probeNpm();
    return { needsSetup: true, hasClaude: false, hasNpm: npm.ok, forced: true };
  }
  const claude = await probeClaude();
  if (claude.ok) {
    CLAUDE_BIN = claude.bin;
    return { needsSetup: false, hasClaude: true, claudeVersion: claude.version };
  }
  const npm = await probeNpm();
  return { needsSetup: true, hasClaude: false, hasNpm: npm.ok, npmVersion: npm.version };
});

ipcMain.handle('setup:install', async () => {
  return new Promise((resolve) => {
    logHeader(`npm install -g ${CLAUDE_PKG}`);
    appendLog(`npm bin: ${NPM_BIN}\n`);
    let child;
    const opts = {
      env: process.env,
      shell: IS_WIN,
      stdio: ['ignore', 'pipe', 'pipe'],
    };
    try {
      const quoted = IS_WIN && opts.shell && NPM_BIN.includes(' ') ? `"${NPM_BIN}"` : NPM_BIN;
      child = spawn(quoted, ['install', '-g', CLAUDE_PKG], opts);
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

ipcMain.handle('setup:login', async () => {
  if (setupChild) {
    try { setupChild.kill('SIGKILL'); } catch {}
    setupChild = null;
  }
  logHeader('sign-in flow');
  appendLog(`claude bin: ${CLAUDE_BIN}\n`);

  const already = await isAuthenticated();
  appendLog(`pre-check isAuthenticated: ${already}\n`);
  if (already) return { ok: true };

  const first = await runLoginCommand();
  appendLog(`\n--- runLoginCommand summary ---\nok=${first.ok} exitCode=${first.code ?? '?'} tookMs=${first.tookMs ?? '?'}\n`);

  const firstAuthed = await isAuthenticated();
  appendLog(`post-first isAuthenticated: ${firstAuthed}\n`);
  if (firstAuthed) return { ok: true };

  const interactive = await runInteractiveLogin();
  appendLog(`\n--- runInteractiveLogin summary ---\nok=${interactive.ok} exitCode=${interactive.code ?? '?'} killedForAuth=${interactive.killedForAuth ?? false}\n`);

  const finalAuthed = await isAuthenticated();
  appendLog(`post-interactive isAuthenticated: ${finalAuthed}\n`);
  if (finalAuthed) return { ok: true };

  const details = [
    '--- Attempt 1: "claude login" ---',
    `argv: ${CLAUDE_BIN} login`,
    `exit code: ${first.code ?? '(no exit)'}`,
    `stdout:\n${(first.stdout || '(empty)').trim()}`,
    `stderr:\n${(first.stderr || '(empty)').trim()}`,
    '',
    '--- Attempt 2: interactive claude ---',
    `argv: ${CLAUDE_BIN}`,
    `exit code: ${interactive.code ?? '(killed)'}`,
    `output:\n${(interactive.combined || '(empty)').trim()}`,
  ].join('\n').slice(-4000);

  return {
    ok: false,
    error: 'Sign-in did not complete. Please try again, or open the setup log for details.',
    details,
    logPath: getLogPath(),
  };
});

function runLoginCommand() {
  return new Promise((resolve) => {
    appendLog(`\n>>> spawn: ${CLAUDE_BIN} login\n`);
    const startedAt = Date.now();
    let child;
    const opts = {
      env: process.env,
      shell: IS_WIN,
      stdio: ['ignore', 'pipe', 'pipe'],
    };
    try {
      const quoted = IS_WIN && opts.shell && CLAUDE_BIN.includes(' ') ? `"${CLAUDE_BIN}"` : CLAUDE_BIN;
      child = spawn(quoted, ['login'], opts);
    } catch (err) {
      appendLog(`spawn threw: ${err.message}\n`);
      resolve({ ok: false, code: -1, stdout: '', stderr: err.message, tookMs: Date.now() - startedAt });
      return;
    }
    setupChild = child;
    let stdout = '';
    let stderr = '';
    let urlOpened = false;

    const scan = (chunk) => {
      if (urlOpened) return;
      const m = (stdout + stderr).match(/https?:\/\/[^\s\r\n"'`]+/);
      if (m) {
        urlOpened = true;
        appendLog(`[detected url] ${m[0]}\n`);
        shell.openExternal(m[0]).catch(() => {});
        sendToRenderer('setup:progress', { phase: 'loggingIn', urlOpened: true });
      }
    };
    child.stdout.on('data', (d) => {
      const s = d.toString('utf8');
      stdout += s;
      appendLog(`[stdout] ${s}`);
      scan();
    });
    child.stderr.on('data', (d) => {
      const s = d.toString('utf8');
      stderr += s;
      appendLog(`[stderr] ${s}`);
      scan();
    });

    const HARD_TIMEOUT_MS = 10 * 60 * 1000;
    const timeout = setTimeout(() => {
      appendLog(`\n[timeout after ${HARD_TIMEOUT_MS}ms] killing child\n`);
      try { child.kill('SIGKILL'); } catch {}
    }, HARD_TIMEOUT_MS);

    child.on('error', (e) => {
      clearTimeout(timeout);
      setupChild = null;
      appendLog(`[child error] ${e.message}\n`);
      resolve({ ok: false, code: -1, stdout, stderr: stderr + '\n' + e.message, tookMs: Date.now() - startedAt });
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      setupChild = null;
      appendLog(`[exit] code=${code}\n`);
      resolve({ ok: code === 0, code, stdout, stderr, tookMs: Date.now() - startedAt });
    });
  });
}

function runInteractiveLogin() {
  return new Promise((resolve) => {
    appendLog(`\n>>> spawn interactive: ${CLAUDE_BIN} (no args)\n`);
    let child;
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      resolve(payload);
    };
    const opts = {
      env: { ...process.env, FORCE_COLOR: '0', TERM: 'dumb', NO_COLOR: '1' },
      shell: IS_WIN,
      stdio: ['pipe', 'pipe', 'pipe'],
    };
    try {
      const quoted = IS_WIN && opts.shell && CLAUDE_BIN.includes(' ') ? `"${CLAUDE_BIN}"` : CLAUDE_BIN;
      child = spawn(quoted, [], opts);
    } catch (err) {
      appendLog(`spawn threw: ${err.message}\n`);
      finish({ ok: false, code: -1, combined: err.message });
      return;
    }
    setupChild = child;
    let combined = '';
    let urlOpened = false;
    const scan = () => {
      if (urlOpened) return;
      const m = combined.match(/https?:\/\/[^\s\r\n"'`]+/);
      if (m) {
        urlOpened = true;
        appendLog(`[detected url] ${m[0]}\n`);
        shell.openExternal(m[0]).catch(() => {});
        sendToRenderer('setup:progress', { phase: 'loggingIn', urlOpened: true });
      }
    };
    child.stdout.on('data', (d) => {
      const s = d.toString('utf8');
      combined += s;
      appendLog(`[stdout] ${s}`);
      scan();
    });
    child.stderr.on('data', (d) => {
      const s = d.toString('utf8');
      combined += s;
      appendLog(`[stderr] ${s}`);
      scan();
    });

    let doneChecks = 0;
    const MAX_CHECKS = 60; // 5 min
    const checkInterval = setInterval(async () => {
      if (settled) return;
      doneChecks++;
      const ok = await isAuthenticated();
      appendLog(`[poll ${doneChecks}] isAuthenticated=${ok}\n`);
      if (ok) {
        clearInterval(checkInterval);
        try { child.kill(IS_WIN ? 'SIGKILL' : 'SIGTERM'); } catch {}
        setupChild = null;
        finish({ ok: true, code: null, combined, killedForAuth: true });
      } else if (doneChecks >= MAX_CHECKS) {
        clearInterval(checkInterval);
        appendLog(`[timeout after ${MAX_CHECKS * 5}s]\n`);
        try { child.kill('SIGKILL'); } catch {}
        setupChild = null;
        finish({ ok: false, code: null, combined });
      }
    }, 5000);

    child.on('error', (e) => {
      clearInterval(checkInterval);
      setupChild = null;
      appendLog(`[child error] ${e.message}\n`);
      finish({ ok: false, code: -1, combined: combined + '\n' + e.message });
    });
    child.on('close', async (code) => {
      clearInterval(checkInterval);
      setupChild = null;
      appendLog(`[exit] code=${code} (after ${doneChecks} auth polls)\n`);
      if (settled) return;
      // Give one last check in case OAuth completed as we exited
      const ok = await isAuthenticated();
      appendLog(`[final check] isAuthenticated=${ok}\n`);
      finish({ ok, code, combined });
    });
  });
}

function friendlyLoginError(stderr, code) {
  const s = (stderr || '').toLowerCase();
  if (/network|econnrefused|enotfound|timeout/i.test(s)) {
    return 'Could not reach Anthropic\'s sign-in servers. Check your internet and try again.';
  }
  return code ? `Sign-in stopped unexpectedly (code ${code}). Try again.` : 'Sign-in stopped unexpectedly. Try again.';
}

ipcMain.handle('setup:cancel', () => {
  if (setupChild) {
    try { setupChild.kill('SIGKILL'); } catch {}
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

  const sessionId = String(nextSessionId++);
  const args = [];
  if (resumeSessionId) args.push('--resume', resumeSessionId);
  args.push('-p', prompt, '--output-format', 'stream-json', '--verbose');
  let child;
  try {
    child = spawnClaude(args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    return { ok: false, reason: 'spawn_failed', message: err.message };
  }
  sessions.set(sessionId, child);

  let stdoutBuffer = '';
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString('utf8');
    let nl;
    while ((nl = stdoutBuffer.indexOf('\n')) >= 0) {
      const line = stdoutBuffer.slice(0, nl);
      stdoutBuffer = stdoutBuffer.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line);
        sendToRenderer('claude:event', { sessionId, event: evt });
      } catch (err) {
        sendToRenderer('claude:event', {
          sessionId,
          event: { type: 'parse_error', raw: line, error: err.message },
        });
      }
    }
  });

  child.stderr.on('data', (chunk) => {
    sendToRenderer('claude:stderr', { sessionId, text: chunk.toString('utf8') });
  });

  child.on('error', (err) => {
    sendToRenderer('claude:error', { sessionId, message: err.message });
  });

  child.on('close', (code, signal) => {
    if (stdoutBuffer.trim()) {
      try {
        const evt = JSON.parse(stdoutBuffer);
        sendToRenderer('claude:event', { sessionId, event: evt });
      } catch {}
      stdoutBuffer = '';
    }
    sessions.delete(sessionId);
    sendToRenderer('claude:closed', { sessionId, code, signal });
  });

  return { ok: true, sessionId, bin: CLAUDE_BIN };
});

ipcMain.handle('claude:stop', async (_e, { sessionId }) => {
  const child = sessions.get(sessionId);
  if (!child) return { ok: false, reason: 'not_found' };
  try {
    child.kill('SIGTERM');
    setTimeout(() => {
      const still = sessions.get(sessionId);
      if (still) {
        try { still.kill('SIGKILL'); } catch {}
      }
    }, 500);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
});
