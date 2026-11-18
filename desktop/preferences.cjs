const fs = require('node:fs');
const path = require('node:path');

const defaults = { shortcut: '' };
function desktopPreferences(directory) {
  const file = path.join(directory, 'preferences.json');
  let settings = defaults;
  try { settings = { ...defaults, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch {}
  function write(patch) {
    const next = { ...settings, ...patch };
    fs.writeFileSync(file + '.pending', JSON.stringify(next), { mode: 0o600 });
    fs.renameSync(file + '.pending', file);
    settings = next;
    return settings;
  }
  return { get: () => settings, write };
}
module.exports = { desktopPreferences };
