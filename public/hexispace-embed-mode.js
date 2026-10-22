(() => {
  const params = new URLSearchParams(location.search);
  if (params.get('embedded') === '1' && params.get('view') === 'live') {
    document.documentElement.classList.add('hexispace-live-embed');
  }
})();
