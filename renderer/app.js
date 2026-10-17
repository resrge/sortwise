/* SortWise renderer */
const api = window.sortwise;
const $ = (id) => document.getElementById(id);

const state = {
  source: '',
  dest: '',
  mode: 'category',
  groupSimilar: true,
  minGroup: 2,
  includeHidden: false,
  watch: false,
  autoClean: false,
  openAfter: false,
  startWithWindows: false,
  watching: false,
  update: { status: 'idle' },
  groups: [],
  skipped: [],
  excluded: new Set(),   // file paths the user unticked
  open: new Set(),       // expanded group ids
  filter: '',
  busy: false,
  info: null,
};

const MODE_HINTS = {
  category: 'Images, Documents, Installers, Archives… one folder per kind of file.',
  extension: 'One folder per extension — PDF, ZIP, PNG, EXE…',
  similar: 'Only groups files whose names match. Everything else goes to “Misc”.',
};

// ---------- Icons ----------
const ICONS = {
  Images: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="M20 16l-4.5-4.5L6 19"/>',
  Videos: '<rect x="3.5" y="5.5" width="17" height="13" rx="2.5"/><path d="M10.5 9.5v5l4-2.5z"/>',
  Audio: '<path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>',
  Documents: '<path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z"/><path d="M14 3.5V8h4.5M9 13h6M9 16.5h4"/>',
  Archives: '<rect x="4" y="4" width="16" height="16" rx="2.5"/><path d="M12 4v3m0 2v2m0 2v2"/><rect x="10.5" y="15" width="3" height="3" rx=".8"/>',
  Installers: '<path d="M12 4v10m-4-4l4 4 4-4"/><path d="M4.5 15v2.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V15"/>',
  Code: '<path d="M9 8l-4 4 4 4M15 8l4 4-4 4M13 6l-2 12"/>',
  Fonts: '<path d="M5 19l5.5-14h1L17 19M7.5 13.5h7"/>',
  'Disk Images': '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.2"/>',
  Torrents: '<path d="M12 4v11m-4.5-4.5L12 15l4.5-4.5M5 19.5h14"/>',
  Other: '<path d="M4 7.5A2.5 2.5 0 0 1 6.5 5h3.5l2 2h5.5A2.5 2.5 0 0 1 20 9.5v8a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5z"/>',
  Family: '<path d="M8 7h11M8 12h11M8 17h11"/><circle cx="4.5" cy="7" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="17" r="1"/>',
};
const COLORS = {
  Images: '--c-images', Videos: '--c-videos', Audio: '--c-audio', Documents: '--c-documents',
  Archives: '--c-archives', Installers: '--c-installers', Code: '--c-code', Fonts: '--c-fonts',
  'Disk Images': '--c-disk', Torrents: '--c-torrents', Other: '--c-other',
};
const svg = (inner) => `<svg viewBox="0 0 24 24">${inner}</svg>`;

