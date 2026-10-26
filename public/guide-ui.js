/* Guide cards, detailed help drawer, troubleshooting, and setup prompt. */
function renderGuide() {
  const agents = state.data.agents;
  const checks = [
    state.data.settings.owner?.displayName && state.data.settings.owner.displayName !== "Owner",
    availableModels().length > 0,
    agents.some((item) => item.personality || item.instructions),
    agents.some((item) => item.transport === "local-opencode" || item.ilandsAgentId) || (state.data.agentLinks || []).some(item => item.authorizationStatus === 'connected'),
    state.data.settings.setupAcknowledged
  ];
  const complete = checks.filter(Boolean).length;
  const percent = Math.round((complete / checks.length) * 100);
  $("#guideProgressRing").className = `progress-ring progress-${complete}`;
  $("#guideProgressRing").querySelector("strong").textContent = `${percent}%`;
  $("#guideProgressTitle").textContent = percent === 100 ? "Setup complete" : complete < 2 ? "Getting started" : "Setup progress";
  $("#guideProgressText").textContent = percent === 100 ? "The basics are complete. Keep tuning profiles and permissions as your setup grows." : `${complete} of ${checks.length} basics complete. The next useful step is ${!checks[1] ? "checking your free models" : !checks[2] ? "shaping an agent personality" : "testing a connection"}.`;
  const query = ($('#guideSearch')?.value || '').trim().toLocaleLowerCase();
  const everyday = ['start','basics','navigation','connections','existingAgent','ilands','muse','live','voices','speechSetup','phonebook','avatars','rooms','memory','skills','sharedMemory','computerAccess','workspace','tasks','vault','usage','backup','automaticBackups','desktop','agentInterface','codexChats'];
  const entries = Object.entries(guideTopics).sort(([a], [b]) => (everyday.includes(a) ? everyday.indexOf(a) : everyday.length) - (everyday.includes(b) ? everyday.indexOf(b) : everyday.length));
  const topics = entries.map(([key, topic], index) => ({ key, topic, index })).filter(({topic}) => !query || `${topic.title} ${topic.summary} ${topic.lead} ${topic.steps.flat().join(' ')}`.toLocaleLowerCase().includes(query));
  if (query) topics.sort((a, b) => Number(b.topic.title.toLocaleLowerCase().includes(query)) - Number(a.topic.title.toLocaleLowerCase().includes(query)));
  if ($('#guideSearchStatus')) $('#guideSearchStatus').textContent = `${topics.length} ${topics.length === 1 ? 'guide' : 'guides'}${query ? ' found' : ''}`;
  $("#guideGrid").innerHTML = topics.map(({key, topic, index}) => `<button class="guide-card" data-action="open-guide-topic" data-guide="${escapeHtml(key)}"><span class="guide-icon" data-icon="${escapeHtml(topic.icon || 'guide')}"></span><div><strong>${escapeHtml(topic.title)}</strong><p>${escapeHtml(topic.summary)}</p><small>${escapeHtml(topic.time || 'Step-by-step')}</small></div><span class="guide-number">${String(index + 1).padStart(2, '0')}</span></button>`).join('') || '<p>No matching guides. Try a feature name such as memory, calls, or backup.</p>';
}

function guidePicture(picture) {
  if (!picture || !/^\/help\/[a-z0-9-]+\.webp$/.test(picture.src)) return '';
  const size = Number.isInteger(picture.width) && picture.width > 0 && Number.isInteger(picture.height) && picture.height > 0 ? ` width="${picture.width}" height="${picture.height}"` : '';
  return `<figure class="guide-picture"><button type="button" data-guide-image="${escapeHtml(picture.src)}" aria-label="Enlarge screenshot: ${escapeHtml(picture.alt)}"><img src="${escapeHtml(picture.src)}" alt="${escapeHtml(picture.alt)}"${size} loading="lazy" decoding="async"></button><figcaption>${escapeHtml(picture.caption)} Select the picture to enlarge.</figcaption></figure>`;
}

