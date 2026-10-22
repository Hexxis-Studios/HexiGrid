(() => {
  if (document.documentElement.classList.contains('hexispace-live-embed')) return;
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const REVEAL_SCALE = 2.5;
  const DIRTY_PADDING = 52;

  function create(canvas, sourceProvider) {
    const context = canvas.getContext('2d', { alpha: true });
    if (!context) return { resize() {}, render() {}, destroy() {} };
    const baseCanvas = document.createElement('canvas');
    const baseContext = baseCanvas.getContext('2d', { alpha: true });
    if (!baseContext) return { resize() {}, render() {}, destroy() {} };
    let width = 1;
    let height = 1;
    let ratio = 1;
    let previousBounds = null;

    function resize() {
      const bounds = canvas.getBoundingClientRect();
      width = Math.max(1, bounds.width);
      height = Math.max(1, bounds.height);
      ratio = Math.min(devicePixelRatio || 1, 1, 1152 / width, 648 / height);
      canvas.width = Math.max(1, Math.round(width * ratio));
      canvas.height = Math.max(1, Math.round(height * ratio));
      baseCanvas.width = canvas.width;
      baseCanvas.height = canvas.height;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      baseContext.setTransform(ratio, 0, 0, ratio, 0, 0);
      const surface = baseContext.createLinearGradient(0, 0, width, height);
      surface.addColorStop(0, '#41d3ec');
      surface.addColorStop(.46, '#79e6f1');
      surface.addColorStop(1, '#23a7d1');
      const glow = baseContext.createRadialGradient(width * .5, height * .4, 0, width * .5, height * .4, Math.max(width, height) * .72);
      glow.addColorStop(0, 'rgba(226,253,255,.28)');
      glow.addColorStop(.45, 'rgba(103,227,244,.08)');
      glow.addColorStop(1, 'rgba(4,55,94,.18)');
      baseContext.clearRect(0, 0, width, height);
      baseContext.fillStyle = surface;
      baseContext.fillRect(0, 0, width, height);
      baseContext.fillStyle = glow;
      baseContext.fillRect(0, 0, width, height);
      previousBounds = null;
      paint({ x: 0, y: 0, width, height });
    }

    function paint(rect) {
      if (!rect) return;
      const x = Math.max(0, Math.floor(rect.x * ratio) - 2);
      const y = Math.max(0, Math.floor(rect.y * ratio) - 2);
      const right = Math.min(canvas.width, Math.ceil((rect.x + rect.width) * ratio) + 2);
      const bottom = Math.min(canvas.height, Math.ceil((rect.y + rect.height) * ratio) + 2);
      const regionWidth = Math.max(0, right - x);
      const regionHeight = Math.max(0, bottom - y);
      if (!regionWidth || !regionHeight) return;
      context.save();
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(x, y, regionWidth, regionHeight);
      context.globalCompositeOperation = 'source-over';
      context.drawImage(baseCanvas, x, y, regionWidth, regionHeight, x, y, regionWidth, regionHeight);
      context.restore();
    }

    function boundsFor(points) {
      if (!points.length) return null;
      let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
      for (const point of points) {
        left = Math.min(left, point.x);
        top = Math.min(top, point.y);
        right = Math.max(right, point.x);
        bottom = Math.max(bottom, point.y);
      }
      const padding = DIRTY_PADDING;
      return {
        x: clamp(left - padding, 0, width),
        y: clamp(top - padding, 0, height),
        width: clamp(right - left + padding * 2, 0, width),
        height: clamp(bottom - top + padding * 2, 0, height)
      };
    }

    function union(first, second) {
      if (!first) return second;
      if (!second) return first;
      const x = Math.min(first.x, second.x);
      const y = Math.min(first.y, second.y);
      const right = Math.max(first.x + first.width, second.x + second.width);
      const bottom = Math.max(first.y + first.height, second.y + second.height);
      return { x, y, width: right - x, height: bottom - y };
    }

    function segmentPath(from, to, offset) {
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const length = Math.hypot(dx, dy) || 1;
      const offsetX = -dy / length * offset;
      const offsetY = dx / length * offset;
      context.beginPath();
      context.moveTo(from.x + offsetX, from.y + offsetY);
      context.lineTo(to.x + offsetX, to.y + offsetY);
    }

    function cut(points) {
      if (!points.length) return;
      context.save();
      context.globalCompositeOperation = 'destination-out';
      context.lineCap = 'round';
      context.lineJoin = 'round';
      for (let index = 0; index < points.length; index += 1) {
        const from = points[Math.max(0, index - 1)];
        const to = points[index];
        const life = Math.pow((from.life + to.life) / 2, .72);
        const energy = (from.energy + to.energy) / 2;
        const halfWidth = (5.5 + energy * 2.2) * REVEAL_SCALE * life;
        context.globalAlpha = clamp(life * 1.18, .06, .94);
        context.lineWidth = halfWidth * 2;
        segmentPath(from, to.x === from.x && to.y === from.y ? { x: to.x + .01, y: to.y + .01 } : to, 0);
        context.stroke();
      }
      context.restore();

      context.save();
      context.globalCompositeOperation = 'source-over';
      context.lineCap = 'round';
      context.lineJoin = 'round';
      context.lineWidth = .9;
      context.shadowColor = '#d5fbff';
      context.shadowBlur = 3;
      for (let index = 1; index < points.length; index += 1) {
        const from = points[index - 1];
        const to = points[index];
        const life = Math.pow((from.life + to.life) / 2, .72);
        const energy = (from.energy + to.energy) / 2;
        const halfWidth = (5.5 + energy * 2.2) * REVEAL_SCALE * life;
        context.strokeStyle = `rgba(225,254,255,${.1 + life * .36})`;
        segmentPath(from, to, halfWidth);
        context.stroke();
        segmentPath(from, to, -halfWidth);
        context.stroke();
      }
      context.restore();
    }

    function revealSource(rect) {
      if (!rect) return;
      const source = sourceProvider?.();
      if (!source) return;
      const x = Math.max(0, Math.floor(rect.x * ratio));
      const y = Math.max(0, Math.floor(rect.y * ratio));
      const right = Math.min(source.width, Math.ceil((rect.x + rect.width) * ratio));
      const bottom = Math.min(source.height, Math.ceil((rect.y + rect.height) * ratio));
      const regionWidth = Math.max(0, right - x);
      const regionHeight = Math.max(0, bottom - y);
      if (!regionWidth || !regionHeight) return;
      context.save();
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.globalCompositeOperation = 'destination-over';
      context.drawImage(source, x, y, regionWidth, regionHeight, x, y, regionWidth, regionHeight);
      context.restore();
    }

    function render(points) {
      if (!points.length) {
        paint({ x: 0, y: 0, width, height });
        previousBounds = null;
        return;
      }
      const currentBounds = boundsFor(points);
      paint(union(previousBounds, currentBounds));
      cut(points);
      revealSource(currentBounds);
      previousBounds = currentBounds;
    }

    function destroy() {
      canvas.width = 1;
      canvas.height = 1;
      baseCanvas.width = 1;
      baseCanvas.height = 1;
      previousBounds = null;
    }

    return Object.freeze({ resize, render, destroy });
  }

  window.HexiGridRevealVeil = Object.freeze({ create });
})();
