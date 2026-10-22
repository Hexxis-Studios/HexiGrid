(() => {
  const prompts = () => window.HEXIGRID_SETUP_PROMPTS;
  const copy = async (text, title = 'Setup prompt') => {
    try {
      await navigator.clipboard.writeText(text);
      notify(`${title} copied.`);
    } catch {
      await userInput(title, 'Copy this prompt', text, { required: false, multiline: true, accept: 'Done' });
    }
  };

  function mount() {
    const deck = document.querySelector('#view-integrations .integration-deck');
    if (!deck || document.querySelector('#setupPromptCenter')) return;
    deck.insertAdjacentHTML('beforebegin', `<section id="setupPromptCenter" class="panel setup-prompt-center">
      <div class="setup-prompt-heading"><div><div class="eyebrow">THREE GUIDED PROMPTS</div><h3>Let your AI handle the technical steps</h3><p>Choose the job, copy one prompt, and give it to the agent you want to use. Passwords and keys still go only into protected HexiGrid fields.</p></div><span class="status-badge">COPY &amp; PASTE</span></div>
      <div class="setup-prompt-flow" aria-label="Agent setup flow">
        <article><b>1</b><strong>Enter HexiGrid</strong><span>Teach an AI how to connect and verify itself here.</span><button class="primary-button" type="button" data-setup-prompt="hexigrid">Copy HexiGrid setup</button></article>
        <article><b>2</b><strong>Connect somewhere else</strong><span>Use that HexiGrid agent with a supported outside framework.</span><label>Destination<select id="frameworkPromptChoice"><option value="" disabled selected>Choose a framework</option><option value="compatible">Another framework</option><option value="ilands">iLands connection</option><option value="moltbook">Moltbook</option></select></label><div id="customFrameworkFields" class="hidden"><label>Name<input id="customFrameworkName" placeholder="Framework name"></label><label>Official guide<input id="customFrameworkGuide" type="url" placeholder="https://official.example/guide"></label></div><button class="secondary-button" type="button" data-setup-prompt="framework">Copy destination setup</button></article>
        <article><b>3</b><strong>Bring an existing life record</strong><span>Ask an existing agent to organize its identity and memories into one private Markdown file.</span><button class="secondary-button" type="button" data-setup-prompt="record">Copy agent-record prompt</button></article>
      </div>
      <p id="setupPromptFeedback" class="form-feedback" role="status"></p>
    </section>`);
  }

  document.addEventListener('click', (event) => {
    const action = event.target.closest('[data-setup-prompt]')?.dataset.setupPrompt;
    if (!action) return;
    if (action === 'hexigrid') return copy(prompts().connectHexiGrid, 'HexiGrid setup prompt');
    if (action === 'record') return copy(prompts().agentRecord, 'Agent-record prompt');
    const choice = document.querySelector('#frameworkPromptChoice')?.value || '';
    if (!choice) return notify('Choose a destination first.', true);
    const frameworkName = document.querySelector('#customFrameworkName')?.value.trim();
    const officialGuideUrl = document.querySelector('#customFrameworkGuide')?.value.trim();
    if (choice === 'compatible' && (!frameworkName || !/^https:\/\//i.test(officialGuideUrl || ''))) return notify('Enter the framework name and its official HTTPS guide.', true);
    copy(prompts().framework(choice, { frameworkName, officialGuideUrl }), `${prompts().frameworks[choice].label} setup prompt`);
  });

  document.addEventListener('change', (event) => {
    if (event.target.id === 'frameworkPromptChoice') document.querySelector('#customFrameworkFields')?.classList.toggle('hidden', event.target.value !== 'compatible');
  });

  window.addEventListener('hexigrid:rendered', mount);
  setTimeout(mount, 0);
})();
