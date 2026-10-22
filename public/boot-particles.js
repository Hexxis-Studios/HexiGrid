(() => {
  if (document.documentElement.classList.contains('hexispace-live-embed')) return;
  const { vertices, edges } = window.HexiGridBootGeometry;

  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const random = (low, high) => low + Math.random() * (high - low);

  function rotate([x, y, z], yaw, pitch) {
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const rx = x * cy - z * sy;
    const rz = x * sy + z * cy;
    return [rx, y * cp - rz * sp, y * sp + rz * cp];
  }

  function create(referenceCanvas) {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) return { resize() {}, update() {}, render() {}, destroy() {} };
    const particles = [];
    let width = 1;
    let height = 1;
    let ratio = 1;
    let background;

    function makeParticle() {
      return {
        x: random(0, width),
        y: random(0, height),
        vx: random(-5, 5),
        vy: random(-5, 5),
        size: random(7, 15),
        yaw: random(0, Math.PI * 2),
        pitch: random(-.7, .7),
        spin: random(-.7, .7),
        drift: random(0, Math.PI * 2),
        depth: random(.7, 1.2),
        bloom: 0,
        violet: Math.random() > .76
      };
    }

    function resize() {
      const bounds = referenceCanvas.getBoundingClientRect();
      width = Math.max(1, bounds.width);
      height = Math.max(1, bounds.height);
      ratio = Math.min(devicePixelRatio || 1, 1, 1152 / width, 648 / height);
      canvas.width = Math.max(1, Math.round(width * ratio));
      canvas.height = Math.max(1, Math.round(height * ratio));
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      background = context.createLinearGradient(0, 0, width, height);
      background.addColorStop(0, '#010713');
      background.addColorStop(.48, '#04182b');
      background.addColorStop(1, '#090b22');
      const desired = clamp(Math.round(width * height / 42000), 18, 38);
      while (particles.length < desired) particles.push(makeParticle());
      particles.length = desired;
    }

    function update(delta, pointer) {
      const influence = Math.min(width, height) * .19;
      const drag = Math.pow(.91, delta * 60);
      for (const particle of particles) {
        const dx = particle.x - pointer.x;
        const dy = particle.y - pointer.y;
        const distance = Math.hypot(dx, dy) || 1;
        if (pointer.strength > .01 && distance < influence) {
          const pressure = Math.pow(1 - distance / influence, 2) * pointer.strength;
          const tangentX = -dy / distance;
          const tangentY = dx / distance;
          particle.vx += ((dx / distance) * 96 + tangentX * 25) * pressure * delta;
          particle.vy += ((dy / distance) * 96 + tangentY * 25) * pressure * delta;
          particle.bloom = Math.max(particle.bloom, pressure);
        }
        particle.vx += Math.cos(particle.drift) * 1.1 * delta;
        particle.vy += Math.sin(particle.drift) * 1.1 * delta;
        particle.vx = clamp(particle.vx * drag, -48, 48);
        particle.vy = clamp(particle.vy * drag, -48, 48);
        particle.x += particle.vx * delta;
        particle.y += particle.vy * delta;
        particle.yaw += particle.spin * delta;
        particle.pitch += particle.spin * .27 * delta;
        particle.bloom *= Math.pow(.9, delta * 60);
        if (particle.x < -24) particle.x = width + 24;
        if (particle.x > width + 24) particle.x = -24;
        if (particle.y < -24) particle.y = height + 24;
        if (particle.y > height + 24) particle.y = -24;
      }
    }

    function drawParticle(particle) {
      const scale = particle.size * particle.depth * (1 + particle.bloom * .3);
      const projected = vertices.map(vertex => {
        const [x, y, z] = rotate(vertex, particle.yaw, particle.pitch);
        const perspective = 2.8 / (3.25 - z);
        return [particle.x + x * scale * perspective, particle.y + y * scale * perspective];
      });
      const tint = particle.violet ? '164,132,255' : '89,235,255';
      context.save();
      context.globalCompositeOperation = 'lighter';
      context.strokeStyle = `rgba(${tint},${.38 + particle.depth * .28})`;
      context.lineWidth = .65 + particle.depth * .32;
      context.shadowColor = `rgb(${tint})`;
      context.shadowBlur = 3 + particle.bloom * 10;
      context.beginPath();
      for (const [from, to] of edges) {
        context.moveTo(projected[from][0], projected[from][1]);
        context.lineTo(projected[to][0], projected[to][1]);
      }
      context.stroke();
      context.beginPath();
      context.arc(particle.x, particle.y, .7 + particle.bloom * 1.7, 0, Math.PI * 2);
      context.fillStyle = `rgba(${tint},${.35 + particle.bloom * .45})`;
      context.fill();
      context.restore();
    }

    function render() {
      context.globalCompositeOperation = 'source-over';
      context.globalAlpha = 1;
      context.fillStyle = background;
      context.fillRect(0, 0, width, height);
      for (const particle of particles) drawParticle(particle);
    }

    function destroy() {
      particles.length = 0;
      canvas.width = 1;
      canvas.height = 1;
    }

    return Object.freeze({ resize, update, render, destroy, surface: canvas });
  }

  window.HexiGridParticleField = Object.freeze({ create });
})();
