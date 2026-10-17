// Watches one folder for new top-level files and reports them once they've
// finished writing. Pure Node, no Electron imports.
//
//   const w = new FolderWatcher();
//   w.on('new-files', paths => ...);
//   w.start('C:\\Users\\me\\Downloads');

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { EventEmitter } = require('events');
const organizer = require('./organizer');

const DEBOUNCE_MS = 1200;    // group bursts of fs events
const SETTLE_MS = 2000;      // a file must be unchanged this long to count as finished
const POLL_MS = 30000;       // backup poll (fs.watch can miss events on some drives)
const GIVE_UP_MS = 30 * 60 * 1000; // stop waiting on a file that never settles

class FolderWatcher extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.dir = null;
    this.includeHidden = !!opts.includeHidden;
    this.known = new Set();        // files already present (or already reported)
    this.pending = new Map();      // path -> { size, mtime, since, firstSeen }
    this.fsWatcher = null;
    this.debounce = null;
    this.settleTimer = null;
    this.pollTimer = null;
    this.scanning = false;
  }

  get active() { return !!this.dir; }

  async start(dir, opts = {}) {
    if (this.dir === dir && this.includeHidden === !!opts.includeHidden && this.fsWatcher) return;
    this.stop();
    this.dir = dir;
    this.includeHidden = !!opts.includeHidden;

    // Everything already in the folder is "known"; only new arrivals get reported.
    const { files } = await organizer.scanFolder(dir, { includeHidden: this.includeHidden });
    this.known = new Set(files.map(f => f.path));

    try {
      this.fsWatcher = fs.watch(dir, { persistent: true }, () => this.schedule());
      this.fsWatcher.on('error', err => this.emit('error', err));
    } catch (err) {
      this.emit('error', err);
    }
    this.pollTimer = setInterval(() => this.schedule(), POLL_MS);
    this.emit('started', dir);
  }

  stop() {
    if (this.fsWatcher) { try { this.fsWatcher.close(); } catch { /* already closed */ } }
    clearTimeout(this.debounce);
    clearTimeout(this.settleTimer);
    clearInterval(this.pollTimer);
    this.fsWatcher = null;
    this.pending.clear();
    const was = this.dir;
    this.dir = null;
    if (was) this.emit('stopped', was);
  }

  // Files the app moved itself shouldn't count as "known" any more,
  // and files the user moved back in should count as new again.
  forget(paths) { for (const p of paths) this.known.delete(p); }

  schedule() {
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.scan(), DEBOUNCE_MS);
  }

  async scan() {
    if (!this.dir || this.scanning) return;
    this.scanning = true;
    try {
      const { files } = await organizer.scanFolder(this.dir, { includeHidden: this.includeHidden });
      const present = new Set(files.map(f => f.path));

      // Drop files that disappeared (moved, deleted, renamed)
      for (const p of [...this.known]) if (!present.has(p)) this.known.delete(p);
      for (const p of [...this.pending.keys()]) if (!present.has(p)) this.pending.delete(p);

      const now = Date.now();
      for (const f of files) {
        if (this.known.has(f.path)) continue;
        const prev = this.pending.get(f.path);
        if (!prev || prev.size !== f.size || prev.mtime !== f.mtime) {
          this.pending.set(f.path, { size: f.size, mtime: f.mtime, since: now, firstSeen: prev?.firstSeen ?? now });
        }
      }
      await this.checkSettled();
    } catch (err) {
      this.emit('error', err);
    } finally {
      this.scanning = false;
    }
  }

  async checkSettled() {
    const now = Date.now();
    const ready = [];
    for (const [p, info] of this.pending) {
      if (now - info.firstSeen > GIVE_UP_MS) { this.pending.delete(p); this.known.add(p); continue; }
      if (now - info.since < SETTLE_MS) continue;
      const lock = await lockState(p);
      if (lock === 'gone') { this.pending.delete(p); continue; }
      // 'denied' is usually a read-only file; accept it once it's been still a while
      if (lock === 'free' || (lock === 'denied' && now - info.since > 15000)) ready.push(p);
      else if (lock === 'busy') info.since = now; // still being written by something
    }
    for (const p of ready) { this.pending.delete(p); this.known.add(p); }
    if (ready.length) this.emit('new-files', ready);

    clearTimeout(this.settleTimer);
    if (this.pending.size) this.settleTimer = setTimeout(() => this.scan(), SETTLE_MS);
  }
}

// On Windows a file still open for writing by another program can't be opened read+write.
async function lockState(p) {
  try {
    const fh = await fsp.open(p, 'r+');
    await fh.close();
    return 'free';
  } catch (err) {
    if (err.code === 'ENOENT') return 'gone';
    if (err.code === 'EBUSY') return 'busy';
    if (err.code === 'EPERM' || err.code === 'EACCES') return 'denied';
    return 'free';
  }
}

module.exports = { FolderWatcher };
