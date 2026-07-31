const state = {
  folder: null,
  entries: [],
  session: null,
  claudeSessionId: null,
  selectedName: null,
  highlighted: new Set(),
  recent: new Set(),
  pendingTools: new Map(),
  currentTrail: null,
  auth: { loggedIn: false, reason: 'unknown' },
  authPollHandle: null,
};

const $ = (id) => document.getElementById(id);

const iconMap = {
  js: '📜', mjs: '📜', cjs: '📜', ts: '📜', tsx: '📜', jsx: '📜',
  py: '🐍', rb: '💎', go: '📜', rs: '📜', java: '📜', c: '📜',
  cpp: '📜', h: '📜', hpp: '📜', cs: '📜', php: '📜', swift: '📜',
  kt: '📜', scala: '📜', dart: '📜', lua: '📜',
  html: '🌐', htm: '🌐', xml: '🌐', css: '🎨', scss: '🎨', sass: '🎨', less: '🎨',
  json: '📋', yaml: '📋', yml: '📋', toml: '📋', ini: '📋', cfg: '📋', env: '⚙️',
  md: '📝', mdx: '📝', txt: '📝', rst: '📝', log: '📝',
  png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', svg: '🖼️', webp: '🖼️', ico: '🖼️', bmp: '🖼️',
  mp3: '🎵', wav: '🎵', flac: '🎵', ogg: '🎵', m4a: '🎵',
  mp4: '🎬', mov: '🎬', avi: '🎬', mkv: '🎬', webm: '🎬',
  zip: '🗃️', tar: '🗃️', gz: '🗃️', bz2: '🗃️', '7z': '🗃️', rar: '🗃️',
  pdf: '📕', doc: '📘', docx: '📘', xls: '📗', xlsx: '📗', ppt: '📙', pptx: '📙',
  sh: '⚡', bash: '⚡', zsh: '⚡', fish: '⚡', ps1: '⚡',
  sql: '🗄️', db: '🗄️', sqlite: '🗄️',
  lock: '🔒',
};

const CLUTTER_NAMES = new Set([
  'node_modules', '__pycache__', 'venv', 'dist', 'build', 'target', 'out',
  'coverage', 'bower_components', 'vendor', '.svelte-kit', '.turbo', '.next', '.nuxt', '.cache',
  'etc', 'usr', 'bin', 'sbin', 'lib', 'lib32', 'lib64', 'libx32',
  'boot', 'dev', 'proc', 'sys', 'run', 'srv', 'mnt', 'media',
  'opt', 'lost+found', 'snap', 'root', 'var', 'swapfile', 'cdrom',
]);

const CLUTTER_FILE_PATTERNS = [
  /^initrd\.img/i,
  /^vmlinuz/i,
  /^system\.map/i,
  /\.efi$/i,
];

function isClutter(entry) {
  if (entry.name.startsWith('.')) return true;
  if (CLUTTER_NAMES.has(entry.name.toLowerCase())) return true;
  for (const pat of CLUTTER_FILE_PATTERNS) {
    if (pat.test(entry.name)) return true;
  }
  return false;
}

function iconFor(entry) {
  if (entry.isDirectory) return '📁';
  const name = entry.name.toLowerCase();
  if (name === 'dockerfile') return '🐳';
  if (name === 'makefile') return '🔨';
  if (name === '.gitignore' || name.startsWith('.git')) return '🌿';
  if (name === '.env' || name.startsWith('.env.')) return '🔐';
  if (name === 'package.json' || name === 'package-lock.json') return '📦';
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1) : '';
  return iconMap[ext] || '📄';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function scrollBottom() {
  const el = $('messages');
  el.scrollTop = el.scrollHeight;
}

/* ---------- Explorer ---------- */
async function setFolder(p) {
  const changed = state.folder !== p;
  state.folder = p;
  state.highlighted.clear();
  state.recent.clear();
  state.selectedName = null;
  updateSelectionPill();
  if (!p) {
    if (changed) resetConversation('Pick a folder to start a new conversation.');
    showLanding();
    return;
  }
  $('folder-path').textContent = p;
  showFolderView();
  if (changed) resetConversation('Switched folder — starting a fresh conversation.');
  await refreshGrid();
}

