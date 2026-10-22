(() => {
  if (!document.documentElement.classList.contains('hexispace-live-embed')) return;

  function focusLive() {
    const view = document.querySelector('#view-live');
    const button = document.querySelector('[data-view="live"]');
    if (!view || !button) return false;
    if (!view.classList.contains('active-view')) button.click();
    return true;
  }

  document.addEventListener('hexigrid:rendered', focusLive);
  const content = document.querySelector('.main-content') || document.body;
  const observer = new MutationObserver(() => {
    if (focusLive()) observer.disconnect();
  });
  observer.observe(content, { childList: true, subtree: true });
  focusLive();
  setTimeout(() => observer.disconnect(), 15000);
})();
