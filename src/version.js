// Version helpers shared by the updater and tests.

function parseVersion(v) {
  return String(v || '0').replace(/^v/i, '').split(/[.-]/).slice(0, 3).map(n => parseInt(n, 10) || 0);
}

// Newer if the version is higher, or the same version with a later build stamp.
function isNewer(remote, current) {
  const a = parseVersion(remote.version), b = parseVersion(current.version);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return String(remote.build || '') > String(current.build || '');
}

module.exports = { parseVersion, isNewer };