function showLanding() {
  $('explorer-header').hidden = true;
  $('grid').hidden = true;
  $('landing').hidden = false;
  renderLanding();
}

function showFolderView() {
  $('explorer-header').hidden = false;
  $('grid').hidden = false;
  $('landing').hidden = true;
}

async function renderLanding() {
  const tilesEl = $('landing-tiles');
  tilesEl.innerHTML = '';
  const paths = await window.forge.commonPaths();
  for (const p of paths) {
    const btn = document.createElement('button');
    btn.className = 'landing-tile';
    btn.title = p.path;
    btn.innerHTML =
      '<span class="landing-tile-icon"></span>' +
      '<span class="landing-tile-info">' +
      '<span class="landing-tile-label"></span>' +
      '<span class="landing-tile-path"></span>' +
      '</span>';
    btn.querySelector('.landing-tile-icon').textContent = p.icon;
    btn.querySelector('.landing-tile-label').textContent = p.label;
    btn.querySelector('.landing-tile-path').textContent = p.path;
    btn.addEventListener('click', () => setFolder(p.path));
    tilesEl.appendChild(btn);
  }
}

function resetConversation(note) {
  state.claudeSessionId = null;
  state.pendingTools.clear();
  state.currentTrail = null;
  const msgs = $('messages');
  msgs.innerHTML = '';
  if (note) addMessage('system', note);
}

async function refreshGrid() {
  if (!state.folder) return;
  const res = await window.forge.listFolder(state.folder);
  if (res.error) {
    state.entries = [];
    renderGrid(res.error);
    return;
  }
  state.entries = (res.entries || []).filter((e) => !isClutter(e));
  if (state.selectedName && !state.entries.some((e) => e.name === state.selectedName)) {
    state.selectedName = null;
    updateSelectionPill();
  }
  renderGrid();
}

function renderGrid(errorMsg) {
  const grid = $('grid');
  grid.innerHTML = '';
  if (errorMsg) {
    const err = document.createElement('div');
    err.className = 'empty';
    err.textContent = 'Could not read folder: ' + errorMsg;
    grid.appendChild(err);
    return;
  }
  if (state.entries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'This folder is empty. Ask Forge to add something.';
    grid.appendChild(empty);
    return;
  }
  const sorted = [...state.entries].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const entry of sorted) {
    const tile = document.createElement('div');
    tile.className = 'tile' + (entry.isDirectory ? ' dir' : '');
    if (state.highlighted.has(entry.name)) tile.classList.add('highlight');
    else if (state.recent.has(entry.name)) tile.classList.add('recent');
    if (state.selectedName === entry.name) tile.classList.add('selected');
    tile.dataset.name = entry.name;
    tile.title = entry.name;

    const iconEl = document.createElement('div');
    iconEl.className = 'tile-icon';
    iconEl.textContent = iconFor(entry);
    const nameEl = document.createElement('div');
    nameEl.className = 'tile-name';
    nameEl.textContent = entry.name;
    tile.appendChild(iconEl);
    tile.appendChild(nameEl);

    tile.addEventListener('click', () => toggleSelect(entry.name, tile));
    tile.addEventListener('dblclick', async () => {
      const full = state.folder.replace(/\/$/, '') + '/' + entry.name;
      if (entry.isDirectory) {
        await setFolder(full);
      } else {
        const res = await window.forge.openPath(full);
        if (!res || !res.ok) {
          addMessage('system', `Could not open ${entry.name}: ${res?.error || 'unknown error'}`);
        }
      }
    });
    grid.appendChild(tile);
  }
}

function toggleSelect(name, tileEl) {
  const alreadySelected = state.selectedName === name;
  document.querySelectorAll('.tile.selected').forEach((t) => t.classList.remove('selected'));
  if (alreadySelected) {
    state.selectedName = null;
  } else {
    state.selectedName = name;
    if (tileEl) tileEl.classList.add('selected');
  }
  updateSelectionPill();
}