// ---------- Helpers ----------
function fmtSize(b) {
  if (b < 1024) return b + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { b /= 1024; i++; } while (b >= 1024 && i < u.length - 1);
  return b.toFixed(b < 10 ? 1 : 0) + ' ' + u[i];
}
function fmtDate(ms) {
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
function baseName(p) { return p.split(/[\\/]/).filter(Boolean).pop() || p; }
function joinPath(a, b) { const sep = a.includes('\\') ? '\\' : '/'; return a.replace(/[\\/]+$/, '') + sep + b; }
function plural(n, w) { return `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`; }
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function dominantCategory(files) {
  const c = {};
  for (const f of files) c[f.category] = (c[f.category] || 0) + 1;
  return Object.entries(c).sort((a, b) => b[1] - a[1])[0]?.[0] || 'Other';
}

// ---------- Settings ----------
const SETTING_KEYS = ['source', 'dest', 'mode', 'groupSimilar', 'minGroup', 'includeHidden',
  'watch', 'autoClean', 'openAfter', 'startWithWindows'];

function applySettings(s) {
  for (const k of SETTING_KEYS) if (s[k] !== undefined) state[k] = s[k];
  if (!state.source) state.source = state.info.downloads;
  if (!state.dest) state.dest = joinPath(state.source, 'Organized');
}
async function loadSettings() {
  state.info = await api.info();
  applySettings(await api.getSettings());
  const { version, build } = state.info;
  $('version').textContent = `v${version}${build ? ' build ' + build : ''}`;
  const ws = await api.watchState();
  state.watching = ws.watching;
  renderUpdate(await api.updateState());
}
function saveSettings() {
  const s = {};
  for (const k of SETTING_KEYS) s[k] = state[k];
  return api.setSettings(s);
}

// ---------- Sidebar ----------
function renderSidebar() {
  $('sourceName').textContent = state.source ? baseName(state.source) : 'Choose a folder';
  $('sourcePath').textContent = state.source || '—';
  $('destName').textContent = state.dest ? baseName(state.dest) : 'Choose a folder';
  $('destPath').textContent = state.dest || '—';

  for (const b of $('modeSeg').children) {
    const on = b.dataset.mode === state.mode;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', on);
  }
  $('modeHint').textContent = MODE_HINTS[state.mode];
  $('groupSimilar').checked = state.groupSimilar || state.mode === 'similar';
  $('similarToggleRow').classList.toggle('disabled', state.mode === 'similar');
  $('minVal').textContent = state.minGroup;
  $('includeHidden').checked = state.includeHidden;
  $('emptyScan').textContent = state.source ? `Scan ${baseName(state.source)}` : 'Choose a folder';

  $('watch').checked = state.watch;
  $('autoClean').checked = state.autoClean;
  $('openAfter').checked = state.openAfter;
  $('startWithWindows').checked = state.startWithWindows;
  $('startRow').hidden = state.info?.platform !== 'win32';

  const pill = $('watchPill');
  pill.hidden = !state.watch;
  pill.classList.toggle('auto', state.autoClean);
  $('watchPillText').textContent =
    `${state.autoClean ? 'Auto-organizing' : 'Watching'} ${baseName(state.source)}`;
}

// ---------- Updates ----------
function renderUpdate(st) {
  state.update = st || { status: 'idle' };
  const { status, update, error, progress } = state.update;
  const statusEl = $('updateStatus');
  const action = $('updateAction');
  const bar = $('updateBar');
  statusEl.className = 'ub-status';
  action.disabled = false;
  bar.hidden = true;
  $('updatePill').hidden = status !== 'ready';

  switch (status) {
    case 'checking':
      statusEl.textContent = 'Checking for updates…';
      action.textContent = 'Checking…'; action.disabled = true;
      break;
    case 'none':
      statusEl.textContent = 'You’re up to date'; statusEl.classList.add('good');
      action.textContent = 'Check again';
      break;
    case 'available':
      statusEl.textContent = `v${update.version} available`;
      action.textContent = state.info?.packaged ? 'Downloading…' : 'Install builds only';
      action.disabled = true;
      break;
    case 'downloading':
      statusEl.textContent = `Downloading v${update.version}… ${Math.round((progress || 0) * 100)}%`;
      action.textContent = 'Downloading…'; action.disabled = true;
      bar.hidden = false;
      $('updateFill').style.width = `${Math.round((progress || 0) * 100)}%`;
      break;
    case 'ready':
      statusEl.textContent = `v${update.version}${update.build ? ' build ' + update.build : ''} is ready`;
      statusEl.classList.add('good');
      action.textContent = 'Restart to update';
      $('updatePillText').textContent = `Restart to update to v${update.version}`;
      break;
    case 'error':
      statusEl.textContent = 'Couldn’t check for updates'; statusEl.classList.add('bad');
      statusEl.title = error || '';
      action.textContent = 'Try again';
      break;
    default:
      statusEl.textContent = '';
      action.textContent = 'Check for updates';
  }
}
async function updateAction() {
  if (state.update.status === 'ready') return installUpdate();
  try { renderUpdate(await api.checkUpdates()); } catch (err) { toast(cleanErr(err), 'bad'); }
}
async function installUpdate() {
  toast('Installing the update — SortWise will reopen when it’s done.', 'good');
  const ok = await api.installUpdate();
  if (!ok) toast('The update isn’t ready yet.', 'bad');
}

// ---------- Scan ----------
async function scan({ quiet = false } = {}) {
  if (!state.source) return pickSource();
  if (!state.dest) return pickDest();
  setBusy(true);
  try {
    const res = await api.scan({
      source: state.source, dest: state.dest, mode: state.mode,
      groupSimilar: state.groupSimilar, minGroup: state.minGroup, includeHidden: state.includeHidden,
    });
    state.groups = res.groups;
    state.skipped = res.skipped;
    // Keep exclusions only for files that still exist in the plan
    const all = new Set(res.groups.flatMap(g => g.files.map(f => f.path)));
    state.excluded = new Set([...state.excluded].filter(p => all.has(p)));
    renderPlan();
    if (!quiet && !res.total) toast('That folder has no loose files to organize. Nice and tidy!', 'good');
  } catch (err) {
    toast(cleanErr(err), 'bad');
  } finally {
    setBusy(false);
  }
}
function cleanErr(err) { return String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); }

