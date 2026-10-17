// SortWise core: scanning, grouping, planning, moving and undo.
// Pure Node (no Electron imports) so it can be tested on its own.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

// ---------- File type categories ----------
const CATEGORIES = {
  Images:     ['jpg','jpeg','png','gif','bmp','webp','svg','ico','tif','tiff','heic','heif','raw','cr2','nef','psd','avif'],
  Videos:     ['mp4','mkv','avi','mov','wmv','flv','webm','m4v','mpg','mpeg','3gp'],
  Audio:      ['mp3','wav','flac','aac','ogg','m4a','wma','opus','mid','midi'],
  Documents:  ['pdf','doc','docx','odt','rtf','txt','md','xls','xlsx','ods','csv','ppt','pptx','odp','epub','mobi','pages','numbers','key'],
  Archives:   ['zip','rar','7z','tar','gz','bz2','xz','tgz','zst','cab'],
  Installers: ['exe','msi','msix','appx','dmg','pkg','deb','rpm','appimage','apk'],
  Code:       ['js','ts','jsx','tsx','json','html','htm','css','scss','py','cs','java','c','cpp','h','hpp','go','rs','php','rb','sh','bat','ps1','xml','yml','yaml','ini','sql','lua'],
  Fonts:      ['ttf','otf','woff','woff2','fon'],
  'Disk Images': ['iso','img','vhd','vhdx','vmdk','bin','cue'],
  Torrents:   ['torrent'],
};

const EXT_TO_CATEGORY = {};
for (const [cat, exts] of Object.entries(CATEGORIES)) {
  for (const e of exts) EXT_TO_CATEGORY[e] = cat;
}

// Files a browser is still writing, or OS junk — never touch these.
const SKIP_EXTS = new Set(['crdownload','part','partial','download','tmp','opdownload','!ut','lnk']);
const SKIP_NAMES = new Set(['desktop.ini','thumbs.db','.ds_store']);

function getExt(name) {
  const lower = name.toLowerCase();
  // Treat .tar.gz etc. as a single extension
  for (const multi of ['tar.gz','tar.bz2','tar.xz','tar.zst']) {
    if (lower.endsWith('.' + multi)) return multi;
  }
  const e = path.extname(lower);
  return e ? e.slice(1) : '';
}

function stripExt(name, ext) {
  return ext ? name.slice(0, name.length - ext.length - 1) : name;
}

function categoryFor(ext) {
  return EXT_TO_CATEGORY[ext] || (ext.startsWith('tar.') ? 'Archives' : 'Other');
}

// ---------- Similar-name detection ----------
// Reduces a filename to a "family" key, so that
//   invoice_2024-03.pdf, Invoice 2024-04 (1).pdf, invoice-final-v2.pdf
// all become "invoice".
const NOISE_WORDS = new Set(['copy','final','new','old','edited','edit','backup','bak','draft','latest','updated','setup','installer','x64','x86','win','win64','win32','amd64','arm64','portable','full','hd','fhd','4k','1080p','720p','img','dsc','screenshot','scan']);

function familyKey(baseName) {
  let s = baseName.toLowerCase();
  s = s.replace(/\(\d+\)|\[\d+\]/g, ' ');                       // (1) [2]
  s = s.replace(/\b\d{4}[-_.]?\d{2}[-_.]?\d{2}([ t_-]?\d{2}[-_.:]?\d{2}([-_.:]?\d{2})?)?\b/g, ' '); // dates / timestamps
  s = s.replace(/\bv?\d+(\.\d+)+[a-z]?\b/g, ' ');                // versions 1.2.3, v2.0
  s = s.replace(/\bv\d+\b/g, ' ');                               // v2
  s = s.replace(/[_\-.+,~]+/g, ' ');                             // separators -> space
  s = s.replace(/([a-z])\d{3,}\b/g, '$1');                       // img4412 -> img, keeps q3
  const words = s.split(/\s+/).filter(t => t && !/^\d+$/.test(t));
  const meaningful = words.filter(t => !NOISE_WORDS.has(t));
  // If only noise words remain (e.g. "Screenshot", "IMG"), group by those instead
  const key = (meaningful.length ? meaningful : words).join(' ').trim();
  return key.length >= 2 ? key : '';
}

