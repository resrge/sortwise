// Stamps the icon and version info onto the packaged SortWise.exe.
// electron-builder normally does this, but its tool for it needs symlink rights on Windows,
// so it's turned off in package.json (signAndEditExecutable: false) and done here instead.
//
// Usage: node scripts/set-exe-info.js [path\to\SortWise.exe]

const path = require('path');
const fs = require('fs');
const rcedit = require('rcedit');
const pkg = require('../package.json');

const root = path.join(__dirname, '..');
const exe = path.resolve(process.argv[2] || path.join(root, 'dist', 'win-unpacked', 'SortWise.exe'));
const icon = path.join(root, 'assets', 'icon.ico');

if (!fs.existsSync(exe)) { console.error('Not found: ' + exe); process.exit(1); }

const fileVersion = `${pkg.version}.0`;
const display = `${pkg.version} build ${pkg.buildStamp}`;

rcedit(exe, {
  icon,
  'file-version': fileVersion,
  'product-version': display,
  'version-string': {
    ProductName: pkg.productName,
    FileDescription: pkg.productName,
    CompanyName: 'resrge',
    LegalCopyright: `Copyright © ${new Date().getFullYear()} resrge`,
    OriginalFilename: 'SortWise.exe',
    InternalFilename: 'SortWise',
  },
}).then(() => {
  console.log(`Set icon and version (${display}) on ${exe}`);
}).catch(err => {
  console.error('rcedit failed: ' + err.message);
  process.exit(1);
});