// ---------- Plan rendering ----------
function selectedFiles(g) { return g.files.filter(f => !state.excluded.has(f.path)); }
function matches(f) { return !state.filter || f.name.toLowerCase().includes(state.filter); }

function renderPlan() {
  const has = state.groups.length > 0;
  $('empty').hidden = has;
  $('toolbar').hidden = !has;
  $('actionbar').hidden = !has;

  const box = $('groups');
  box.textContent = '';
  if (!has) { updateSummary(); return; }

  for (const g of state.groups) {
    const visible = g.files.filter(matches);
    if (!visible.length) continue;
    box.appendChild(groupCard(g, visible));
  }

  if (state.skipped.length) {
    const s = el('div', 'skipped');
    const b = el('b', null, plural(state.skipped.length, 'file') + ' left alone');
    s.append(b, document.createTextNode(' — still downloading or temporary: ' +
      state.skipped.slice(0, 4).map(x => x.name).join(', ') + (state.skipped.length > 4 ? '…' : '')));
    box.appendChild(s);
  }
  updateSummary();
}

function groupCard(g, visible) {
  const category = g.kind === 'type' && COLORS[g.label] ? g.label
    : (g.parent && COLORS[g.parent]) ? g.parent
    : dominantCategory(g.files);
  const color = `var(${COLORS[category] || '--c-other'})`;

  const card = el('div', 'group' + (g.parent ? ' child' : '') + (state.open.has(g.id) || state.filter ? ' open' : ''));
  card.dataset.id = g.id;

  const head = el('div', 'g-head');
  const cb = el('input', 'check');
  cb.type = 'checkbox';
  cb.addEventListener('click', e => e.stopPropagation());
  cb.addEventListener('change', () => {
    for (const f of g.files) cb.checked ? state.excluded.delete(f.path) : state.excluded.add(f.path);
    refreshGroup(card, g);
    updateSummary();
  });

  const icon = el('div', 'g-icon');
  icon.style.background = `color-mix(in srgb, ${color} 16%, transparent)`;
  icon.style.color = color;
  icon.innerHTML = svg(g.kind === 'family' ? ICONS.Family : (ICONS[category] || ICONS.Other));

  const title = el('div', 'g-title');
  const name = el('div', 'g-name', g.label);
  if (g.kind === 'family') name.appendChild(el('span', 'badge', 'similar'));
  const p = el('div', 'g-path', '→ ' + g.target);
  p.title = g.target;
  title.append(name, p);

  const meta = el('div', 'g-meta');
  const count = el('span', 'g-count');
  const size = el('span', 'g-size');
  const chev = el('span', 'chev');
  chev.innerHTML = svg('<path d="M9 6l6 6-6 6"/>');
  meta.append(count, size, chev);

  head.append(cb, icon, title, meta);
  head.addEventListener('click', () => {
    card.classList.toggle('open');
    card.classList.contains('open') ? state.open.add(g.id) : state.open.delete(g.id);
    if (card.classList.contains('open') && !card.querySelector('.g-files').childElementCount) fillFiles(card, g);
  });

  const filesBox = el('div', 'g-files');
  card.append(head, filesBox);
  if (card.classList.contains('open')) fillFiles(card, g, visible);
  refreshGroup(card, g);
  return card;
}

