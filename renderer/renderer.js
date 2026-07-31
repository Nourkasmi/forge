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

  addMessage('user', text);
  inputEl.value = '';
  startTrail();
  setRunning(true);

  const promptWithContext = buildContextPrefix() + text;
  const res = await window.forge.startClaude(state.folder, promptWithContext, state.claudeSessionId);
  if (!res || !res.ok) {
    const reason = res?.reason || 'unknown';
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
    case 'parse_error':
      addStep('⚠️', 'Received unparseable output', 'warn');
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

/* ---------- Setup flow ---------- */
function showSetup({ title, sub, spinner = false, error = null, actions = [] }) {
  $('setup-overlay').hidden = false;
  $('setup-title').textContent = title || '';
  $('setup-sub').textContent = sub || '';
  $('setup-spinner').hidden = !spinner;
  const errEl = $('setup-error');
  if (error) { errEl.textContent = error; errEl.hidden = false; }
  else { errEl.textContent = ''; errEl.hidden = true; }
  const actionsEl = $('setup-actions');
  actionsEl.innerHTML = '';
  for (const a of actions) {
    const btn = document.createElement('button');
    btn.className = 'setup-btn' + (a.primary ? ' primary' : '');
    btn.textContent = a.label;
    btn.addEventListener('click', a.onClick);
    actionsEl.appendChild(btn);
  }
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
      showSetup({
        title: 'Setup couldn\'t finish',
        sub: 'Forge tried to install its AI helper but hit a snag.',
        error: install.error,
        actions: [{ label: 'Try again', primary: true, onClick: runSetup }],
      });
      return;
    }
  }

  showSetup({
    title: 'Almost there — sign in',
    sub: 'Your web browser should open in a moment. Sign in with Anthropic there, then come back to this window.',
    spinner: true,
    actions: [{ label: 'Cancel', onClick: async () => {
      await window.forge.setupCancel();
      showSetup({
        title: 'Sign-in cancelled',
        sub: 'You can try again whenever you\'re ready.',
        actions: [{ label: 'Try again', primary: true, onClick: runSetup }],
      });
    } }],
  });
  const login = await window.forge.setupLogin();
  if (!login.ok) {
    showSetup({
      title: 'Sign-in didn\'t finish',
      sub: 'The sign-in step didn\'t complete.',
      error: login.error,
      actions: [{ label: 'Try again', primary: true, onClick: runSetup }],
    });
    return;
  }

  showSetup({
    title: 'Connected!',
    sub: 'All set. Opening Forge…',
  });
  setTimeout(() => {
    hideSetup();
    renderLanding();
  }, 1000);
}

window.forge.onSetupProgress(() => {
  // reserved for progress hints; overlay copy is intentionally stable to avoid flicker
});

runSetup();

window.forge.onEvent(({ event }) => handleEvent(event));

window.forge.onStderr(({ text }) => {
  const t = (text || '').trim();
  if (t) addStep('⚠️', t.split('\n')[0].slice(0, 200), 'warn');
});

window.forge.onError(({ message }) => {
  addStep('❌', 'Error: ' + message, 'error');
});

window.forge.onClosed(({ code, signal }) => {
  for (const [, info] of state.pendingTools) {
    if (info.fileName && info.verb === 'write') markFileDone(info.fileName);
  }
  state.pendingTools.clear();
  if (signal === 'SIGTERM' || signal === 'SIGKILL') {
    addStep('🛑', 'Stopped by you.', 'end');
  } else if (code === 0) {
    addStep('✅', 'Done.', 'end');
  } else {
    addStep('⛔', 'Ended (exit code ' + code + ').', 'error');
  }
  endTrail();
  setRunning(false);
  state.session = null;
  refreshGrid();
});