function updateSelectionPill() {
  const pill = $('selection-pill');
  const nameEl = $('selection-name');
  if (!pill || !nameEl) return;
  if (state.selectedName) {
    nameEl.textContent = state.selectedName;
    pill.hidden = false;
  } else {
    nameEl.textContent = '';
    pill.hidden = true;
  }
}

function buildContextPrefix() {
  if (!state.folder) return '';
  const sorted = [...state.entries].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const items = sorted.map((e) => (e.isDirectory ? e.name + '/' : e.name));

  const CAP = 200;
  let listing;
  if (items.length === 0) listing = '(empty folder)';
  else if (items.length <= CAP) listing = items.join(', ');
  else listing = items.slice(0, CAP).join(', ') + `, … and ${items.length - CAP} more`;

  const lines = [
    `[Working directory: ${state.folder}]`,
    `[Files here: ${listing}]`,
    `[Forge hides these from the user's view and you must match that: any entry whose name starts with "." (dotfiles/dotfolders like .git, .env, .ssh, .config, .claude, .venv, .cache, .gnupg), standard build/dependency directories (node_modules, __pycache__, dist, build, target, out, coverage, vendor, bower_components, .next, .nuxt, .svelte-kit, .turbo), Unix system directories (etc, usr, bin, sbin, lib, lib32, lib64, libx32, boot, dev, proc, sys, run, srv, mnt, media, opt, lost+found, snap, root, var, swapfile), and kernel image files (initrd.img*, vmlinuz*, System.map*). Do not list, mention, describe, or reference these in any response unless the user explicitly names one of them. If a request like "list every folder here" would surface them, silently omit them — do not add a caveat like "hidden folders omitted".]`,
  ];
  if (state.selectedName) {
    lines.push(`[User has selected in the file grid: ${state.selectedName} — treat this as the file they are referring to unless they clearly name another]`);
  }
  return lines.join('\n') + '\n\n';
}

function highlightFile(fileName) {
  state.highlighted.add(fileName);
  if (!state.entries.some((e) => e.name === fileName)) {
    state.entries.push({ name: fileName, isDirectory: false, isFile: true });
  }
  renderGrid();
  setTimeout(refreshGrid, 350);
}

function markFileDone(fileName) {
  state.highlighted.delete(fileName);
  state.recent.add(fileName);
  renderGrid();
  setTimeout(() => {
    state.recent.delete(fileName);
    renderGrid();
  }, 5000);
  refreshGrid();
}

/* ---------- Chat & trail ---------- */
function addMessage(role, text) {
  const el = document.createElement('div');
  el.className = 'msg msg-' + role;
  el.textContent = text;
  $('messages').appendChild(el);
  scrollBottom();
  return el;
}

function startTrail() {
  const el = document.createElement('div');
  el.className = 'trail';
  const hdr = document.createElement('div');
  hdr.className = 'trail-header';
  hdr.textContent = 'Forge is working';
  el.appendChild(hdr);
  $('messages').appendChild(el);
  state.currentTrail = el;
  scrollBottom();
  return el;
}

function addStep(icon, text, kind = 'step') {
  if (!state.currentTrail) startTrail();
  const step = document.createElement('div');
  step.className = 'step step-' + kind + (kind === 'warn' || kind === 'error' || kind === 'end' ? ' ' + kind : '');
  const iconEl = document.createElement('span');
  iconEl.className = 'step-icon';
  iconEl.textContent = icon;
  const textEl = document.createElement('span');
  textEl.className = 'step-text';
  textEl.textContent = text;
  step.appendChild(iconEl);
  step.appendChild(textEl);
  state.currentTrail.appendChild(step);
  scrollBottom();
  return step;
}

function addAssistantSay(text) {
  const bubble = document.createElement('div');
  bubble.className = 'assistant-say';
  bubble.textContent = text;
  (state.currentTrail || $('messages')).appendChild(bubble);
  scrollBottom();
}