// Folder label for a family, keeping the original casing where possible:
// key "autounzip" + "AutoUnzip-Setup-0.7.0.exe" -> "AutoUnzip"
function prettyName(key, sampleNames = []) {
  return key.split(' ').map(word => {
    const re = new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    for (const n of sampleNames) {
      const m = n.match(re);
      if (m && m[0] !== m[0].toLowerCase()) return m[0];
    }
    return word.charAt(0).toUpperCase() + word.slice(1);
  }).join(' ');
}

// Folder names must be legal on Windows too
function safeFolderName(name) {
  let n = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim();
  n = n.replace(/[. ]+$/, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(n)) n = '_' + n;
  return n.slice(0, 80) || 'Unnamed';
}

// ---------- Scanning ----------
async function scanFolder(sourceDir, opts = {}) {
  const { includeHidden = false } = opts;
  const entries = await fsp.readdir(sourceDir, { withFileTypes: true });
  const files = [];
  const skipped = [];
  for (const ent of entries) {
    if (!ent.isFile()) continue; // only loose files in the top level
    const name = ent.name;
    const ext = getExt(name);
    if (SKIP_NAMES.has(name.toLowerCase())) continue;
    if (!includeHidden && name.startsWith('.')) continue;
    if (SKIP_EXTS.has(ext)) { skipped.push({ name, reason: 'Still downloading or temporary' }); continue; }
    const full = path.join(sourceDir, name);
    let stat;
    try { stat = await fsp.stat(full); } catch { continue; }
    const base = stripExt(name, ext);
    files.push({
      name, path: full, ext, size: stat.size, mtime: stat.mtimeMs,
      category: categoryFor(ext),
      family: familyKey(base),
    });
  }
  return { files, skipped };
}

// ---------- Planning ----------
// mode: 'category' | 'extension' | 'similar'
// groupSimilar: inside each type folder, make sub-folders for name families
// minGroup: smallest family that earns its own folder
// existing: result of loadExistingFamilies(destDir) — lets a lone new file join a
// name folder that an earlier run already created (e.g. Documents/Invoice).
function buildPlan(files, opts = {}) {
  const { mode = 'category', groupSimilar = true, minGroup = 2, destDir, existing = null } = opts;

  const existingFolder = (top, fam) => {
    if (!existing) return null;
    const map = top ? existing.byTop.get(safeFolderName(top).toLowerCase()) : existing.topLevel;
    return map ? map.get(fam) || null : null;
  };

  const topFolder = f => {
    if (mode === 'extension') return f.ext ? f.ext.toUpperCase() : 'No Extension';
    if (mode === 'similar') return null;
    return f.category;
  };

  // Bucket by top folder first
  const buckets = new Map();
  for (const f of files) {
    const top = topFolder(f) ?? '';
    if (!buckets.has(top)) buckets.set(top, []);
    buckets.get(top).push(f);
  }

  const groups = [];
  for (const [top, list] of buckets) {
    const useFamilies = mode === 'similar' || groupSimilar;
    const families = new Map();
    const loose = [];

    if (useFamilies) {
      for (const f of list) {
        if (!f.family) { loose.push(f); continue; }
        if (!families.has(f.family)) families.set(f.family, []);
        families.get(f.family).push(f);
      }
      for (const [fam, members] of families) {
        const already = existingFolder(top, fam);
        if (members.length < minGroup && !already) { loose.push(...members); continue; }
        const sub = already || safeFolderName(prettyName(fam, members.map(m => m.name)));
        const rel = top ? path.join(safeFolderName(top), sub) : sub;
        groups.push({ id: rel, label: sub, parent: top || null, folder: rel, kind: 'family', files: members });
      }
    } else {
      loose.push(...list);
    }

    if (loose.length) {
      const rel = top ? safeFolderName(top) : 'Misc';
      groups.push({ id: rel, label: top || 'Misc', parent: null, folder: rel, kind: 'type', files: loose });
    }
  }

  // Sort: by parent/type, families after their type folder, larger first
  groups.sort((a, b) => {
    const pa = a.parent || a.label, pb = b.parent || b.label;
    if (pa !== pb) return pa.localeCompare(pb);
    if (a.kind !== b.kind) return a.kind === 'type' ? -1 : 1;
    return b.files.length - a.files.length;
  });

  for (const g of groups) {
    g.target = destDir ? path.join(destDir, g.folder) : g.folder;
    g.files.sort((a, b) => a.name.localeCompare(b.name));
  }
  return groups;
}

