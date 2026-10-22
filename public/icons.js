(() => {
  const NS = 'http://www.w3.org/2000/svg';
  const paths = {
    menu: ['M5 7h14M5 12h14M5 17h14'],
    sidebar: ['M4 4h16v16H4z', 'M10 4v16', 'm15 9-3 3 3 3'],
    help: ['M9.4 9a3 3 0 1 1 4.8 2.4c-1.2.8-2.2 1.4-2.2 3.1', 'M12 18h.01'],
    home: ['M4 11.5 12 5l8 6.5', 'M6.5 10.5V19h11v-8.5', 'M10 19v-5h4v5'],
    agents: ['M15 8a3 3 0 1 1-6 0a3 3 0 0 1 6 0Z', 'M3.8 19c.4-3.1 2.2-5 5.2-5s4.8 1.9 5.2 5', 'M16 8.5a2.4 2.4 0 0 1 0 4.8', 'M16 15c2.5.1 4 1.5 4.3 4'],
    chat: ['M5 5.5h14v10H9l-4 3v-13Z', 'M8 9h8M8 12h5'],
    activity: ['M3 12h4l2-5 4 10 2-5h6'],
    usage: ['M5 19V9M10 19V5M15 19v-7M20 19V8'],
    models: ['M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3Z', 'm4 7.5 8 4.5 8-4.5M12 12v9'],
    link: ['M9.5 14.5 8 16a3 3 0 0 1-4.2-4.2l3-3A3 3 0 0 1 11 8.7', 'm14.5 9.5 1.5-1.5a3 3 0 1 1 4.2 4.2l-3 3a3 3 0 0 1-4.2.1', 'm8.5 15.5 7-7'],
    workspace: ['M3.5 6h6l1.5 2h9.5v11h-17V6Z', 'M7 12h10M7 15h7'],
    assistant: ['M12 3l1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5L12 3Z', 'M18 16l.7 2.3L21 19l-2.3.7L18 22l-.7-2.3L15 19l2.3-.7L18 16Z'],
    speech: ['M4 5h16v11H9l-5 4V5Z', 'M8 9h8M8 12h6'],
    shield: ['M12 3l7 3v5c0 4.6-2.8 8-7 10-4.2-2-7-5.4-7-10V6l7-3Z', 'm9 12 2 2 4-5'],
    account: ['M5 4h14v16H5z', 'M9 8h6M9 12h6M9 16h4'],
    guide: ['M4 5.5A3.5 3.5 0 0 1 7.5 4H12v15H7.5A3.5 3.5 0 0 0 4 20V5.5Z', 'M20 5.5A3.5 3.5 0 0 0 16.5 4H12v15h4.5A3.5 3.5 0 0 1 20 20V5.5Z'],
    settings: ['M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z', 'M19 13.5l1.2 1-.9 2.2-1.6-.1-1.2 1.2.1 1.6-2.2.9-1-1.2h-1.8l-1 1.2-2.2-.9.1-1.6-1.2-1.2-1.6.1-.9-2.2 1.2-1v-1.8l-1.2-1 .9-2.2 1.6.1 1.2-1.2-.1-1.6 2.2-.9 1 1.2h1.8l1-1.2 2.2.9-.1 1.6 1.2 1.2 1.6-.1.9 2.2-1.2 1v1.8Z'],
    tasks: ['M7 4h10v3H7z', 'M5 6h14v15H5z', 'm8 12 2 2 5-5'],
    plugin: ['M9 4v4H5v5h4v4h5v-4h5V8h-5V4H9Z'],
    tools: ['M14.5 6.5a4 4 0 0 0-5 5L4 17l3 3 5.5-5.5a4 4 0 0 0 5-5l-3 3-3-3 3-3Z'],
    lock: ['M6 10h12v10H6z', 'M8.5 10V7.5a3.5 3.5 0 0 1 7 0V10', 'M12 14v2.5'],
    refresh: ['M19 8V4l-2 2a7 7 0 1 0 1.3 8', 'M19 4h-4'],
    key: ['M14 8a4 4 0 1 1-7.3 2.3L3 14v3h3v3h3l4.7-4.7A4 4 0 0 1 14 8Z'],
    server: ['M4 5h16v5H4zM4 14h16v5H4z', 'M7 7.5h.01M7 16.5h.01M10 7.5h.01M10 16.5h.01'],
    terminal: ['m5 7 4 5-4 5M11 17h8'],
    phone: ['M8 3h8v18H8z', 'M11 18h2'],
    device: ['M5 4h14v16H5z', 'M8 7h8M8 10h5M8 16h8'],
    cloud: ['M7 18h11a4 4 0 0 0 .4-8A6 6 0 0 0 7 8.5 4.8 4.8 0 0 0 7 18Z', 'm12 10 0 6m-2-2 2 2 2-2'],
    plus: ['M12 5v14M5 12h14'],
    copy: ['M8 8h11v12H8z', 'M5 16H4V4h11v1'],
    stop: ['M7 7h10v10H7z'],
    search: ['M10.5 5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11Z', 'm15 15 4 4'],
    converse: ['M5 6h14v10H9l-4 3V6Z'],
    plan: ['M6 4h12v16H6z', 'M9 9h6M9 13h6M9 17h4'],
    goal: ['M12 4a8 8 0 1 0 8 8', 'M12 8a4 4 0 1 0 4 4', 'M12 12l8-8M16 4h4v4'],
    sketch: ['m5 17 1-4L15 4l5 5-9 9-4 1-2-2Z', 'm13 6 5 5'],
    research: ['M10.5 5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11Z', 'm15 15 4 4', 'M8 10.5h5M10.5 8v5'],
    build: ['m4 17 7-12 3 6 6 2-7 6-9-2Z'],
    watch: ['M4 12s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5Z', 'M12 9v3l2 2'],
    file: ['M6 3h8l4 4v14H6z', 'M14 3v5h4'],
    folder: ['M3.5 6h6l2 2h9v11h-17z']
  };

  function make(name, label = '') {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'hex-icon');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.7');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    if (label) { svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', label); }
    else svg.setAttribute('aria-hidden', 'true');
    for (const d of paths[name] || paths.help) {
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', d);
      svg.append(path);
    }
    return svg;
  }

  function refresh(root = document) {
    root.querySelectorAll('[data-icon]:not([data-icon-ready])').forEach((node) => {
      node.replaceChildren(make(node.dataset.icon, node.dataset.iconLabel || ''));
      node.dataset.iconReady = 'true';
    });
  }

  window.HexiIcons = { make, refresh };
  document.addEventListener('DOMContentLoaded', () => {
    refresh();
    new MutationObserver((records) => records.forEach((record) => record.addedNodes.forEach((node) => {
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (node.matches?.('[data-icon]')) refresh(node.parentElement || document);
      else refresh(node);
    }))).observe(document.body, { childList: true, subtree: true });
  });
})();