function fillFiles(card, g, visible = g.files.filter(matches)) {
  const box = card.querySelector('.g-files');
  box.textContent = '';
  for (const f of visible) {
    const row = el('div', 'f-row' + (state.excluded.has(f.path) ? ' off' : ''));
    const cb = el('input', 'check');
    cb.type = 'checkbox';
    cb.checked = !state.excluded.has(f.path);
    cb.addEventListener('change', () => {
      cb.checked ? state.excluded.delete(f.path) : state.excluded.add(f.path);
      row.classList.toggle('off', !cb.checked);
      refreshGroup(card, g);
      updateSummary();
    });
    const name = el('div', 'f-name', f.name);
    name.title = f.name;
    const rev = el('button', 'icon-btn f-reveal');
    rev.title = 'Show in folder';
    rev.innerHTML = svg('<path d="M14 4h6v6M20 4l-8 8"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>');
    rev.addEventListener('click', () => api.reveal(f.path));
    row.append(cb, name, el('div', 'f-size', fmtSize(f.size)), el('div', 'f-date', fmtDate(f.mtime)), rev);
    box.appendChild(row);
  }
}

function refreshGroup(card, g) {
  const sel = selectedFiles(g);
  const cb = card.querySelector('.g-head .check');
  cb.checked = sel.length === g.files.length;
  cb.indeterminate = sel.length > 0 && sel.length < g.files.length;
  card.classList.toggle('off', sel.length === 0);
  card.querySelector('.g-count').textContent = sel.length === g.files.length
    ? plural(g.files.length, 'file')
    : `${sel.length} of ${g.files.length}`;
  card.querySelector('.g-size').textContent = fmtSize(sel.reduce((a, f) => a + f.size, 0));
  // sync rows if rendered
  card.querySelectorAll('.f-row').forEach((row, i) => {
    const f = g.files.filter(matches)[i];
    if (!f) return;
    const on = !state.excluded.has(f.path);
    row.querySelector('.check').checked = on;
    row.classList.toggle('off', !on);
  });
}

function updateSummary() {
  const files = state.groups.flatMap(g => g.files);
  const sel = files.filter(f => !state.excluded.has(f.path));
  const folders = new Set(state.groups.filter(g => selectedFiles(g).length).map(g => g.folder.split(/[\\/]/)[0]));
  const subs = state.groups.filter(g => g.kind === 'family' && selectedFiles(g).length).length;

  const stats = $('stats');
  stats.textContent = '';
  const add = (v, l) => { const s = el('div', 'stat'); s.append(el('b', null, v), el('span', null, l)); stats.appendChild(s); };
  add(files.length.toLocaleString(), 'files found');
  add(folders.size, folders.size === 1 ? 'folder' : 'folders');
  add(subs, subs === 1 ? 'name group' : 'name groups');
  add(fmtSize(files.reduce((a, f) => a + f.size, 0)), 'total');

  $('selCount').textContent = `${plural(sel.length, 'file')} selected · ${fmtSize(sel.reduce((a, f) => a + f.size, 0))}`;
  $('selDest').textContent = 'into ' + state.dest;
  $('goBtn').disabled = sel.length === 0 || state.busy;
}

// ---------- Execute ----------
async function organize() {
  const moves = [];
  for (const g of state.groups) for (const f of selectedFiles(g)) moves.push({ from: f.path, toDir: g.target });
  if (!moves.length) return;

  showProgress('Moving files…', 0, moves.length);
  setBusy(true);
  try {
    const res = await api.execute({ source: state.source, dest: state.dest, moves });
    hideProgress();
    if (res.errors.length) {
      toast(`Moved ${plural(res.moved, 'file')}. ${res.errors.length} couldn't be moved (in use or no permission).`, 'bad');
    } else {
      const dest = state.dest;
      const actions = [{ label: 'Undo', fn: () => undo(res.id) }];
      // With "Open folder after organizing" on, Explorer is already opening
      if (!state.openAfter) actions.unshift({ label: 'Open folder', fn: () => api.open(dest) });
      toast(`Moved ${plural(res.moved, 'file')} into ${baseName(dest)}.`, 'good', actions);
    }
    state.excluded.clear();
    await scan({ quiet: true });
  } catch (err) {
    hideProgress();
    toast(cleanErr(err), 'bad');
  } finally {
    setBusy(false);
  }
}

async function undo(id) {
  if (!id) return;
  showProgress('Putting files back…', 0, 1);
  try {
    const res = await api.undo(id);
    hideProgress();
    toast(res.errors.length
      ? `Restored ${plural(res.restored, 'file')}; ${res.errors.length} couldn't be restored.`
      : `Restored ${plural(res.restored, 'file')} to where they were.`, res.errors.length ? 'bad' : 'good');
    await renderHistory();
    if (state.groups.length || state.source) await scan({ quiet: true });
  } catch (err) {
    hideProgress();
    toast(cleanErr(err), 'bad');
  }
}