// Reads the destination folder for name folders made by earlier runs.
//   byTop:    "documents" -> Map("invoice" -> "Invoice")      (File type / Extension modes)
//   topLevel: "invoice"   -> "Invoice"                        (Similar names mode)
async function loadExistingFamilies(destDir) {
  const result = { byTop: new Map(), topLevel: new Map() };
  if (!destDir) return result;
  let tops;
  try { tops = await fsp.readdir(destDir, { withFileTypes: true }); } catch { return result; }
  for (const t of tops) {
    if (!t.isDirectory()) continue;
    const fam = familyKey(t.name);
    if (fam && !result.topLevel.has(fam)) result.topLevel.set(fam, t.name);
    const inner = new Map();
    try {
      for (const s of await fsp.readdir(path.join(destDir, t.name), { withFileTypes: true })) {
        if (!s.isDirectory()) continue;
        const f = familyKey(s.name);
        if (f && !inner.has(f)) inner.set(f, s.name);
      }
    } catch { /* unreadable folder, skip */ }
    result.byTop.set(t.name.toLowerCase(), inner);
  }
  return result;
}

// ---------- Moving ----------
async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

// "report.pdf" -> "report (2).pdf" until free
async function uniquePath(dir, name) {
  let candidate = path.join(dir, name);
  if (!(await exists(candidate))) return candidate;
  const ext = getExt(name);
  const base = stripExt(name, ext);
  for (let i = 2; i < 10000; i++) {
    candidate = path.join(dir, `${base} (${i})${ext ? '.' + ext : ''}`);
    if (!(await exists(candidate))) return candidate;
  }
  throw new Error('Could not find a free name for ' + name);
}

// rename, or copy+delete when crossing drives
async function moveFile(src, dest) {
  try {
    await fsp.rename(src, dest);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    await fsp.copyFile(src, dest, fs.constants.COPYFILE_EXCL);
    const st = await fsp.stat(src);
    await fsp.utimes(dest, st.atime, st.mtime);
    await fsp.unlink(src);
  }
}

// moves: [{ from, toDir }]; onProgress(doneCount, total, item)
async function executeMoves(moves, onProgress = () => {}) {
  const log = [];
  const errors = [];
  let done = 0;
  for (const m of moves) {
    try {
      await fsp.mkdir(m.toDir, { recursive: true });
      const dest = await uniquePath(m.toDir, path.basename(m.from));
      await moveFile(m.from, dest);
      log.push({ from: m.from, to: dest });
    } catch (err) {
      errors.push({ file: m.from, message: err.message });
    }
    done++;
    onProgress(done, moves.length, m);
  }
  return { log, errors };
}

// Moves everything back and removes folders left empty
async function undoMoves(log, onProgress = () => {}) {
  const errors = [];
  const touchedDirs = new Set();
  let done = 0;
  for (const entry of [...log].reverse()) {
    try {
      const destDir = path.dirname(entry.from);
      await fsp.mkdir(destDir, { recursive: true });
      const back = (await exists(entry.from))
        ? await uniquePath(destDir, path.basename(entry.from))
        : entry.from;
      await moveFile(entry.to, back);
      touchedDirs.add(path.dirname(entry.to));
    } catch (err) {
      errors.push({ file: entry.to, message: err.message });
    }
    done++;
    onProgress(done, log.length);
  }
  // Clean up now-empty folders (deepest first, and their empty parents)
  const dirs = [...touchedDirs].sort((a, b) => b.length - a.length);
  for (const d of dirs) await removeEmptyUp(d, 3);
  return { errors };
}

async function removeEmptyUp(dir, levels) {
  for (let i = 0; i < levels; i++) {
    try {
      const items = await fsp.readdir(dir);
      if (items.length) return;
      await fsp.rmdir(dir);
      dir = path.dirname(dir);
    } catch { return; }
  }
}

module.exports = {
  CATEGORIES, getExt, categoryFor, familyKey, prettyName, safeFolderName,
  scanFolder, buildPlan, loadExistingFamilies, executeMoves, undoMoves, uniquePath,
  SKIP_EXTS,
};
