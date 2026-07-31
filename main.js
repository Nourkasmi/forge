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
    const found = execSync(cmd, opts).trim().split(/\r?\n/)[0];
    if (found && fs.existsSync(found)) return found;
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
  const direct = await probeClaude('claude');
  if (direct.ok) return direct;

  const prefixRes = await spawnCollect(NPM_BIN, ['config', 'get', 'prefix'], { timeoutMs: 5000 });
  const prefix = prefixRes.ok ? prefixRes.stdout.trim() : null;
  if (!prefix) return { ok: false, error: 'Could not locate npm install prefix.' };

  const candidates = IS_WIN
    ? [
        path.join(prefix, 'claude.cmd'),
        path.join(prefix, 'claude.ps1'),
        path.join(prefix, 'claude'),
      ]
    : [
        path.join(prefix, 'bin', 'claude'),
        path.join(prefix, 'claude'),
      ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      const probe = await probeClaude(c);
      if (probe.ok) return probe;
    }
  }
  return { ok: false, error: 'Installed, but the claude binary was not found on disk.' };
}

async function isAuthenticated() {
  const tmpCwd = os.tmpdir();
  const bin = CLAUDE_BIN;
  return new Promise((resolve) => {
    let child;
    const opts = {
      cwd: tmpCwd,
      env: process.env,
      shell: IS_WIN,
    };
    try {
      const quoted = IS_WIN && opts.shell && bin.includes(' ') ? `"${bin}"` : bin;
      child = spawn(quoted, ['-p', 'ok', '--output-format', 'stream-json', '--verbose'], opts);
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
      resolve({ ok: false, error: friendlyInstallError(err.message) });
      return;
    }
    setupChild = child;
    let stderr = '';
    child.stdout.on('data', () => {
      sendToRenderer('setup:progress', { phase: 'installing' });
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString('utf8');
      sendToRenderer('setup:progress', { phase: 'installing' });
    });
    child.on('error', (err) => {
      setupChild = null;
      resolve({ ok: false, error: friendlyInstallError(err.message) });
    });
    child.on('close', async (code) => {
      setupChild = null;
      if (code !== 0) {
        resolve({ ok: false, error: friendlyInstallError(stderr, code) });
        return;
      }
      const found = await findClaudeAfterInstall();
      if (!found.ok) {
        resolve({
          ok: false,
          error: 'Installed successfully, but Forge could not find the new tools. Restarting your computer usually fixes this.',
        });
        return;
      }
      CLAUDE_BIN = found.bin;
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

  const first = await runLoginCommand();
  if (first.ok) return { ok: true };

  const interactive = await runInteractiveLogin();
  if (interactive.ok) return { ok: true };

  return {
    ok: false,
    error: first.error || interactive.error || 'Sign-in did not complete. Please try again.',
  };
});

function runLoginCommand() {
  return new Promise((resolve) => {
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
      resolve({ ok: false, error: err.message, tried: 'login' });
      return;
    }
    setupChild = child;
    let out = '';
    let err = '';
    let urlOpened = false;

    const scan = (chunk) => {
      out += chunk;
      if (urlOpened) return;
      const m = out.match(/https?:\/\/[^\s\r\n"'`]+/);
      if (m) {
        urlOpened = true;
        shell.openExternal(m[0]).catch(() => {});
        sendToRenderer('setup:progress', { phase: 'loggingIn', urlOpened: true });
      }
    };
    child.stdout.on('data', (d) => scan(d.toString('utf8')));
    child.stderr.on('data', (d) => {
      const s = d.toString('utf8');
      err += s;
      scan(s);
    });

    const timeout = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
    }, 10 * 60 * 1000);

    child.on('error', () => {
      clearTimeout(timeout);
      setupChild = null;
      resolve({ ok: false, error: 'Sign-in command could not be started.', tried: 'login' });
    });
    child.on('close', async (code) => {
      clearTimeout(timeout);
      setupChild = null;
      const unknownCmd = /unknown command|invalid.*command|is not a valid|no such (?:sub)?command|is unknown/i.test(err);
      if (unknownCmd) {
        resolve({ ok: false, error: 'unknown_command', tried: 'login' });
        return;
      }
      if (code === 0) {
        const check = await isAuthenticated();
        resolve({ ok: check, error: check ? null : 'Sign-in finished but Forge could not verify it.', tried: 'login' });
        return;
      }
      resolve({ ok: false, error: friendlyLoginError(err, code), tried: 'login' });
    });
  });
}

function runInteractiveLogin() {
  return new Promise((resolve) => {
    let child;
    const opts = {
      env: { ...process.env, FORCE_COLOR: '0', TERM: 'dumb', NO_COLOR: '1' },
      shell: IS_WIN,
      stdio: ['pipe', 'pipe', 'pipe'],
    };
    try {
      const quoted = IS_WIN && opts.shell && CLAUDE_BIN.includes(' ') ? `"${CLAUDE_BIN}"` : CLAUDE_BIN;
      child = spawn(quoted, [], opts);
    } catch (err) {
      resolve({ ok: false, error: err.message });
      return;
    }
    setupChild = child;
    let out = '';
    let urlOpened = false;
    const scan = (chunk) => {
      out += chunk;
      if (!urlOpened) {
        const m = out.match(/https?:\/\/[^\s\r\n"'`]+/);
        if (m) {
          urlOpened = true;
          shell.openExternal(m[0]).catch(() => {});
          sendToRenderer('setup:progress', { phase: 'loggingIn', urlOpened: true });
        }
      }
    };
    child.stdout.on('data', (d) => scan(d.toString('utf8')));
    child.stderr.on('data', (d) => scan(d.toString('utf8')));

    let doneChecks = 0;
    const checkInterval = setInterval(async () => {
      doneChecks++;
      const ok = await isAuthenticated();
      if (ok) {
        clearInterval(checkInterval);
        try { child.kill('SIGTERM'); } catch {}
        setupChild = null;
        resolve({ ok: true });
      } else if (doneChecks > 60) {
        clearInterval(checkInterval);
        try { child.kill('SIGKILL'); } catch {}
        setupChild = null;
        resolve({ ok: false, error: 'Sign-in timed out. Please try again.' });
      }
    }, 5000);

    child.on('error', () => {
      clearInterval(checkInterval);
      setupChild = null;
      resolve({ ok: false, error: 'Could not start the sign-in helper.' });
    });
    child.on('close', async () => {
      clearInterval(checkInterval);
      setupChild = null;
      const ok = await isAuthenticated();
      resolve({ ok, error: ok ? null : 'Sign-in ended before finishing. Please try again.' });
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
    child = spawn(CLAUDE_BIN, args, {
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