let guideImageTrigger = null;
function openGuideImage(trigger) {
  const viewer = $('#guideImageViewer');
  const src = trigger?.dataset.guideImage;
  if (!viewer || !/^\/help\/[a-z0-9-]+\.webp$/.test(src || '')) return;
  guideImageTrigger = trigger;
  $('#guideImageFull').src = src;
  $('#guideImageFull').alt = trigger.querySelector('img')?.alt || 'Guide screenshot';
  viewer.classList.remove('is-original');
  $('#guideImageSize').textContent = 'Actual size';
  if (!viewer.open) viewer.showModal();
}

const guideImageViewer = document.getElementById('guideImageViewer');
guideImageViewer?.addEventListener('click', event => {
  if (event.target === guideImageViewer || event.target.closest('[data-close-guide-image]')) guideImageViewer.close();
  else if (event.target.closest('#guideImageSize')) {
    const original = guideImageViewer.classList.toggle('is-original');
    $('#guideImageSize').textContent = original ? 'Fit image' : 'Actual size';
  }
});
guideImageViewer?.addEventListener('keydown', event => {
  if (event.key === 'Escape') event.stopPropagation();
});
guideImageViewer?.addEventListener('close', () => {
  if (guideImageTrigger?.isConnected) guideImageTrigger.focus({ preventScroll:true });
  guideImageTrigger = null;
});
document.addEventListener('click', event => {
  const trigger = event.target.closest('[data-guide-image]');
  if (trigger) openGuideImage(trigger);
});

function openGuideTopic(key) {
  const topic = guideTopics[key] || guideTopics.start;
  const steps = topic.steps.map(([title, body], index) => `<li><span>${String(index + 1).padStart(2, '0')}</span><div><strong>${escapeHtml(title)}</strong><p>${escapeHtml(body)}</p>${(topic.stepImages || []).filter(picture => picture.step === index).map(guidePicture).join('')}</div></li>`).join('');
  $("#guideDrawerTitle").textContent = topic.title;
  const troubleshooting = topic.troubleshooting?.length ? `<section class="guide-troubleshooting"><h3>If something goes wrong</h3>${topic.troubleshooting.map(([problem, fix]) => `<details><summary>${escapeHtml(problem)}</summary><p>${escapeHtml(fix)}</p></details>`).join('')}</section>` : '';
  const prompt = topic.prompt ? `<section class="guide-prompt"><div><h3>Safe setup prompt</h3><p>Copy this into an AI assistant. Keep keys and sign-ins inside HexiGrid.</p></div><pre>${escapeHtml(topic.prompt)}</pre><button class="primary-button" data-action="copy-integration-prompt" data-guide="${escapeHtml(key)}"><span data-icon="copy"></span>Copy setup prompt</button></section>` : '';
  const links = topic.officialLinks?.length ? `<div class="integration-help-links">${topic.officialLinks.map(([label, url]) => `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`).join('')}</div>` : '<p>Nothing to download or sign up for.</p>';
  const numberedGuide = topic.basics ? `<section class="guide-basics"><article><span>1</span><div><h3>What this is</h3><p>${escapeHtml(topic.basics.what)}</p></div></article><article><span>2</span><div><h3>What you need first</h3><p>${escapeHtml(topic.basics.need)}</p></div></article><article><span>3</span><div><h3>Exactly where to get it</h3>${links}</div></article></section><section class="guide-plug-in"><h3>4. Plug it into HexiGrid</h3><ol class="drawer-steps">${steps}</ol></section><section class="guide-cost"><span>5</span><div><h3>Cost and limits</h3><p>${escapeHtml(topic.basics.cost)}</p></div></section>` : `<ol class="drawer-steps">${steps}</ol>${topic.officialLinks?.length ? `<section class="guide-official"><h3>Official source</h3>${links}</section>` : ''}`;
  const picture = guidePicture(topic.image);
  $("#guideDrawerBody").innerHTML = `<p class="drawer-lead">${escapeHtml(topic.lead)}</p>${picture}${numberedGuide}${troubleshooting}${prompt}<div class="guide-note"><strong>Good to know</strong><p>${escapeHtml(topic.note)}</p></div>`;
  $("#guideDrawer").classList.remove("hidden");
  document.body.classList.add("overlay-open");
}

function closeGuideTopic() { if (guideImageViewer?.open) guideImageViewer.close(); $("#guideDrawer").classList.add("hidden"); document.body.classList.remove("overlay-open"); }

document.addEventListener('input', event => { if (event.target.id === 'guideSearch') renderGuide(); });
