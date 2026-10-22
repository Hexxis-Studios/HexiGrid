// Development-only acceptance runner. This file is not included in the desktop shell.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { startDesktop } = require('../desktop/main.cjs');

(async () => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'hexigrid-desktop-visual-'));
  await fs.mkdir(path.join(output, 'profile'));
  const desktop = await startDesktop({ userData: path.join(output, 'profile'), port: 0, reuse: false,
    node: process.env.HEXIGRID_DESKTOP_TEST_NODE });
  const { window, engine } = desktop;
  await window.webContents.executeJavaScript(`new Promise(resolve => { const end = Date.now()+15000; const timer=setInterval(()=>{if(document.querySelector('h1') || Date.now()>end){clearInterval(timer);resolve();}},150); })`);
  await window.webContents.executeJavaScript(`document.querySelector('#bootLoader')?.click(); document.querySelector('.boot-loader')?.click();`);
  await window.webContents.executeJavaScript(`new Promise(resolve => { const end=Date.now()+15000; const timer=setInterval(()=>{ if(!document.body.classList.contains('booting') || Date.now()>end){clearInterval(timer);resolve();}},150); })`);
  await new Promise(resolve => setTimeout(resolve, 500));
  const inspected = await window.webContents.executeJavaScript(`({title:document.title,text:document.body.innerText.slice(0,1600),nodeAvailable:typeof window.require !== 'undefined',url:location.href})`);
  assert.match(inspected.title, /HexiGrid/);
  assert.equal(inspected.nodeAvailable, false);
  assert.ok(inspected.url.startsWith(engine.origin));
  await fs.writeFile(path.join(output, 'desktop.png'), (await window.webContents.capturePage()).toPNG());
  const created = await window.webContents.executeJavaScript(`fetch('/api/auth/setup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:'synthetic-desktop-only-acceptance'})}).then(r=>r.status)`);
  assert.equal(created, 200);
  await window.loadURL(`${engine.origin}/#agents`);
  await window.webContents.executeJavaScript(`document.querySelector('#bootLoader')?.click()`);
  await window.webContents.executeJavaScript(`new Promise(resolve=>{const end=Date.now()+15000;const t=setInterval(()=>{if(!document.body.classList.contains('booting')||Date.now()>end){clearInterval(t);resolve();}},150)})`);
  await fs.writeFile(path.join(output, 'agents.png'), (await window.webContents.capturePage()).toPNG());
  window.close();
  assert.equal(window.isDestroyed(), false, 'closing hides the app instead of terminating calls or the Door');
  assert.equal(window.isVisible(), false);
  assert.equal((await fetch(`${engine.origin}/api/system/identity`)).status, 200);
  window.show();
  assert.equal(window.isVisible(), true);
  const prefs = window.webContents.getLastWebPreferences();
  assert.equal(prefs.nodeIntegration, false);
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.sandbox, true);
  const result = { isolatedProfile: true, nativeWindowLoaded: true, rendererSandboxed: true, hiddenWindowPreservesEngine: true,
    screenshot: path.join(output, 'desktop.png'), origin: engine.origin };
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
  app.quit();
})().catch(error => { console.error(error.message); app.exit(1); });