function endTrail() {
  state.currentTrail = null;
}

function setRunning(running) {
  $('send').hidden = running;
  $('stop').hidden = !running;
  $('input').disabled = running;
  $('status').textContent = running ? 'Working…' : 'Idle';
  $('status').className = 'status' + (running ? ' running' : '');
}

async function sendPrompt() {
  const inputEl = $('input');
  const text = inputEl.value.trim();
  if (!text) return;
  if (!state.folder) {
    addMessage('system', 'Pick a folder first — Forge needs to know where to work.');
    return;
  }
  if (state.session) return;

  // Authoritative pre-send auth check. Never spawn a chat we know will fail.
  const auth = await refreshAuth({ silent: true });
  if (!auth.loggedIn) {
    addMessage('system', 'You\'re not signed in yet — Forge can\'t send this message.');
    await promptSignIn();
    return;
  }

  addMessage('user', text);
  inputEl.value = '';
  startTrail();
  setRunning(true);

  const promptWithContext = buildContextPrefix() + text;
  const res = await window.forge.startClaude(state.folder, promptWithContext, state.claudeSessionId);
  if (!res || !res.ok) {
    const reason = res?.reason || 'unknown';
    if (reason === 'not_authenticated') {
      // Auth expired between the pre-check and the spawn call.
      state.auth = { ...(res.auth || {}), checking: false };
      renderAuth();
      addStep('🔒', 'Not signed in — please sign in and try again.', 'error');
      endTrail();
      setRunning(false);
      await promptSignIn();
      return;
    }
    const msg = res?.message ? `${reason}: ${res.message}` : reason;
    addStep('❌', 'Could not start Claude (' + msg + ').', 'error');
    if (reason === 'spawn_failed') {
      addMessage('error',
        'Forge could not launch the "claude" CLI. Install it from https://claude.com/product/claude-code ' +
        'and log in, then reopen Forge. If it is installed but not on PATH, set the CLAUDE_BIN environment variable.'
      );
    }
    endTrail();
    setRunning(false);
    return;
  }
  state.session = res.sessionId;
}

/* ---------- Event handling ---------- */
function fileNameFromPath(p) {
  if (!p) return null;
  const parts = String(p).split(/[\\/]/);
  return parts[parts.length - 1] || null;
}

function relativeIfInside(fullPath) {
  if (!fullPath || !state.folder) return fullPath;
  if (fullPath.startsWith(state.folder)) {
    return fullPath.slice(state.folder.length).replace(/^[\\/]/, '');
  }
  return fullPath;
}

function describeToolUse(name, input) {
  const filePath = input?.file_path || input?.path || null;
  const fileName = fileNameFromPath(filePath);
  const rel = filePath ? relativeIfInside(filePath) : null;
  switch (name) {
    case 'Read':
      return { icon: '📖', label: 'Reading ' + (rel || fileName || 'file'), fileName, verb: 'read' };
    case 'Write':
      return { icon: '✏️', label: 'Writing ' + (rel || fileName || 'file'), fileName, verb: 'write' };
    case 'Edit':
      return { icon: '✏️', label: 'Editing ' + (rel || fileName || 'file'), fileName, verb: 'write' };
    case 'NotebookEdit':
      return { icon: '✏️', label: 'Editing notebook ' + (rel || fileName || ''), fileName, verb: 'write' };
    case 'Bash': {
      const desc = input?.description;
      const cmd = input?.command || '';
      const shortCmd = cmd.length > 90 ? cmd.slice(0, 90) + '…' : cmd;
      return { icon: '⚙️', label: desc ? desc : ('Running: ' + shortCmd), fileName: null };
    }
    case 'Grep':
      return { icon: '🔍', label: 'Searching for "' + (input?.pattern || '') + '"', fileName: null };
    case 'Glob':
      return { icon: '🔍', label: 'Looking for files matching ' + (input?.pattern || ''), fileName: null };
    case 'WebFetch':
      return { icon: '🌐', label: 'Fetching ' + (input?.url || 'a page'), fileName: null };
    case 'WebSearch':
      return { icon: '🔎', label: 'Searching the web: ' + (input?.query || ''), fileName: null };
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'TaskList':
      return { icon: '📋', label: 'Planning next steps', fileName: null };
    default:
      return { icon: '🔧', label: 'Using ' + name, fileName: null };
  }
}

