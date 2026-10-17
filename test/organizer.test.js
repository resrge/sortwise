// Run with: npm test  (plain Node, no Electron needed)
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const o = require('../src/organizer');

(async () => {
  // familyKey
  assert.strictEqual(o.familyKey('invoice_2024-03'), 'invoice');
  assert.strictEqual(o.familyKey('Invoice 2024-04 (1)'), 'invoice');
  assert.strictEqual(o.familyKey('invoice-final-v2'), 'invoice');
  assert.strictEqual(o.familyKey('AutoUnzip-Setup-0.7.0'), 'autounzip');
  assert.strictEqual(o.familyKey('Report Q3'), o.familyKey('report q3 (2)'));
  assert.strictEqual(o.familyKey('IMG_4412'), 'img');
  assert.strictEqual(o.prettyName('autounzip', ['AutoUnzip-Setup.exe']), 'AutoUnzip');
  assert.strictEqual(o.safeFolderName('con'), '_con');
  assert.strictEqual(o.getExt('backup.tar.gz'), 'tar.gz');

  // End to end in a temp folder
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sortwise-'));
  const names = ['invoice_01.pdf', 'invoice_02.pdf', 'photo.jpg', 'setup.exe', 'movie.part', 'notes.txt'];
  for (const n of names) fs.writeFileSync(path.join(dir, n), n);
  fs.mkdirSync(path.join(dir, 'Organized', 'Documents'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Organized', 'Documents', 'notes.txt'), 'existing'); // name clash

  const { files, skipped } = await o.scanFolder(dir);
  assert.strictEqual(files.length, 5);
  assert.strictEqual(skipped.length, 1);

  const dest = path.join(dir, 'Organized');
  const plan = o.buildPlan(files, { mode: 'category', groupSimilar: true, destDir: dest });
  const inv = plan.find(g => g.label === 'Invoice');
  assert.ok(inv && inv.files.length === 2 && inv.folder === path.join('Documents', 'Invoice'));

  const moves = plan.flatMap(g => g.files.map(f => ({ from: f.path, toDir: g.target })));
  const { log, errors } = await o.executeMoves(moves);
  assert.strictEqual(errors.length, 0);
  assert.ok(fs.existsSync(path.join(dest, 'Documents', 'notes (2).txt')), 'clash renamed');
  assert.ok(fs.existsSync(path.join(dest, 'Documents', 'Invoice', 'invoice_01.pdf')));

  await o.undoMoves(log);
  for (const n of names) assert.ok(fs.existsSync(path.join(dir, n)), 'restored ' + n);
  assert.ok(!fs.existsSync(path.join(dest, 'Documents', 'Invoice')), 'empty folder cleaned');
  assert.ok(fs.existsSync(path.join(dest, 'Documents', 'notes.txt')), 'pre-existing file untouched');

  fs.rmSync(dir, { recursive: true, force: true });

  // A single new file joins a name folder made by an earlier run
  {
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'sortwise-ex-'));
    const dest2 = path.join(d2, 'Organized');
    fs.mkdirSync(path.join(dest2, 'Documents', 'Invoice'), { recursive: true });
    fs.mkdirSync(path.join(dest2, 'Installers', 'AutoUnzip'), { recursive: true });
    fs.writeFileSync(path.join(d2, 'invoice_05.pdf'), 'x');
    fs.writeFileSync(path.join(d2, 'AutoUnzip-Setup-0.8.0.exe'), 'x');
    fs.writeFileSync(path.join(d2, 'lonely.pdf'), 'x');
    const { files: f2 } = await o.scanFolder(d2);
    const existing = await o.loadExistingFamilies(dest2);
    const p2 = o.buildPlan(f2, { mode: 'category', groupSimilar: true, minGroup: 2, destDir: dest2, existing });
    const where = n => p2.find(g => g.files.some(f => f.name === n)).folder;
    assert.strictEqual(where('invoice_05.pdf'), path.join('Documents', 'Invoice'));
    assert.strictEqual(where('AutoUnzip-Setup-0.8.0.exe'), path.join('Installers', 'AutoUnzip'));
    assert.strictEqual(where('lonely.pdf'), 'Documents');
    fs.rmSync(d2, { recursive: true, force: true });
  }

  // Version comparison used by the updater
  const { isNewer } = require('../src/version');
  assert.ok(isNewer({ version: '0.2.0' }, { version: '0.1.9', build: '20991231' }));
  assert.ok(isNewer({ version: '0.2.0', build: '20261102' }, { version: '0.2.0', build: '20261017' }));
  assert.ok(!isNewer({ version: '0.2.0', build: '20261017' }, { version: '0.2.0', build: '20261017' }));
  assert.ok(!isNewer({ version: 'v0.1.10' }, { version: '0.2.0' }));
  assert.ok(isNewer({ version: 'v0.10.0' }, { version: '0.9.5' }));

  // Watcher reports only new files, once they've finished writing, and skips .part files
  {
    const { FolderWatcher } = require('../src/watcher');
    const d3 = fs.mkdtempSync(path.join(os.tmpdir(), 'sortwise-w-'));
    fs.writeFileSync(path.join(d3, 'already-here.txt'), 'x');
    const w = new FolderWatcher();
    const seen = [];
    w.on('new-files', p => seen.push(...p.map(x => path.basename(x))));
    await w.start(d3);
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    fs.writeFileSync(path.join(d3, 'fresh.zip'), 'x');
    fs.writeFileSync(path.join(d3, 'big.iso.crdownload'), 'x');
    const growing = path.join(d3, 'growing.mp4');
    fs.writeFileSync(growing, 'x');
    await sleep(1500);
    assert.deepStrictEqual(seen, [], 'nothing reported before files settle');
    // keep "downloading" growing.mp4 for ~5s
    for (let i = 0; i < 5; i++) { fs.appendFileSync(growing, 'more'); await sleep(1000); }
    assert.deepStrictEqual(seen, ['fresh.zip'], 'finished file reported, growing one held back');
    await sleep(4500);
    w.stop();
    assert.deepStrictEqual(seen, ['fresh.zip', 'growing.mp4'], 'growing file reported once it stopped changing');
    fs.rmSync(d3, { recursive: true, force: true });
  }

  console.log('All organizer tests passed');
})().catch(e => { console.error(e); process.exit(1); });
