const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function quoteDesktopArg(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\0\r\n]/.test(value)) throw new Error('Invalid application path.');
  return `"${value.replace(/%/g, '%%').replace(/[\\"`$]/g, '\\$&')}"`;
}

function autostartFile(appData) {
  return path.join(appData, 'autostart', 'hexigrid.desktop');
}

async function linuxAutostartEnabled(appData) {
  try { return (await fs.readFile(autostartFile(appData), 'utf8')).includes('X-HexiGrid-Autostart=true'); }
  catch { return false; }
}

async function setLinuxAutostart({ appData, executable, enabled }) {
  const file = autostartFile(appData);
  if (!enabled) {
    await fs.rm(file, { force: true });
    return;
  }
  const contents = `[Desktop Entry]\nType=Application\nName=HexiGrid\nExec=${quoteDesktopArg(executable)} --background\nTerminal=false\nX-GNOME-Autostart-enabled=true\nX-HexiGrid-Autostart=true\n`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, contents, { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

module.exports = { linuxAutostartEnabled, setLinuxAutostart };