// ---------- History drawer ----------
async function renderHistory() {
  const list = $('historyList');
  list.textContent = '';
  const items = await api.history();
  if (!items.length) { list.appendChild(el('div', 'h-empty', 'Nothing organized yet.')); return; }
  for (const h of items) {
    const it = el('div', 'h-item' + (h.undone ? ' undone' : ''));
    const top = el('div', 'h-top');
    const countEl = el('span', 'h-count', plural(h.count, 'file') + (h.undone ? ' · undone' : ''));
    if (h.auto) { countEl.append(' '); countEl.appendChild(el('span', 'badge auto', 'auto')); }
    top.append(countEl,
      el('span', 'h-date', new Date(h.date).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })));
    const from = el('div', 'h-path', 'From ' + h.source); from.title = h.source;
    const to = el('div', 'h-path', 'To ' + h.dest); to.title = h.dest;
    const acts = el('div', 'h-actions');
    if (!h.undone) {
      const u = el('button', 'ghost-btn sm', 'Undo');
      u.addEventListener('click', () => undo(h.id));
      acts.appendChild(u);
    }
    const o = el('button', 'ghost-btn sm', 'Open destination');
    o.addEventListener('click', () => api.open(h.dest));
    acts.appendChild(o);
    it.append(top, from, to, acts);
    list.appendChild(it);
  }
}
function openDrawer() { renderHistory(); $('scrim').hidden = false; $('drawer').classList.add('open'); $('drawer').setAttribute('aria-hidden', 'false'); }
function closeDrawer() { $('scrim').hidden = true; $('drawer').classList.remove('open'); $('drawer').setAttribute('aria-hidden', 'true'); }

// ---------- Progress / busy / toast ----------
function showProgress(title, done, total) {
  $('pTitle').textContent = title;
  setProgress(done, total);
  $('progress').hidden = false;
}
function setProgress(done, total) {
  $('pFill').style.width = (total ? (done / total) * 100 : 0) + '%';
  $('pCount').textContent = `${done} / ${total}`;
}
function hideProgress() { $('progress').hidden = true; }
function setBusy(b) {
  state.busy = b;
  $('scanBtn').disabled = b;
  $('goBtn').disabled = b || !state.groups.some(g => selectedFiles(g).length);
}
function toast(msg, kind = '', actions = []) {
  const t = el('div', 'toast ' + kind);
  t.appendChild(el('span', null, msg));
  if (actions.length) {
    const a = el('div', 't-actions');
    for (const act of actions) {
      const b = el('button', 'ghost-btn sm', act.label);
      b.addEventListener('click', () => { act.fn(); t.remove(); });
      a.appendChild(b);
    }
    t.appendChild(a);
  }
  $('toasts').appendChild(t);
  setTimeout(() => t.remove(), actions.length ? 9000 : 5000);
}

// ---------- Folder pickers ----------
async function pickSource() {
  const p = await api.pickFolder({ title: 'Choose the folder to organize', defaultPath: state.source || state.info.downloads });
  if (!p) return;
  const destWasDefault = !state.dest || state.dest === joinPath(state.source, 'Organized');
  state.source = p;
  if (destWasDefault) state.dest = joinPath(p, 'Organized');
  state.excluded.clear();
  saveSettings(); renderSidebar();
  if (state.groups.length) scan();
}
async function pickDest() {
  const p = await api.pickFolder({ title: 'Choose where organized folders go', defaultPath: state.dest || state.source });
  if (!p) return;
  state.dest = p;
  saveSettings(); renderSidebar();
  if (state.groups.length) scan({ quiet: true });
}

// ---------- Wire up ----------
function optionChanged() {
  saveSettings(); renderSidebar();
  if (state.groups.length) scan({ quiet: true });
}