function handleEvent(evt) {
  switch (evt.type) {
    case 'system':
      if (evt.subtype === 'init' && evt.session_id) {
        const isResume = state.claudeSessionId === evt.session_id;
        state.claudeSessionId = evt.session_id;
        if (!isResume) addStep('🚀', 'Started (model: ' + (evt.model || 'unknown') + ')');
      }
      break;
    case 'assistant':
      if (!evt.message) break;
      for (const block of evt.message.content || []) {
        if (block.type === 'text') {
          const t = (block.text || '').trim();
          if (t) addAssistantSay(t);
        } else if (block.type === 'tool_use') {
          const d = describeToolUse(block.name, block.input || {});
          const stepEl = addStep(d.icon, d.label);
          if (d.fileName && d.verb === 'write') highlightFile(d.fileName);
          state.pendingTools.set(block.id, { name: block.name, fileName: d.fileName, verb: d.verb, stepEl });
        }
      }
      break;
    case 'user':
      if (!evt.message) break;
      for (const block of evt.message.content || []) {
        if (block.type === 'tool_result') {
          const info = state.pendingTools.get(block.tool_use_id);
          if (info) {
            info.stepEl.classList.add('done');
            if (info.fileName && info.verb === 'write') markFileDone(info.fileName);
            state.pendingTools.delete(block.tool_use_id);
          }
        }
      }
      break;
    case 'result':
      // Final answer text is already delivered via the last assistant text block.
      // We only note completion here.
      break;
    case 'rate_limit_event':
    default:
      break;
  }
}

/* ---------- Wire up ---------- */
$('choose-folder').addEventListener('click', async () => {
  await setFolder(null);
});

$('landing-browse').addEventListener('click', async () => {
  const p = await window.forge.openFolder();
  if (p) await setFolder(p);
});

$('up-folder').addEventListener('click', async () => {
  if (!state.folder) return;
  const parent = await window.forge.parentFolder(state.folder);
  if (parent) await setFolder(parent);
});

$('send').addEventListener('click', sendPrompt);
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendPrompt();
  }
});

$('stop').addEventListener('click', async () => {
  if (state.session) {
    addStep('🛑', 'Stopping…', 'warn');
    await window.forge.stopClaude(state.session);
  }
});

$('new-chat').addEventListener('click', async () => {
  if (state.session) {
    await window.forge.stopClaude(state.session);
  }
  resetConversation('New conversation started.');
});

$('clear-selection').addEventListener('click', () => {
  state.selectedName = null;
  document.querySelectorAll('.tile.selected').forEach((t) => t.classList.remove('selected'));
  updateSelectionPill();
});

/* ---------- Auth indicator (single source of truth) ---------- */

function renderAuth() {
  const indicator = $('auth-indicator');
  const dot = $('auth-dot');
  const text = $('auth-text');
  const btn = $('auth-signin');
  if (!indicator) return;
  indicator.classList.remove('state-connected', 'state-signed-out', 'state-checking', 'state-error');
  const a = state.auth || {};
  if (a.checking) {
    indicator.classList.add('state-checking');
    text.textContent = 'Checking…';
    btn.hidden = true;
    return;
  }
  if (a.loggedIn) {
    indicator.classList.add('state-connected');
    const parts = ['Connected'];
    if (a.email) parts.push('as ' + a.email);
    if (a.subscriptionType) parts.push('(' + a.subscriptionType + ')');
    text.textContent = parts.join(' ');
    btn.hidden = true;
    return;
  }
  if (a.reason === 'no_bin') {
    indicator.classList.add('state-error');
    text.textContent = 'Claude Code not found';
    btn.hidden = false;
    btn.textContent = 'Set up';
    return;
  }
  indicator.classList.add('state-signed-out');
  text.textContent = 'Not signed in';
  btn.hidden = false;
  btn.textContent = 'Sign in';
}

