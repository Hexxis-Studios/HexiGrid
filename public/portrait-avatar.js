(function () {
  function mount(container, portrait, { preview = false, label = 'Animated agent portrait' } = {}) {
    if (!portrait || portrait.columns !== 6 || portrait.rows !== 3 || !Number.isInteger(portrait.width) || !Number.isInteger(portrait.height) || portrait.width < 48 || portrait.height < 48 || portrait.width > 640 || portrait.height > 640 || !/^\/api\/media\/portrait-[a-z0-9-]+$/.test(portrait.url || '')) return null;
    const canvas = document.createElement('canvas');
    canvas.width = portrait.width; canvas.height = portrait.height;
    canvas.className = 'hexi-portrait-avatar'; canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', label);
    const context = canvas.getContext('2d');
    if (!context) return null;
    const atlas = new Image(); let stopped = false, timer = 0, timerHost = window, level = 0, lastFrame = -1;
    const started = performance.now();
    const tick = () => {
      if (stopped) return;
      const elapsed = performance.now() - started;
      const audio = preview ? Math.max(0, Math.sin(elapsed / 150)) * 0.75 : window.HexiGridDesktopMedia?.speakerAmplitude?.() || 0;
      level += (audio - level) * (audio > level ? 0.7 : 0.35);
      const column = Math.min(5, Math.round(Math.max(0, level - 0.02) * 5));
      const phase = elapsed % 4200;
      const row = phase < 60 ? 1 : phase < 150 ? 2 : phase < 210 ? 1 : 0;
      const frame = row * 6 + column;
      if (frame !== lastFrame) {
        context.drawImage(atlas, column * portrait.width, row * portrait.height, portrait.width, portrait.height, 0, 0, canvas.width, canvas.height);
        lastFrame = frame; canvas.dataset.frame = String(frame);
      }
      // After adoption into the floating call window, schedule in its visible
      // document rather than in the background owner tab.
      timerHost = canvas.ownerDocument.defaultView || window;
      timer = timerHost.setTimeout(tick, 40);
    };
    atlas.onload = () => {
      if (stopped) return;
      if (atlas.naturalWidth !== portrait.width * 6 || atlas.naturalHeight !== portrait.height * 3) { stop(); return; }
      container.replaceChildren(canvas); tick();
    };
    atlas.onerror = () => stop();
    atlas.src = portrait.url;
    function stop() { stopped = true; timerHost.clearTimeout(timer); atlas.onload = null; atlas.onerror = null; }
    return { canvas, stop };
  }
  window.HexiGridPortraitAvatar = Object.freeze({ mount });
})();
