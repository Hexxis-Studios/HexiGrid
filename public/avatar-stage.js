(() => {
  let current = null, selected = '', loading = false, timer = null, localExpression = '';
  const $ = selector => document.querySelector(selector);
  async function refresh() {
    if (loading || state.activeView !== 'integrations') return;
    const select = $('#avatarStageAgent');
    if (!select?.value) return;
    const agentId = select.value;
    loading = true;
    try {
      const result = await api(`/api/agents/${encodeURIComponent(agentId)}/avatar-presence`);
      if (select.value !== agentId) return;
      current = result.avatar; selected = agentId; paint();
    } catch (error) { $('#avatarStageStatus').textContent = error.message; }
    finally { loading = false; }
  }
  function paint() {
    if (!current || selected !== $('#avatarStageAgent')?.value) return;
    const item = agent(selected), stage = $('#avatarStageBody');
    const source = item?.avatarModel?.url || item?.avatarImage || '';
    const kind = item?.avatarModel?.url ? '3d' : '2d';
    const format = item?.avatarModel?.format || 'glb';
    const key = `${selected}:${kind}:${format}:${source}`;
    if (current.visible && stage.dataset.asset !== key) {
      stage.dataset.asset = key;
      localExpression = '';
      stage.innerHTML = kind === '3d' ? window.HexiGridAvatarViewer.element(source, item.name, 'avatar-stage-model', format) : source ? `<img src="${escapeHtml(source)}" alt="${escapeHtml(item.name)} avatar" />` : `<span class="avatar-stage-initials">${escapeHtml(initials(item?.name || 'Agent'))}</span>`;
      const model = stage.querySelector('model-viewer') || stage.querySelector('hexi-vrm-viewer');
      const image = stage.querySelector('img');
      if (image) {
        image.dataset.loadState = 'loading';
        image.addEventListener('load', () => { image.dataset.loadState = 'ready'; paint(); });
        image.addEventListener('error', () => { image.dataset.loadState = 'failed'; paint(); });
      }
      if (model) {
        model.dataset.loadState = 'loading';
        model.addEventListener('load', () => { model.dataset.loadState = 'ready'; paint(); });
        model.addEventListener('error', () => { model.dataset.loadState = 'failed'; paint(); });
      }
    }
    stage.hidden = !current.visible;
    stage.dataset.state = current.state;
    const model = stage.querySelector('model-viewer') || stage.querySelector('hexi-vrm-viewer');
    // Transform the body, not its clipped frame. A prior 2D pose must never
    // rotate or scale a subsequently selected 3D viewer's controls.
    stage.style.transform = '';
    if (model) {
      const presentation = { orientation: `0deg 0deg ${current.yaw}deg`, scale: `${current.scale} ${current.scale} ${current.scale}` };
      for (const [name, value] of Object.entries(presentation)) if (model.getAttribute(name) !== value) model.setAttribute(name, value);
      const clips = model.availableAnimations || [];
      const clip = $('#avatarStageAnimation');
      const options = ['<option value="">Default animation</option>', ...clips.map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`)].join('');
      if (clip.innerHTML !== options) clip.innerHTML = options;
      clip.value = clips.includes(current.animation) ? current.animation : '';
      const expressionSelect = $('#avatarStageExpression');
      const expressionLabel = $('#avatarStageExpressionLabel');
      const expressions = model.availableExpressions || [];
      if (expressionSelect) {
        const expressionOptions = ['<option value="">Model default</option>', ...expressions.map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`)].join('');
        if (expressionSelect.innerHTML !== expressionOptions) expressionSelect.innerHTML = expressionOptions;
        if (expressionLabel) expressionLabel.hidden = !expressions.length;
        if (localExpression && !expressions.includes(localExpression)) localExpression = '';
        expressionSelect.value = localExpression;
        if (model.getAttribute('expression') !== localExpression) model.setAttribute('expression', localExpression);
      }
      if (model.dataset.loadState === 'failed') {
        $('#avatarStageStatus').textContent = `Model could not load. ${model.shadowRoot?.querySelector('.error')?.textContent || model.textContent?.trim() || 'Edit this agent to choose a self-contained GLB or VRM.'}`;
      } else if (!model.loaded && model.dataset.loadState !== 'ready') {
        $('#avatarStageStatus').textContent = 'Loading 3D avatar…';
      } else if (current.animation && !clips.includes(current.animation) && model.loaded) {
        $('#avatarStageStatus').textContent = `Animation unavailable: ${current.animation}. Choose a listed clip.`;
      } else $('#avatarStageStatus').textContent = `${clip.value || 'Default animation'} · ${current.playing ? 'playing' : 'paused'} · ${localExpression || 'no expression'} · revision ${current.revision} · ${current.visible ? 'visible' : 'hidden'} · ${format === 'vrm' ? 'VRM' : 'GLB'} model`;
      if (clip.value) {
        if (model.getAttribute('animation-name') !== clip.value) model.setAttribute('animation-name', clip.value);
      } else model.removeAttribute('animation-name');
      // play() reselects the clip and emits a play event. Status refreshes
      // must leave a running timeline alone rather than reselect it every 3s.
      if (current.visible && current.playing) {
        if (model.paused === true) model.play?.();
      } else if (model.paused === false) model.pause?.();
    } else {
      const body = stage.querySelector('img') || stage.querySelector('.avatar-stage-initials');
      if (body) body.style.transform = `rotateY(${current.yaw}deg) scale(${current.scale})`;
      const image = stage.querySelector('img');
      $('#avatarStageStatus').textContent = image?.dataset.loadState === 'failed'
        ? 'Image could not load. Edit this agent to choose another avatar image.'
        : `${current.state} · revision ${current.revision} · ${current.visible ? 'visible' : 'hidden'} · ${kind === '3d' ? '3D model; loads when shown' : source ? '2D image' : 'initials; add an image or GLB in Edit agent'}`;
    }
    $('#avatarStageToggle').textContent = current.visible ? 'Hide avatar' : 'Show avatar';
    $('#avatarStagePlay').textContent = current.playing ? 'Pause animation' : 'Play animation';
    $('#avatarStagePlay').disabled = !model;
    $('#avatarStageAnimation').disabled = !model || !(model.availableAnimations || []).length;
  }
  async function change(patch) {
    if (!current || selected !== $('#avatarStageAgent').value) return;
    const agentId = selected;
    try {
      const result = await api(`/api/agents/${encodeURIComponent(agentId)}/avatar-presence`, { method: 'PATCH', body: JSON.stringify({ ...patch, expectedRevision: current.revision }) });
      if ($('#avatarStageAgent').value === agentId) { current = result.avatar; paint(); }
    } catch (error) { const message = error.message; current = null; await refresh(); $('#avatarStageStatus').textContent = message; }
  }
  function render() {
    const select = $('#avatarStageAgent');
    if (!select) return;
    const value = select.value;
    const agents = (state.data?.agents || []).filter(item => item.status !== 'suspended');
    select.innerHTML = agents.map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(agentListLabel(item))}</option>`).join('') || '<option value="">No agents yet</option>';
    select.value = agents.some(item => item.id === value) ? value : agents[0]?.id || '';
    $('#avatarStageToggle').disabled = !select.value;
    if (selected !== select.value || !select.value) {
      current = null; localExpression = ''; $('#avatarStageBody').hidden = true;
      $('#avatarStageStatus').textContent = select.value ? 'Loading avatar controls…' : 'Add an agent to use an avatar.';
    }
    if (state.activeView === 'integrations') void refresh();
    if (!timer) timer = setInterval(() => { if (state.activeView === 'integrations' && !document.hidden) void refresh(); }, 3000);
  }
  document.addEventListener('change', event => {
    if (event.target.id === 'avatarStageAgent') { current = null; $('#avatarStageBody').hidden = true; $('#avatarStageStatus').textContent = 'Loading avatar controls…'; void refresh(); }
    if (event.target.id === 'avatarStageAnimation') void change({ animation: event.target.value });
    if (event.target.id === 'avatarStageExpression') { localExpression = event.target.value; paint(); }
  });
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-avatar-stage]');
    if (!button || !current) return;
    const action = button.dataset.avatarStage;
    if (action === 'toggle') void change({ visible: !current.visible });
    if (action === 'play') void change({ playing: !current.playing });
    if (action === 'turn') void change({ yaw: current.yaw >= 180 ? -180 : Math.min(180, current.yaw + 45) });
    if (action === 'reset') { localExpression = 'neutral'; void change({ yaw: 0, scale: 1, animation: current.animations?.find(name => name.toLowerCase() === 'idle') || '', playing: true, state: 'idle' }); }
  });
  window.HexiGridAvatarStage = Object.freeze({ render });
})();