async function refreshAuth({ silent = false } = {}) {
  if (!silent) {
    state.auth = { ...state.auth, checking: true };
    renderAuth();
  }
  try {
    const auth = await window.forge.authStatus();
    state.auth = { ...auth, checking: false };
  } catch (e) {
    state.auth = { loggedIn: false, reason: 'unknown', error: e.message, checking: false };
  }
  renderAuth();
  return state.auth;
}

function startAuthPolling() {
  if (state.authPollHandle) return;
  // Recheck every 60s so a silently-expired login is caught.
  state.authPollHandle = setInterval(() => {
    // Skip polling while a chat session is active — the pre-send check covers that.
    if (state.session) return;
    refreshAuth({ silent: true });
  }, 60 * 1000);
}

async function promptSignIn() {
  // The subprocess runs in the background. Its exit is not our completion signal —
  // `claude auth status --json` is. We forward user-pasted codes to its stdin via
  // setup:submitCode, and poll auth status until it flips to true.
  let cancelled = false;
  const loginPromise = window.forge.setupLogin().catch((e) => ({ ok: false, error: e.message }));

  const doCancel = async () => {
    cancelled = true;
    await window.forge.setupCancel();
    hideSetup();
    await refreshAuth();
  };

  const showPasteStep = (opts = {}) => {
    let inputRef = null;
    const rendered = showSetup({
      title: 'Sign in to Anthropic',
      sub: opts.sub ||
        'Your browser is opening. Sign in with your Anthropic account, then copy the code shown on the "Paste this in Claude Code" page and paste it below.',
      spinner: false,
      error: opts.error,
      codeInput: {
        label: 'Authorization code',
        placeholder: 'Paste the code from your browser',
        value: opts.keepValue || '',
      },
      actions: [
        {
          label: 'Sign in',
          primary: true,
          onClick: async () => {
            const val = (inputRef?.value || '').trim();
            if (!val) { inputRef?.focus(); return; }
            await handleCodeSubmit(val);
          },
        },
        { label: 'Cancel', onClick: doCancel },
      ],
    });
    inputRef = rendered.inputEl;
  };

  const handleCodeSubmit = async (code) => {
    showSetup({
      title: 'Verifying…',
      sub: 'Checking your sign-in with Anthropic.',
      spinner: true,
      actions: [{ label: 'Cancel', onClick: doCancel }],
    });

    const submit = await window.forge.setupSubmitCode(code);
    if (!submit.ok) {
      showPasteStep({
        error: submit.error || 'Could not send the code to the sign-in helper.',
        sub: 'That didn\'t work — copy the code again and paste it here.',
      });
      return;
    }

    // Poll auth status for up to 30s. The CLI processes the code, updates
    // its config, and `claude auth status --json` flips loggedIn -> true.
    for (let i = 0; i < 15; i++) {
      if (cancelled) return;
      await new Promise((r) => setTimeout(r, 2000));
      const auth = await refreshAuth({ silent: true });
      if (auth.loggedIn) {
        showSetup({ title: 'Connected!', sub: 'All set.', spinner: false });
        setTimeout(() => hideSetup(), 900);
        return;
      }
    }

    // Didn't verify — the code was probably wrong or the CLI is still waiting.
    // Fall back to the paste field so the user can try again without a fresh
    // OAuth round-trip (the subprocess is still alive and still on the same URL).
    showPasteStep({
      error: 'That code didn\'t verify. It may be expired or mistyped. Copy it again and try once more.',
    });
  };

  // First render immediately — user can start pasting as soon as their browser shows the code.
  showPasteStep();

  // If the subprocess dies for any reason and we haven't succeeded, surface that
  // (bad exit + still not authed = tell the user, don't spin forever).
  const result = await loginPromise;
  if (cancelled) return;
  const finalAuth = await refreshAuth({ silent: true });
  if (finalAuth.loggedIn) {
    // Already showing "Connected!" from the poll — nothing to do.
    return;
  }
  // Subprocess exited but we're still not signed in. Show a real error.
  showSetup({
    title: 'Sign-in didn\'t finish',
    sub: 'The sign-in helper ended before Forge could confirm your login.',
    error: result?.error || 'Unknown error.',
    details: result?.details,
    actions: [
      { label: 'Show setup log', onClick: () => window.forge.setupRevealLog() },
      { label: 'Try again', primary: true, onClick: promptSignIn },
      { label: 'Close', onClick: () => hideSetup() },
    ],
  });
}

