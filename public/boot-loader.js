(() => {
  if (document.documentElement.classList.contains('hexispace-live-embed')) {
    document.body.classList.remove('booting');
    window.hexigridBoot = { complete() {} };
    return;
  }
  const loader = document.querySelector('#bootLoader');
  const canvas = document.querySelector('#bootHologram');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const started = performance.now();
  let appReady = false;
  let enterRequested = false;
  let enteredAt = 0;
  let finished = false;
  let frame = 0;
  let nextRender = 0;
  let departTimer = 0;
  let finishTimer = 0;
  const coarsePointer = matchMedia('(pointer: coarse)').matches;
  const frameInterval = reduced ? 0 : 1000 / (coarsePointer ? 24 : 30);

  if (!loader || !canvas) {
    document.body.classList.remove('booting');
    window.hexigridBoot = { complete() {} };
    return;
  }

  const context = canvas.getContext('2d', { alpha: true });
  const { vertices, faces, faceCenters } = window.HexiGridBootGeometry;
  const FACET_STEP_MS = 102;
  const FACET_MOVE_MS = 310;
  const OUTER_UNLOCK_MS = FACET_STEP_MS * (faces.length - 1) + FACET_MOVE_MS;
  const CORE_RADIANCE_MS = 720;
  const TRANSITION_MS = 920;
  const outerUnlockOrder = faces.map((_, faceIndex) => faceIndex).sort((left, right) => {
    const vertical = faceCenters[right][1] - faceCenters[left][1];
    if (Math.abs(vertical) > .12) return vertical;
    const leftAngle = Math.atan2(faceCenters[left][2], faceCenters[left][0]);
    const rightAngle = Math.atan2(faceCenters[right][2], faceCenters[right][0]);
    return leftAngle - rightAngle;
  });
  const outerUnlockRank = Array(faces.length);
  outerUnlockOrder.forEach((faceIndex, rank) => { outerUnlockRank[faceIndex] = rank; });

  function rotate([x, y, z], yaw, pitch) {
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const rx = x * cy - z * sy;
    const rz = x * sy + z * cy;
    return [rx, y * cp - rz * sp, y * sp + rz * cp];
  }

  function project(point, size, scale = 1) {
    const depth = 3.8 - point[2];
    const perspective = 3.1 / depth;
    return [size / 2 + point[0] * size * .39 * perspective * scale, size / 2 + point[1] * size * .39 * perspective * scale, point[2]];
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.min(devicePixelRatio || 1, 1.1);
    canvas.width = Math.max(1, Math.round(rect.width * ratio));
    canvas.height = Math.max(1, Math.round(rect.height * ratio));
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  function smoothstep(value) {
    const x = Math.max(0, Math.min(1, value));
    return x * x * (3 - 2 * x);
  }

  function drawMesh(points, faceScale, alpha, unlockElapsed, time, inner = false, heat = 0) {
    const transformed = vertices.map((vertex, index) => {
      const thermalPulse = inner ? 1 + Math.sin(time * .014 + index * 1.7) * heat * .009 : 1;
      return rotate(vertex.map(value => value * faceScale * thermalPulse), time * (inner ? -.00024 : .00018), -.2 + Math.sin(time * .00033) * .07);
    });
    const ordered = faces.map((face, faceIndex) => {
      const center = rotate(faceCenters[faceIndex], time * (inner ? -.00024 : .00018), -.2 + Math.sin(time * .00033) * .07);
      return { face, faceIndex, depth: center[2], center };
    }).sort((a, b) => a.depth - b.depth);

    for (const item of ordered) {
      const stagger = inner ? 0 : smoothstep((unlockElapsed - outerUnlockRank[item.faceIndex] * FACET_STEP_MS) / FACET_MOVE_MS);
      const offset = item.center.map(value => value * stagger * (inner ? .18 : .72));
      let projected = item.face.map(index => project([
        transformed[index][0] + offset[0],
        transformed[index][1] + offset[1],
        transformed[index][2] + offset[2]
      ], points));
      if (!inner && stagger > 0) {
        const centerX = projected.reduce((sum, point) => sum + point[0], 0) / 3;
        const centerY = projected.reduce((sum, point) => sum + point[1], 0) / 3;
        const turn = (outerUnlockRank[item.faceIndex] % 2 ? -1 : 1) * stagger * .2;
        const cosine = Math.cos(turn), sine = Math.sin(turn);
        projected = projected.map(([x, y, depth]) => {
          const dx = x - centerX, dy = y - centerY;
          return [centerX + dx * cosine - dy * sine, centerY + dx * sine + dy * cosine, depth];
        });
      }
      const depthAlpha = .4 + (item.depth + 1) * .27;
      context.beginPath();
      context.moveTo(projected[0][0], projected[0][1]);
      context.lineTo(projected[1][0], projected[1][1]);
      context.lineTo(projected[2][0], projected[2][1]);
      context.closePath();
      const heatedRed = Math.round(103 + heat * 96);
      const heatedGreen = Math.round(127 + heat * 106);
      const tint = item.faceIndex % 3 === 0 ? '118,111,255' : inner ? `${heatedRed},${heatedGreen},255` : '38,205,255';
      context.fillStyle = `rgba(${tint},${alpha * depthAlpha * (inner ? .075 : .13)})`;
      context.fill();
      context.strokeStyle = `rgba(${inner ? `${Math.round(150 + heat * 82)},${Math.round(132 + heat * 104)},255` : '102,235,255'},${alpha * depthAlpha * (inner ? .54 + heat * .3 : .78)})`;
      context.lineWidth = inner ? .8 + heat * .5 : 1.15;
      context.shadowColor = inner ? '#917cff' : '#42dfff';
      context.shadowBlur = inner ? 8 + heat * 14 : 11;
      context.stroke();
      if (!inner && item.depth > -.3) {
        const centerX = (projected[0][0] + projected[1][0] + projected[2][0]) / 3;
        const centerY = (projected[0][1] + projected[1][1] + projected[2][1]) / 3;
        context.beginPath();
        for (let index = 0; index < 3; index += 1) {
          const x = centerX + (projected[index][0] - centerX) * .58;
          const y = centerY + (projected[index][1] - centerY) * .58;
          index ? context.lineTo(x, y) : context.moveTo(x, y);
        }
        context.closePath();
        context.strokeStyle = `rgba(169,247,255,${alpha * depthAlpha * .27})`;
        context.lineWidth = .55;
        context.shadowBlur = 4;
        context.stroke();
        context.beginPath();
        context.arc(centerX, centerY, Math.max(.8, points * .0024), 0, Math.PI * 2);
        context.fillStyle = `rgba(221,253,255,${alpha * depthAlpha * .55})`;
        context.fill();
      }
    }
  }

  function drawCore(size, time, charge, alpha) {
    context.save();
    context.globalCompositeOperation = 'source-over';
    const radius = size * (.018 + charge * .003);
    const cx = size / 2, cy = size / 2;
    const glow = context.createRadialGradient(cx, cy, 0, cx, cy, radius * 3.4);
    glow.addColorStop(0, `rgba(255,255,255,${alpha * .96})`);
    glow.addColorStop(.1, `rgba(116,238,255,${alpha * .72})`);
    glow.addColorStop(1, 'rgba(52,206,255,0)');
    context.fillStyle = glow;
    context.fillRect(cx - radius * 4, cy - radius * 4, radius * 8, radius * 8);
    context.beginPath();
    for (let index = 0; index < 6; index += 1) {
      const angle = time * .00055 + index * Math.PI / 3;
      const x = cx + Math.cos(angle) * radius;
      const y = cy + Math.sin(angle) * radius;
      index ? context.lineTo(x, y) : context.moveTo(x, y);
    }
    context.closePath();
    context.fillStyle = `rgba(220,251,255,${alpha * .42})`;
    context.strokeStyle = `rgba(255,255,255,${alpha})`;
    context.lineWidth = 1.4;
    context.shadowColor = '#baf8ff';
    context.shadowBlur = 9 + charge * 6;
    context.fill();
    context.stroke();
    context.restore();
  }

  function drawWordRing(size, time, alpha, explode) {
    const radiusX = size * (.37 + explode * .025);
    const radiusY = size * .118;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.shadowColor = '#54e9ff';
    context.shadowBlur = 8;
    const angle = time * .00062;
    const depth = Math.sin(angle);
    context.save();
    context.translate(size / 2 + Math.cos(angle) * radiusX, size / 2 + Math.sin(angle) * radiusY);
    context.rotate(Math.cos(angle) * .18);
    const textScale = .78 + depth * .25;
    context.scale(textScale, textScale);
    context.font = `800 ${Math.max(20, size * .058)}px ui-monospace, SFMono-Regular, Consolas, monospace`;
    context.fillStyle = `rgba(177,249,255,${alpha * (.5 + (depth + 1) * .24)})`;
    context.fillText('HexiGrid', 0, 0);
    context.restore();
  }

  function drawScan(size, time, alpha, dissolve) {
    const progress = (time % 1250) / 1250;
    const y = size * (.29 + progress * .42);
    const gradient = context.createLinearGradient(size * .2, y, size * .8, y);
    gradient.addColorStop(0, 'rgba(74,227,255,0)');
    gradient.addColorStop(.5, `rgba(196,250,255,${alpha * (1 - dissolve) * .22})`);
    gradient.addColorStop(1, 'rgba(74,227,255,0)');
    context.fillStyle = gradient;
    context.shadowColor = '#66eaff';
    context.shadowBlur = 9;
    context.fillRect(size * .2, y, size * .6, 1);
  }

  function drawCircuitField(size, time, alpha, unlock) {
    const cx = size / 2, cy = size / 2;
    context.save(); context.lineWidth = .7; context.shadowColor = '#51edff'; context.shadowBlur = 6;
    for (let index = 0; index < 12; index += 1) {
      const angle = index * Math.PI / 6 + Math.sin(time * .00023 + index) * .025;
      const start = size * (.095 + (index % 3) * .014), bend = size * (.18 + (index % 2) * .025 + unlock * .04), end = size * (.255 + (index % 4) * .012 + unlock * .08);
      context.beginPath(); context.moveTo(cx + Math.cos(angle) * start, cy + Math.sin(angle) * start); context.lineTo(cx + Math.cos(angle) * bend, cy + Math.sin(angle) * bend); context.lineTo(cx + Math.cos(angle + (index % 2 ? .16 : -.16)) * end, cy + Math.sin(angle + (index % 2 ? .16 : -.16)) * end);
      context.strokeStyle = `rgba(${index % 3 ? '92,232,255' : '157,130,255'},${alpha * (.18 + (index % 4) * .045)})`; context.stroke();
      const pulse = (time * .00035 + index * .083) % 1;
      context.beginPath(); context.arc(cx + Math.cos(angle) * (start + (end - start) * pulse), cy + Math.sin(angle) * (start + (end - start) * pulse), Math.max(1, size * .0022), 0, Math.PI * 2); context.fillStyle = `rgba(206,253,255,${alpha * .72})`; context.fill();
    }
    context.restore();
  }

  function drawInnerRadiance(size, radiance, alpha) {
    if (radiance <= .001) return;
    const cx = size / 2, cy = size / 2;
    const radius = size * (.08 + radiance * .24);
    context.save();
    context.globalCompositeOperation = 'lighter';
    const glow = context.createRadialGradient(cx, cy, 0, cx, cy, radius);
    glow.addColorStop(0, `rgba(239,254,255,${alpha * radiance * .34})`);
    glow.addColorStop(.2, `rgba(104,235,255,${alpha * radiance * .24})`);
    glow.addColorStop(.58, `rgba(121,105,255,${alpha * radiance * .09})`);
    glow.addColorStop(1, 'rgba(35,190,255,0)');
    context.fillStyle = glow;
    context.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
    context.strokeStyle = `rgba(184,249,255,${alpha * radiance * .32})`;
    context.lineWidth = 1;
    context.shadowColor = '#72eaff';
    context.shadowBlur = 8;
    context.beginPath();
    context.arc(cx, cy, radius * .38, 0, Math.PI * 2);
    context.stroke();
    context.restore();
  }

  function drawReadyPrompt(size, alpha) {
    if (!appReady || enteredAt) return;
    context.save();
    context.font = `750 ${Math.max(11, size * .021)}px ui-monospace, SFMono-Regular, Consolas, monospace`;
    context.textAlign = 'center';
    context.letterSpacing = `${Math.max(2, size * .006)}px`;
    context.strokeStyle = `rgba(1,18,36,${alpha * .88})`;
    context.lineWidth = Math.max(1.5, size * .0032);
    context.shadowBlur = 0;
    context.strokeText('CLICK TO ENTER', size / 2, size * .885);
    context.fillStyle = `rgba(239,254,255,${alpha * (.9 + Math.sin(performance.now() * .004) * .08)})`;
    context.shadowColor = 'rgba(72,235,255,.9)';
    context.shadowBlur = 10;
    context.fillText('CLICK TO ENTER', size / 2, size * .885);
    context.restore();
  }

  function render(now) {
    if (!reduced && now < nextRender) {
      frame = requestAnimationFrame(render);
      return;
    }
    nextRender = now + frameInterval;
    const elapsed = now - started;
    const bounds = canvas.getBoundingClientRect();
    const width = bounds.width;
    const height = bounds.height;
    const size = Math.min(width, height) * .88;
    const offsetX = (width - size) / 2;
    const offsetY = (height - size) / 2;
    context.clearRect(0, 0, width, height);
    const fadeIn = reduced ? 1 : smoothstep(elapsed / 420);
    const unlockStart = enteredAt ? enteredAt - started : Infinity;
    const unlockElapsed = reduced ? (enteredAt ? OUTER_UNLOCK_MS : 0) : elapsed - unlockStart;
    const unlock = reduced ? (enteredAt ? 1 : 0) : smoothstep(unlockElapsed / OUTER_UNLOCK_MS);
    const reactorHeat = reduced ? unlock : smoothstep(unlockElapsed / OUTER_UNLOCK_MS);
    const finalCharge = reduced ? unlock : smoothstep((unlockElapsed - OUTER_UNLOCK_MS) / CORE_RADIANCE_MS);
    const instability = reactorHeat * (.72 + Math.sin(elapsed * .018) * .18 + Math.sin(elapsed * .031) * .1);
    const innerRadiance = Math.min(1, reactorHeat * .48 + finalCharge * .52);
    const zoomStart = OUTER_UNLOCK_MS + CORE_RADIANCE_MS * .52;
    const dissolveStart = OUTER_UNLOCK_MS + CORE_RADIANCE_MS * .76;
    const zoom = reduced ? unlock : smoothstep((unlockElapsed - zoomStart) / TRANSITION_MS);
    const dissolve = reduced ? unlock : smoothstep((unlockElapsed - dissolveStart) / (TRANSITION_MS * .82));
    const alpha = fadeIn * (1 - dissolve);
    const charge = Math.min(1, .38 + elapsed / 1450) + Math.sin(elapsed * .011) * .08;

    context.save();
    context.translate(offsetX, offsetY);
    context.globalCompositeOperation = 'lighter';
    context.translate(size / 2, size / 2);
    context.scale(1 + zoom * .12, 1 + zoom * .12);
    context.translate(-size / 2, -size / 2);
    drawWordRing(size, elapsed, alpha, unlock);
    drawCircuitField(size, elapsed, alpha, unlock);
    drawMesh(size, .39, alpha * (.44 + innerRadiance * .12), 0, elapsed, true, instability);
    drawMesh(size, .62, alpha * (.74 + innerRadiance * .16), 0, elapsed, true, instability);
    drawMesh(size, .98, alpha, unlockElapsed, elapsed, false);
    drawScan(size, elapsed, alpha, dissolve);
    drawInnerRadiance(size, innerRadiance, alpha);
    drawCore(size, elapsed, charge + reactorHeat * .62 + finalCharge * .72, alpha);
    drawReadyPrompt(size, alpha);
    context.restore();
    if (enteredAt && (reduced || unlockElapsed > dissolveStart + TRANSITION_MS)) return finish();
    if (!reduced && !document.hidden) frame = requestAnimationFrame(render);
    else frame = 0;
  }

  function finish() {
    if (finished) return;
    finished = true;
    cancelAnimationFrame(frame);
    clearTimeout(departTimer);
    clearTimeout(finishTimer);
    document.removeEventListener('visibilitychange', visibilityChanged);
    window.HexiGridBootEnvironment?.destroy?.();
    loader.classList.add('unlocked');
    document.body.classList.remove('booting');
    setTimeout(() => loader.remove(), 460);
  }

  function complete() {
    if (appReady || finished) return;
    const minimum = reduced ? 0 : 1500;
    const setReady = () => {
      appReady = true;
      loader.classList.add('ready');
      loader.setAttribute('aria-label', 'Open HexiGrid');
      if (enterRequested) beginEnter();
    };
    const remaining = minimum - (performance.now() - started);
    remaining > 0 ? setTimeout(setReady, remaining) : setReady();
  }

  function beginEnter() {
    enterRequested = true;
    if (!appReady || enteredAt || finished) return;
    enteredAt = performance.now();
    loader.classList.remove('ready');
    loader.classList.add('opening');
    window.HexiInteractions?.playFacetSequence?.({ count: faces.length, stepMs: FACET_STEP_MS });
    if (reduced) loader.classList.add('departing');
    else departTimer = setTimeout(() => loader.classList.add('departing'), OUTER_UNLOCK_MS + CORE_RADIANCE_MS * .76);
    loader.setAttribute('aria-label', 'Opening HexiGrid');
    // Opening must complete even when a background tab stops painting frames.
    finishTimer = setTimeout(finish, reduced ? 0 : OUTER_UNLOCK_MS + CORE_RADIANCE_MS * .76 + TRANSITION_MS + 100);
    if (!frame) frame = requestAnimationFrame(render);
  }

  function visibilityChanged() {
    if (document.hidden) {
      cancelAnimationFrame(frame);
      frame = 0;
      return;
    }
    nextRender = 0;
    if (!finished && !frame) frame = requestAnimationFrame(render);
  }

  addEventListener('resize', resize, { passive: true });
  document.addEventListener('visibilitychange', visibilityChanged);
  resize();
  // Paint the first frame synchronously so a slow or throttled rAF cannot
  // leave the boot surface looking like an empty blue screen.
  render(performance.now());
  loader.addEventListener('click', beginEnter);
  loader.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    beginEnter();
  });
  window.hexigridBoot = { complete, dismissForAuth: finish };
  setTimeout(complete, 8000);
})();
