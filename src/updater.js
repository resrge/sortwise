// SortWise updater: checks the resrge GitHub releases first, then the resrge.com mirror,
// downloads the new Inno Setup installer in the background, and installs it when the
// user clicks "Restart to update".
//
// GitHub release:  tag "v0.2.0", asset "SortWise-Setup-0.2.0-build20261101.exe"
//                  (+ optional "latest.json" asset with the sha256)
// Mirror JSON:     { "version": "0.2.0", "build": "20261101", "url": "https://…/SortWise-Setup-….exe",
//                    "sha256": "…", "notes": "…" }

const { app, net } = require('electron');
const { EventEmitter } = require('events');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { isNewer } = require('./version');

const UA = { 'User-Agent': 'SortWise-Updater', 'Cache-Control': 'no-cache' };
const SETUP_RE = /^SortWise-Setup-.*\.exe$/i;

class Updater extends EventEmitter {
  constructor({ owner, repo, mirror, version, build }) {
    super();
    this.cfg = { owner, repo, mirror };
    this.current = { version, build };
    this.state = { status: 'idle', current: this.current };
    this.lastProgressEmit = 0;
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.state);
  }

  async check() {
    if (['checking', 'downloading', 'ready'].includes(this.state.status)) return this.state;
    this.setState({ status: 'checking', error: null });

    const errors = [];
    let info = null;
    for (const source of [() => this.fromGitHub(), () => this.fromMirror()]) {
      try { info = await source(); if (info) break; } catch (err) { errors.push(err.message); }
    }
    const checkedAt = new Date().toISOString();
    if (!info) {
      this.setState({ status: 'error', error: errors.join(' · ') || 'No update info found', checkedAt });
      return this.state;
    }
    if (!isNewer(info, this.current)) {
      this.setState({ status: 'none', latest: info, checkedAt });
      return this.state;
    }
    this.setState({ status: 'available', update: info, checkedAt });
    if (app.isPackaged) await this.download(info);
    return this.state;
  }

  async getJSON(url) {
    const res = await net.fetch(url, { headers: { ...UA, Accept: 'application/json' }, cache: 'no-store' });
    if (!res.ok) throw new Error(`${new URL(url).hostname} answered ${res.status}`);
    return res.json();
  }

  async fromGitHub() {
    const { owner, repo } = this.cfg;
    if (!owner || !repo) return null;
    const rel = await this.getJSON(`https://api.github.com/repos/${owner}/${repo}/releases/latest`);
    // A release re-published with a newer build can hold several setups; take the newest build
    const buildOf = a => (a.name.match(/build(\d{8})/i) || [])[1] || '';
    const asset = (rel.assets || []).filter(a => SETUP_RE.test(a.name))
      .sort((a, b) => buildOf(b).localeCompare(buildOf(a)))[0];
    if (!asset) throw new Error('GitHub release has no SortWise-Setup .exe');

    let sha256 = typeof asset.digest === 'string' && asset.digest.startsWith('sha256:') ? asset.digest.slice(7) : null;
    let build = buildOf(asset);
    const manifest = (rel.assets || []).find(a => a.name === 'latest.json');
    if (manifest && (!sha256 || !build)) {
      try {
        const m = await this.getJSON(manifest.browser_download_url);
        build = build || m.build || '';
        if (!sha256 && String(m.build) === build) sha256 = m.sha256 || null;
      } catch { /* optional */ }
    }
    return {
      version: String(rel.tag_name || '').replace(/^v/i, ''),
      build, sha256,
      url: asset.browser_download_url,
      name: asset.name,
      notes: rel.body || '',
      source: 'GitHub',
    };
  }

  async fromMirror() {
    if (!this.cfg.mirror) return null;
    const m = await this.getJSON(this.cfg.mirror);
    if (!m.version || !m.url) throw new Error('Mirror latest.json is missing version or url');
    return {
      version: String(m.version).replace(/^v/i, ''),
      build: m.build || '',
      sha256: m.sha256 || null,
      url: m.url,
      name: path.basename(new URL(m.url).pathname),
      notes: m.notes || '',
      source: 'resrge.com',
    };
  }

  async download(info) {
    const dir = path.join(app.getPath('temp'), 'SortWise-Update');
    await fsp.mkdir(dir, { recursive: true });
    const dest = path.join(dir, info.name);
    this.setState({ status: 'downloading', progress: 0 });

    // Try the source we found it on, then the mirror's copy of the same version
    const urls = [info.url];
    if (info.source === 'GitHub') {
      try {
        const m = await this.fromMirror();
        if (m && m.version === info.version && m.url !== info.url) urls.push(m.url);
      } catch { /* mirror optional */ }
    }

    let lastErr;
    for (const url of urls) {
      try {
        const hash = await this.fetchTo(url, dest);
        if (info.sha256 && hash !== info.sha256.toLowerCase()) {
          await fsp.rm(dest, { force: true });
          throw new Error('Checksum did not match');
        }
        this.setState({ status: 'ready', progress: 1, file: dest });
        return;
      } catch (err) { lastErr = err; }
    }
    this.setState({ status: 'error', error: 'Download failed: ' + (lastErr?.message || 'unknown') });
  }

  async fetchTo(url, dest) {
    const res = await net.fetch(url, { headers: UA });
    if (!res.ok || !res.body) throw new Error(`${new URL(url).hostname} answered ${res.status}`);
    const total = Number(res.headers.get('content-length')) || 0;
    const tmp = dest + '.part';
    const out = fs.createWriteStream(tmp);
    const hash = crypto.createHash('sha256');
    const reader = res.body.getReader();
    let got = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const buf = Buffer.from(value);
        got += buf.length;
        hash.update(buf);
        if (!out.write(buf)) await new Promise(r => out.once('drain', r));
        const now = Date.now();
        if (total && now - this.lastProgressEmit > 250) {
          this.lastProgressEmit = now;
          this.setState({ progress: got / total });
        }
      }
      await new Promise((resolve, reject) => out.end(err => (err ? reject(err) : resolve())));
    } catch (err) {
      out.destroy();
      await fsp.rm(tmp, { force: true });
      throw err;
    }
    await fsp.rm(dest, { force: true });
    await fsp.rename(tmp, dest);
    return hash.digest('hex');
  }

  // Runs the installer silently (Windows asks for admin), then the app quits.
  // The installer relaunches SortWise when it finishes (/RELAUNCH, see SortWise.iss).
  // If the admin prompt is cancelled, SortWise is simply started again.
  installAndRestart() {
    if (this.state.status !== 'ready' || !this.state.file) return false;
    const q = s => `'${String(s).replace(/'/g, "''")}'`;
    const script =
      `try { Start-Process -FilePath ${q(this.state.file)} ` +
      `-ArgumentList '/SILENT','/SUPPRESSMSGBOXES','/NORESTART','/RELAUNCH' -ErrorAction Stop } ` +
      `catch { Start-Process -FilePath ${q(process.execPath)} }`;
    spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], {
      detached: true, stdio: 'ignore', windowsHide: true,
    }).unref();
    return true;
  }
}

module.exports = { Updater, isNewer };