/* ---------- Setup flow ---------- */
function showSetup({ title, sub, spinner = false, error = null, details = null, actions = [], codeInput = null }) {
  $('setup-overlay').hidden = false;
  $('setup-title').textContent = title || '';
  $('setup-sub').textContent = sub || '';
  $('setup-spinner').hidden = !spinner;
  const errEl = $('setup-error');
  if (error) {
    errEl.innerHTML = '';
    const msg = document.createElement('div');
    msg.textContent = error;
    errEl.appendChild(msg);
    if (details) {
      const disc = document.createElement('details');
      disc.className = 'setup-details';
      const sum = document.createElement('summary');
      sum.textContent = 'View technical details';
      const pre = document.createElement('pre');
      pre.textContent = details;
      disc.appendChild(sum);
      disc.appendChild(pre);
      errEl.appendChild(disc);
    }
    errEl.hidden = false;
  } else {
    errEl.textContent = '';
    errEl.hidden = true;
  }
  const actionsEl = $('setup-actions');
  actionsEl.innerHTML = '';

  let inputEl = null;
  if (codeInput) {
    const wrap = document.createElement('div');
    wrap.className = 'setup-code-input';
    if (codeInput.label) {
      const lab = document.createElement('label');
      lab.textContent = codeInput.label;
      lab.htmlFor = 'setup-code-field';
      wrap.appendChild(lab);
    }
    const input = document.createElement('input');
    input.type = 'text';
    input.id = 'setup-code-field';
    input.placeholder = codeInput.placeholder || '';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.autocapitalize = 'off';
    if (codeInput.value) input.value = codeInput.value;
    wrap.appendChild(input);
    actionsEl.appendChild(wrap);
    inputEl = input;
    // Focus + select next tick so paste-then-Enter works immediately.
    setTimeout(() => { try { input.focus(); input.select(); } catch {} }, 30);
    // Enter submits the primary action if present.
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const primary = actions.find((a) => a.primary);
        if (primary) primary.onClick();
      }
    });
  }

  for (const a of actions) {
    const btn = document.createElement('button');
    btn.className = 'setup-btn' + (a.primary ? ' primary' : '');
    btn.textContent = a.label;
    btn.addEventListener('click', a.onClick);
    actionsEl.appendChild(btn);
  }
  return { inputEl };
}

function hideSetup() {
  $('setup-overlay').hidden = true;
}

