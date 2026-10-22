(() => {
  let loader = null, vrmLoader = null;
  const escapeHtml = (value) => String(value || '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
  function ensureLoaded() {
    // Configure before the first custom element upgrades. Compressed models
    // must use the shipped decoders, including when this PC is offline.
    window.ModelViewerElement = window.ModelViewerElement || {};
    window.ModelViewerElement.dracoDecoderLocation = '/vendor/draco/';
    window.ModelViewerElement.ktx2TranscoderLocation = '/vendor/basis/';
    if (!loader) loader = import('/vendor/model-viewer.js').catch((error) => { loader = null; throw error; });
    return loader;
  }
  function ensureVrmLoaded() {
    if (!vrmLoader) vrmLoader = import('/vendor/vrm-viewer.js').catch((error) => { vrmLoader = null; throw error; });
    return vrmLoader;
  }
  function element(source, label, className = '', format = 'glb') {
    if (!source) return '';
    if (format === 'vrm') {
      ensureVrmLoaded().catch(() => {
        for (const viewer of document.querySelectorAll('hexi-vrm-viewer[data-load-state="loading"]')) {
          viewer.dataset.loadState = 'failed';
          viewer.textContent = 'The VRM renderer could not start. Refresh HexiGrid, then reopen this avatar.';
        }
      });
      return `<hexi-vrm-viewer class="${escapeHtml(className)}" data-load-state="loading" src="${escapeHtml(source)}" alt="${escapeHtml(label || 'Agent VRM avatar')}" autoplay></hexi-vrm-viewer>`;
    }
    ensureLoaded().catch(() => {});
    return `<model-viewer class="${escapeHtml(className)}" src="${escapeHtml(source)}" alt="${escapeHtml(label || 'Agent 3D avatar')}" camera-controls autoplay interaction-prompt="none" loading="eager"></model-viewer>`;
  }
  window.HexiGridAvatarViewer = Object.freeze({ ensureLoaded, ensureVrmLoaded, element });
})();
