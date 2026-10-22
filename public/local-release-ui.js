// Manual owner recovery only: no automatic download, switching or polling.
let localReleaseStanding = null;
let localReleaseBusy = false;
function renderLocalReleaseRecovery() {
  const root = document.querySelector('#localReleaseRecovery');
  if (!root) return;
  if (isStandaloneBrowser()) { root.hidden = true; return; }
  root.hidden = false;
  const previousChoice = root.querySelector('#localReleaseChoice')?.value || '';
  const draftId = root.querySelector('#localReleaseId')?.value || '';
  const feedback = root.querySelector('[data-release-feedback]')?.textContent || '';
  const standing = localReleaseStanding;
  const releases = standing?.releases || [];
  root.innerHTML = `<div class="panel-heading"><div><div class="eyebrow">INSTALLATION + RECOVERY</div><h3 id="localReleaseHeading">Choose your local version</h3></div><span class="status-badge">NEXT STARTUP</span></div>
    <p class="panel-copy">Review a prepared local version, select it for the next HexiGrid startup, or return to the previous selection. Your private app data stays in the same place.</p>
    <dl class="release-standing"><div><dt>Selected version</dt><dd>${standing ? escapeHtml(standing.activeId || 'Current installation') : 'Load version status to check'}</dd></div><div><dt>Previous selection</dt><dd>${standing ? escapeHtml(standing.previousId || 'None yet') : 'Not checked'}</dd></div></dl>
    <p class="microcopy">Selection does not restart HexiGrid or Codex. Check data compatibility before returning to an older version. Keep a reviewed baseline before your first update. Version changes require Build mode; reading status is available in modes that allow local reads.</p>
    <div class="provider-actions"><button type="button" class="secondary-button" data-release-action="refresh">Load version status</button></div>
    <div class="stack-form release-selection"><label>Reviewed versions<select id="localReleaseChoice"><option value="">${releases.length ? 'Choose a version' : standing ? 'No reviewed versions yet' : 'Load status first'}</option>${releases.map(r => `<option value="${escapeHtml(r.id)}">${escapeHtml(r.id)} · ${escapeHtml(r.version)}</option>`).join('')}</select></label>
    <div class="provider-actions"><button type="button" class="secondary-button" data-release-action="activate">Use on next startup</button><button type="button" class="ghost-button" data-release-action="rollback">Return to previous selection</button></div></div>
    <details><summary>Add a prepared version</summary><p class="panel-copy">Prepare the source with the local release tool first. Enter its folder ID after reviewing the code. Registering checks the managed folder and records its fingerprint; it does not execute it.</p><label>Prepared folder ID<input id="localReleaseId" maxlength="64" placeholder="For example, reviewed-a" autocomplete="off" value="${escapeHtml(draftId)}"></label><button type="button" class="secondary-button" data-release-action="register">Review and register</button></details>
    <p data-release-feedback role="status" aria-live="polite">${escapeHtml(feedback)}</p>`;
  if (releases.some(r => r.id === previousChoice)) root.querySelector('#localReleaseChoice').value = previousChoice;
  updateLocalReleaseControls();
}
function updateLocalReleaseControls() {
  const root=document.querySelector('#localReleaseRecovery');if(!root)return;
  const selected=root.querySelector('#localReleaseChoice')?.value;
  for(const control of root.querySelectorAll('button,input,select'))control.disabled=localReleaseBusy;
  const canChange=state.data?.settings.workMode==='build';
  root.querySelector('[data-release-action="register"]').disabled=localReleaseBusy || !canChange;
  root.querySelector('[data-release-action="activate"]').disabled=localReleaseBusy || !canChange || !localReleaseStanding || !selected || selected===localReleaseStanding.activeId;
  root.querySelector('[data-release-action="rollback"]').disabled=localReleaseBusy || !canChange || !localReleaseStanding?.previousId;
  root.setAttribute('aria-busy',String(localReleaseBusy));
  protectHostOnlyControls(root, 'Review local versions on the computer running HexiGrid. Remote devices cannot change its installed code.');
}
function acceptLocalReleaseStanding(value) {
  if(!value || value.appliesOn!=='next-startup' || !Array.isArray(value.releases) || value.releases.length>100)throw Error('Version status was not verified. Load it again.');
  const validId=id=>typeof id==='string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id);
  const ids=new Set();
  for(const r of value.releases){if(!validId(r.id)||typeof r.version!=='string'||ids.has(r.id))throw Error('Version status was not verified. Load it again.');ids.add(r.id);}
  for(const id of [value.activeId,value.previousId])if(id!==null && (!validId(id)||!ids.has(id)))throw Error('Version status was not verified. Load it again.');
  localReleaseStanding=value;
}
document.addEventListener('change',event=>{if(event.target.id==='localReleaseChoice')updateLocalReleaseControls();});
document.addEventListener('click',async event=>{
  const button=event.target.closest('[data-release-action]');if(!button)return;
  event.stopImmediatePropagation();if(localReleaseBusy)return;
  const action=button.dataset.releaseAction;
  const root=document.querySelector('#localReleaseRecovery');
  const id=action==='register'?root.querySelector('#localReleaseId').value.trim():root.querySelector('#localReleaseChoice').value;
  if(action!=='refresh' && action!=='rollback' && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)){root.querySelector('[data-release-feedback]').textContent='Enter a valid prepared folder ID.';return;}
  if(action==='activate' && !localReleaseStanding?.releases.some(r=>r.id===id))return;
  if(action==='rollback' && !localReleaseStanding?.previousId)return;
  localReleaseBusy=true;updateLocalReleaseControls();
  let applied=false, submitted=false;
  try {
    if(action==='refresh')acceptLocalReleaseStanding(await api('/api/local-releases'));
    else {
      const accepted=await modalRequest({title:action==='register'?'Register this reviewed version?':action==='rollback'?'Return to the previous selection?':'Use this version on next startup?',message:action==='register'?`Check prepared folder “${id}” and record its source fingerprint. This does not run the code.`:`Select “${action==='rollback'?localReleaseStanding.previousId:id}” for the next engine startup. Private data stays in place. Verify compatibility with that version before restarting HexiGrid.`,accept:action==='register'?'Register version':action==='rollback'?'Select previous':'Select version'});
      if(!accepted)return;
      submitted=true;
      const result=await api(`/api/local-releases/${action}`,{method:'POST',body:JSON.stringify({...(action==='rollback'?{}:{id}),confirm:true,approved:true})});
      applied=true;acceptLocalReleaseStanding(result.status);
      if(action==='activate' && localReleaseStanding.activeId!==id)throw Error('Selection response did not match. Reload version status before continuing.');
    }
    renderLocalReleaseRecovery();
    root.querySelector('[data-release-feedback]').textContent=action==='refresh'?'Version status loaded.':action==='register'?'Reviewed version registered. It has not been selected.':'Selection saved for the next startup. The running engine has not changed.';
  }catch(error){
    if(action==='refresh' || submitted || applied){localReleaseStanding=null;renderLocalReleaseRecovery();}
    root.querySelector('[data-release-feedback]').textContent=error.message + (submitted?' Load version status before retrying. This request was not retried.':'');
  }finally{localReleaseBusy=false;updateLocalReleaseControls();}
},true);
window.addEventListener('hexigrid:rendered',renderLocalReleaseRecovery);
if (state.data) renderLocalReleaseRecovery();
