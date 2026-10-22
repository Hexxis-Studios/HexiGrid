/* Permission-aware local files and terminal. */
let workspaceSavedDraft = { path: document.querySelector('#workspacePathInput').value, content: document.querySelector('#workspaceEditor').value };
let workspaceFileOpened = false;
let workspaceOpenSequence = 0;
let workspaceSaveConflict = false;
let workspaceFileGeneration = 0;

function workspaceDraftChanged() {
  return workspaceSavedDraft && ($('#workspacePathInput').value !== workspaceSavedDraft.path || $('#workspaceEditor').value !== workspaceSavedDraft.content);
}

function renderWorkspaceDraftStatus() {
  const changed = workspaceDraftChanged();
  const saveButton = document.querySelector('[data-action="save-workspace-file"]');
  if (saveButton) saveButton.disabled = workspaceSaveConflict || !changed;
  $('#workspaceDraftStatus').textContent = workspaceSaveConflict ? 'File changed on disk. Your draft is kept. Reload file to review the latest version.' : changed ? 'Unsaved changes' : workspaceFileOpened ? 'No unsaved changes' : 'Open a file or enter a new path';
}

async function loadWorkspace(folder = state.workspaceFolder, openFirst = false) {
  try {
    const response = await api(`/api/workspace/tree?path=${encodeURIComponent(folder)}`);
    state.workspaceFolder = response.path;
    state.workspaceLoaded = true;
    $("#workspaceFolder").textContent = response.path;
    $("#workspaceFiles").innerHTML = response.entries.map((entry) => `<button class="file-item ${entry.type}" data-action="${entry.type === "directory" ? "open-workspace-folder" : "open-workspace-file"}" data-path="${escapeHtml(entry.path)}"><span data-icon="${entry.type === 'directory' ? 'folder' : 'file'}"></span><strong>${escapeHtml(entry.name)}</strong></button>`).join("") || `<div class="empty-state">This folder is empty.</div>`;
    if (openFirst) {
      const firstFile = response.entries.find((entry) => entry.type === "file");
      if (firstFile) await openWorkspaceFile(firstFile.path);
    }
  } catch (error) { notify(error.message, true); }
}

async function openWorkspaceFile(filePath) {
  const sequence = ++workspaceOpenSequence;
  if (workspaceDraftChanged() && !await userConfirm('Discard unsaved edits?', 'Loading a file replaces the current editor draft, including when you reload the same file. Cancel to keep your edits.', 'Discard edits')) return;
  if (sequence !== workspaceOpenSequence) return;
  try {
    const response = await api(`/api/workspace/file?path=${encodeURIComponent(filePath)}`);
    if (sequence !== workspaceOpenSequence) return;
    $("#workspacePathInput").value = response.path;
    $("#workspaceEditor").value = response.content;
    workspaceSavedDraft = { path: response.path, content: response.content, sha256:response.sha256 };
    ++workspaceFileGeneration;
    workspaceFileOpened = true;
    workspaceSaveConflict = false;
    renderWorkspaceDraftStatus();
  } catch (error) { notify(error.message, true); }
}

async function requestWorkspaceSave(approved = false, draft = { path: $('#workspacePathInput').value, content: $('#workspaceEditor').value }) {
  return api("/api/workspace/file", { method: "PUT", body: JSON.stringify({ ...draft, approved }) });
}

async function saveWorkspaceFile() {
  const draft = { path: $('#workspacePathInput').value, content: $('#workspaceEditor').value };
  const fileGeneration = workspaceFileGeneration;
  const sameFileView = () => workspaceFileGeneration === fileGeneration && $('#workspacePathInput').value === draft.path;
  if (workspaceFileOpened && draft.path === workspaceSavedDraft.path) draft.expectedSha256 = workspaceSavedDraft.sha256 || '';
  else draft.createOnly = true;
  const saved = async response => {
    if (sameFileView()) {
      workspaceSavedDraft = { path: response.path, content: draft.content, sha256:response.sha256 };
      workspaceFileOpened = true;
      workspaceSaveConflict = false;
      renderWorkspaceDraftStatus();
    }
    notify(`${response.path} saved.`);
    await loadWorkspace(state.workspaceFolder);
  };
  const failed = error => {
    if (sameFileView() && ['workspace_file_changed','workspace_file_exists','workspace_expected_hash_required'].includes(error.body?.code)) { workspaceSaveConflict = true; renderWorkspaceDraftStatus(); }
    notify(`${draft.path}: ${error.message}`, true);
  };
  try {
    await saved(await requestWorkspaceSave(false, draft));
  } catch (error) {
    if (error.body?.approvalRequired && await userConfirm("Approve this save?", error.message, "Approve once", true)) {
      try { await saved(await requestWorkspaceSave(true, draft)); }
      catch (approvedError) { failed(approvedError); }
    } else failed(error);
  }
}

for (const id of ['workspaceEditor', 'workspacePathInput']) document.querySelector('#' + id).addEventListener('input', () => {
  ++workspaceOpenSequence;
  renderWorkspaceDraftStatus();
});

async function runTerminal(event, approved = false, originalCommand = "") {
  event?.preventDefault();
  const input = $("#terminalInput");
  const command = originalCommand || input.value.trim();
  if (!command) return;
  input.value = "";
  const output = $("#terminalOutput");
  output.textContent += `\n\n› ${command}\n`;
  try {
    const response = await api("/api/workspace/command", { method: "POST", body: JSON.stringify({ command, approved }) });
    output.textContent += response.output;
    await loadWorkspace(state.workspaceFolder);
  } catch (error) {
    if (error.body?.approvalRequired && await userConfirm("Approve this command?", `${error.message}\n\n${command}`, "Approve once", true)) return runTerminal(null, true, command);
    output.textContent += error.body?.output || error.message;
  } finally { output.scrollTop = output.scrollHeight; input.focus(); }
}