async function runSetup() {
  showSetup({ title: 'Getting Forge ready…', sub: 'Just a moment.', spinner: true });
  let status;
  try {
    status = await window.forge.setupStatus();
  } catch (e) {
    showSetup({
      title: 'Something went wrong',
      sub: 'Forge couldn\'t start its setup check.',
      error: e.message,
      actions: [{ label: 'Try again', primary: true, onClick: runSetup }],
    });
    return;
  }

  if (!status.needsSetup) {
    // Seed the auth indicator from the same round-trip.
    if (status.auth) {
      state.auth = { ...status.auth, checking: false };
      renderAuth();
    } else {
      refreshAuth({ silent: true });
    }
    hideSetup();
    renderLanding();
    return;
  }

  if (!status.hasNpm) {
    showSetup({
      title: 'One quick thing',
      sub: 'Forge needs Node.js to install its AI helper. Grab it once, then come back — you\'ll never have to do this again.',
      actions: [
        { label: 'Get Node.js', onClick: () => window.forge.openExternal('https://nodejs.org/en/download') },
        { label: "I've installed it — check again", primary: true, onClick: runSetup },
      ],
    });
    return;
  }

  if (!status.hasClaude) {
    showSetup({
      title: 'Setting up your AI assistant',
      sub: 'Installing helper tools. This can take up to a minute.',
      spinner: true,
    });
    const install = await window.forge.setupInstall();
    if (!install.ok) {
      if (install.errorKind === 'needs_admin') {
        showSetup({
          title: 'Windows needs to grant permission',
          sub: 'Forge needs administrator access for this one-time setup step.',
          error: install.error,
          details: install.details,
          actions: [
            { label: 'Show setup log', onClick: () => window.forge.setupRevealLog() },
            { label: 'I\'ve reopened as administrator — try again', primary: true, onClick: runSetup },
          ],
        });
      } else {
        showSetup({
          title: 'Setup couldn\'t finish',
          sub: 'Forge tried to install its AI helper but hit a snag.',
          error: install.error,
          details: install.details,
          actions: [
            { label: 'Show setup log', onClick: () => window.forge.setupRevealLog() },
            { label: 'Try again', primary: true, onClick: runSetup },
          ],
        });
      }
      return;
    }
  }

  // Run the same paste-in sign-in flow used by the top-bar indicator.
  await promptSignIn();
  // promptSignIn manages its own success/failure UI. If it succeeded, auth
  // state will be loggedIn and the overlay will already be closed.
  const auth = await refreshAuth({ silent: true });
  if (auth.loggedIn) {
    renderLanding();
  }
}

window.forge.onSetupProgress(() => {
  // reserved for progress hints; overlay copy is intentionally stable to avoid flicker
});

renderAuth();
startAuthPolling();
runSetup();

$('auth-signin').addEventListener('click', async () => {
  // Button label depends on state: no CLI → run full setup; otherwise pure sign-in.
  if (state.auth.reason === 'no_bin') {
    await runSetup();
  } else {
    await promptSignIn();
  }
});

window.forge.onEvent(({ event }) => handleEvent(event));

window.forge.onStderr(({ text }) => {
  const t = (text || '').trim();
  if (t) addStep('⚠️', t.split('\n')[0].slice(0, 200), 'warn');
});

window.forge.onError(({ message }) => {
  addStep('❌', 'Error: ' + message, 'error');
});

window.forge.onClosed(({ code, signal, eventCount = 0, skipCount = 0 }) => {
  for (const [, info] of state.pendingTools) {
    if (info.fileName && info.verb === 'write') markFileDone(info.fileName);
  }
  state.pendingTools.clear();
  if (signal === 'SIGTERM' || signal === 'SIGKILL') {
    addStep('🛑', 'Stopped by you.', 'end');
  } else if (code === 0 && eventCount > 0) {
    addStep('✅', 'Done.', 'end');
  } else if (code === 0 && eventCount === 0) {
    addStep('⚠️', 'Finished without producing any output.', 'warn');
    addLogHint();
  } else {
    addStep('⛔', 'Ended (exit code ' + code + ').', 'error');
    if (skipCount > 0) {
      addStep('ℹ️', `${skipCount} unreadable line${skipCount === 1 ? '' : 's'} were skipped — details in the chat log.`, 'warn');
    }
    addLogHint();
  }
  endTrail();
  setRunning(false);
  state.session = null;
  refreshGrid();
});

function addLogHint() {
  if (!state.currentTrail) return;
  const btn = document.createElement('button');
  btn.className = 'setup-btn';
  btn.style.marginTop = '8px';
  btn.style.alignSelf = 'flex-start';
  btn.textContent = 'Show chat log';
  btn.addEventListener('click', () => window.forge.chatRevealLog());
  state.currentTrail.appendChild(btn);
  scrollBottom();
}
