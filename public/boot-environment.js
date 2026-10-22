(() => {
  if (document.documentElement.classList.contains('hexispace-live-embed')) return;
  const particleCanvas = document.querySelector('#bootEnvironment');
  const particleFactory = window.HexiGridParticleField;
  const veilFactory = window.HexiGridRevealVeil;

  if (!particleCanvas || !particleFactory || !veilFactory) return;

  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const coarsePointer = matchMedia('(pointer: coarse)').matches;
  const field = particleFactory.create(particleCanvas);
  const veil = veilFactory.create(particleCanvas, () => field.surface);
  const trail = [];
  let frame = 0;
  let lastFrame = performance.now();
  let nextFrame = 0;
  let motionAt = 0;
  let pointerX = innerWidth / 2;
  let pointerY = innerHeight / 2;
  let pointerForce = 0;
  let lastPointerAt = 0;
  let lastPointerX = pointerX;
  let lastPointerY = pointerY;
  let destroyed = false;
  const frameInterval = 1000 / (coarsePointer ? 24 : 30);

  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

  function trimTrail() {
    const maxLength = coarsePointer ? 110 : 150;
    let distance = 0;
    for (let index = trail.length - 1; index > 0; index -= 1) {
      const current = trail[index];
      const previous = trail[index - 1];
      const segment = Math.hypot(current.x - previous.x, current.y - previous.y);
      if (distance + segment > maxLength) {
        trail.splice(0, index);
        return;
      }
      distance += segment;
    }
  }

  function addTrailPoint(x, y, speed) {
    const previous = trail[trail.length - 1];
    if (previous && Math.hypot(previous.x - x, previous.y - y) < 2) {
      previous.life = 1;
      previous.energy = Math.max(previous.energy, speed);
      return;
    }
    trail.push({ x, y, life: 1, energy: speed });
    if (trail.length > 72) trail.shift();
    trimTrail();
  }

  function wake() {
    if (!destroyed && !frame && !document.hidden) frame = requestAnimationFrame(draw);
  }

  function move(event) {
    if (reduced) return;
    const now = performance.now();
    const elapsed = Math.max(8, now - lastPointerAt);
    const distance = Math.hypot(event.clientX - lastPointerX, event.clientY - lastPointerY);
    const speed = clamp(distance / elapsed / 1.2, .35, 1);
    pointerX = event.clientX;
    pointerY = event.clientY;
    lastPointerX = pointerX;
    lastPointerY = pointerY;
    lastPointerAt = now;
    motionAt = now;
    addTrailPoint(pointerX, pointerY, speed);
    wake();
  }

  function release() {
    motionAt = 0;
    wake();
  }

  function ageTrail(delta) {
    const newest = Math.max(1, trail.length - 1);
    const moving = motionAt > 0 && performance.now() - motionAt < 110;
    for (let index = 0; index < trail.length; index += 1) {
      const tailBias = 1 - index / newest;
      const healingRate = (moving ? .55 : .8) + tailBias * 1.25;
      trail[index].life = Math.max(0, trail[index].life - delta * healingRate);
    }
    while (trail.length && trail[0].life < .025) trail.shift();
  }

  function draw(now) {
    frame = 0;
    if (destroyed || document.hidden) return;
    if (!reduced && now < nextFrame) {
      frame = requestAnimationFrame(draw);
      return;
    }
    nextFrame = now + frameInterval;
    const delta = clamp((now - lastFrame) / 1000, .001, .05);
    lastFrame = now;
    const moving = motionAt > 0 && now - motionAt < 110;
    const targetForce = moving ? 1 : 0;
    pointerForce += (targetForce - pointerForce) * Math.min(1, delta * (moving ? 15 : 5.5));
    ageTrail(delta);
    field.update(delta, { x: pointerX, y: pointerY, strength: pointerForce });
    field.render();
    veil.render(trail);
    if (!reduced && (moving || pointerForce > .018 || trail.length)) frame = requestAnimationFrame(draw);
  }

  function resize() {
    field.resize();
    veil.resize();
    field.render();
    veil.render([]);
  }

  function visibilityChanged() {
    if (document.hidden) {
      cancelAnimationFrame(frame);
      frame = 0;
      return;
    }
    lastFrame = performance.now();
    resize();
  }

  addEventListener('resize', resize, { passive: true });
  addEventListener('pointermove', move, { passive: true });
  addEventListener('pointerdown', move, { passive: true });
  addEventListener('pointerup', release, { passive: true });
  addEventListener('pointercancel', release, { passive: true });
  addEventListener('pointerleave', release, { passive: true });
  addEventListener('blur', release, { passive: true });
  document.addEventListener('visibilitychange', visibilityChanged);
  resize();

  window.HexiGridBootEnvironment = Object.freeze({
    destroy() {
      destroyed = true;
      cancelAnimationFrame(frame);
      removeEventListener('resize', resize);
      removeEventListener('pointermove', move);
      removeEventListener('pointerdown', move);
      removeEventListener('pointerup', release);
      removeEventListener('pointercancel', release);
      removeEventListener('pointerleave', release);
      removeEventListener('blur', release);
      document.removeEventListener('visibilitychange', visibilityChanged);
      field.destroy();
      veil.destroy();
    }
  });
})();