$('sourceBtn').addEventListener('click', pickSource);
$('destBtn').addEventListener('click', pickDest);
$('destInside').addEventListener('click', () => {
  if (!state.source) return;
  state.dest = joinPath(state.source, 'Organized');
  optionChanged();
});
$('modeSeg').addEventListener('click', e => {
  const m = e.target.closest('button')?.dataset.mode;
  if (m && m !== state.mode) { state.mode = m; state.open.clear(); optionChanged(); }
});
$('groupSimilar').addEventListener('change', e => { state.groupSimilar = e.target.checked; optionChanged(); });
$('includeHidden').addEventListener('change', e => { state.includeHidden = e.target.checked; optionChanged(); });
$('minDown').addEventListener('click', () => { if (state.minGroup > 2) { state.minGroup--; optionChanged(); } });
$('minUp').addEventListener('click', () => { if (state.minGroup < 20) { state.minGroup++; optionChanged(); } });
$('scanBtn').addEventListener('click', () => scan());
$('emptyScan').addEventListener('click', () => scan());
$('goBtn').addEventListener('click', organize);
$('selectAll').addEventListener('click', () => { state.excluded.clear(); renderPlan(); });
$('selectNone').addEventListener('click', () => {
  for (const g of state.groups) for (const f of g.files) state.excluded.add(f.path);
  renderPlan();
});
$('expandAll').addEventListener('click', () => {
  const allOpen = state.groups.every(g => state.open.has(g.id));
  state.groups.forEach(g => allOpen ? state.open.delete(g.id) : state.open.add(g.id));
  $('expandAll').textContent = allOpen ? 'Expand all' : 'Collapse all';
  renderPlan();
});
let filterTimer;
$('filter').addEventListener('input', e => {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => { state.filter = e.target.value.trim().toLowerCase(); renderPlan(); }, 120);
});
$('historyBtn').addEventListener('click', openDrawer);
$('drawerClose').addEventListener('click', closeDrawer);
$('scrim').addEventListener('click', closeDrawer);
$('clearHistory').addEventListener('click', async () => { await api.clearHistory(); renderHistory(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeDrawer();
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r') { e.preventDefault(); scan(); }
});
api.onProgress(({ done, total }) => setProgress(done, total));

// ---------- Automation ----------
async function setAutomation(patch) {
  Object.assign(state, patch);
  if (state.autoClean) state.watch = true;          // auto-organize needs watching
  if (!state.watch) state.autoClean = false;
  renderSidebar();
  applySettings(await saveSettings());
  renderSidebar();
  if (patch.autoClean) toast(`New files in ${baseName(state.source)} will be organized as soon as they finish downloading.`, 'good');
  else if (patch.watch) toast(`Watching ${baseName(state.source)} for new files.`, 'good');
}
$('watch').addEventListener('change', e => setAutomation({ watch: e.target.checked }));
$('autoClean').addEventListener('change', e => setAutomation({ autoClean: e.target.checked }));
$('openAfter').addEventListener('change', e => setAutomation({ openAfter: e.target.checked }));
$('startWithWindows').addEventListener('change', e => setAutomation({ startWithWindows: e.target.checked }));
$('watchPill').addEventListener('click', () => $('watch').closest('.block').scrollIntoView({ behavior: 'smooth' }));

const openDest = () => api.open(state.dest);
$('openDestBtn').addEventListener('click', openDest);
$('abOpenBtn').addEventListener('click', openDest);

$('updateAction').addEventListener('click', updateAction);
$('updatePill').addEventListener('click', installUpdate);

// Changes made from the tray menu
api.onSettingsChanged(s => { applySettings(s); renderSidebar(); });
api.onWatchState(ws => { state.watching = ws.watching; renderSidebar(); });
api.onUpdateState(renderUpdate);
api.onHistoryChanged(() => { if ($('drawer').classList.contains('open')) renderHistory(); });

// New files arrived while watching (auto-organize off)
api.onNewFiles(({ count, names }) => {
  if (state.groups.length) scan({ quiet: true });
  toast(count === 1 ? `New file: ${names[0]}` : `${count} new files in ${baseName(state.source)}`, '',
    state.groups.length ? [] : [{ label: 'Scan', fn: () => scan() }]);
});

// Files were auto-organized in the background
api.onChanged(({ auto, moved, errors, id }) => {
  if (!auto) return;
  if (state.groups.length) scan({ quiet: true });
  if (moved) {
    toast(`Auto-organized ${plural(moved, 'new file')}${errors ? ` (${errors} couldn’t move)` : ''}.`, errors ? 'bad' : 'good', [
      { label: 'Open folder', fn: openDest },
      { label: 'Undo', fn: () => undo(id) },
    ]);
  }
});

(async () => {
  await loadSettings();
  renderSidebar();
})();
