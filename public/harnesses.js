function harnessStateMessage(item) {
  if (!item.installed) return 'Not found on this computer';
  if (item.id === 'opencode' && !item.authenticated) return item.connected ? 'Connected · local models need no sign-in' : 'Ready to connect · local models need no sign-in';
  if (!item.authenticated) return 'Installed, but not signed in';
  return item.connected ? 'Connected and ready' : 'Detected and signed in';
}

const harnessOfficialGuides = Object.freeze({
  opencode: 'https://opencode.ai/docs/cli/',
  'claude-code': 'https://docs.anthropic.com/en/docs/claude-code/getting-started',
  codex: 'https://learn.chatgpt.com/docs/codex/cli'
});
const harnessSimpleGuides = Object.freeze({ opencode: 'opencode', 'claude-code': 'claudeCode', codex: 'codex' });

function harnessConnectionDisabled(item) {
  return !item.installed || (item.id !== 'opencode' && !item.authenticated) || !isHostBrowser();
}

function renderHarnesses() {
  const root=document.querySelector('#harnessList'); if(!root)return;
  const harnesses=state.data?.harnesses||[];
  root.innerHTML='<div class="integration-help-links"><button class="text-button" type="button" data-action="open-guide-topic" data-guide="cli">What is a computer tool?</button></div>'+harnesses.map((item)=>`<article class="harness-option ${item.connected?'connected':''}"><div class="connection-title"><span class="provider-orb local">${escapeHtml(item.label.slice(0,2).toUpperCase())}</span><div><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(harnessStateMessage(item))}${item.version?` · ${escapeHtml(item.version)}`:''}</small><div class="integration-help-links"><button class="text-button" type="button" data-action="open-guide-topic" data-guide="${harnessSimpleGuides[item.id]}">Simple steps</button><a class="external-link" href="${harnessOfficialGuides[item.id]}" target="_blank" rel="noopener noreferrer">Official guide ↗</a></div></div></div><button class="${item.connected?'ghost-button':'primary-button'}" data-harness-${item.connected?'disconnect':'connect'}="${item.id}" ${harnessConnectionDisabled(item)?'disabled':''}>${item.connected?'Disconnect':'Connect'}</button></article>`).join('');
}

async function scanHarnesses() {
  const feedback=document.querySelector('#harnessFeedback'); if(feedback)feedback.textContent='Scanning this computer…';
  try {const result=await api('/api/harnesses');state.data.harnesses=result.harnesses;renderHarnesses();if(feedback)feedback.textContent='Scan complete. Nothing was connected automatically.';}
  catch(error){if(feedback)feedback.textContent=error.message;}
}

document.addEventListener('click',async(event)=>{
  const button=event.target.closest('[data-harness-scan],[data-harness-connect],[data-harness-disconnect]');if(!button)return;
  button.disabled=true;const feedback=document.querySelector('#harnessFeedback');
  try {
    if(button.hasAttribute('data-harness-scan'))return await scanHarnesses();
    const harnessId=button.dataset.harnessConnect||button.dataset.harnessDisconnect;
    const method=button.dataset.harnessConnect?'POST':'DELETE';
    await api(`/api/harnesses/${harnessId}`,{method});await refresh();
    if(feedback)feedback.textContent=method==='POST'?'Connected. Its current models are now available.':'Disconnected.';
  }catch(error){if(feedback)feedback.textContent=error.message;}finally{button.disabled=false;}
});
