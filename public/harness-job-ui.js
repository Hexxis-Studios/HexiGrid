(() => {
  // Integration: reuse the host API/modal and native DOM controls; no external UI component is needed here.
  let busy = false;
  let currentJob = null;
  let recentJobs = [];
  let selectedRecentJobId = '';
  // Volatile only: retain the same key after uncertain replies; never use browser storage.
  let retryAttempt = null;

  const node = (id) => document.querySelector(`#${id}`);
  const agentLinks = () => state.data?.agentLinks || [];
  function localAgents() {
    const linked = new Set(agentLinks().map((link) => link.agentId));
    return (state.data?.agents || []).filter((agent) => agent.transport === 'local-opencode' && !linked.has(agent.id));
  }

  function newClientJobId() {
    const source = window.crypto;
    if (source?.randomUUID) return source.randomUUID();
    if (source?.getRandomValues) {
      const bytes = source.getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
    throw new Error('Secure random IDs are unavailable in this browser.');
  }

  function attemptFor(agentId, prompt) {
    if (retryAttempt?.agentId === agentId && retryAttempt.prompt === prompt) return retryAttempt;
    retryAttempt = { agentId, prompt, clientJobId: newClientJobId(), approved: false };
    return retryAttempt;
  }

  function jobSnapshot(job, previous = null) {
    return {
      id: job.id,
      agentId: job.agentId || previous?.agentId || '',
      status: typeof job.status === 'string' ? job.status : 'unknown',
      cancellationRequested: job.cancellationRequested === true,
      error: typeof job.error === 'string' ? job.error : '',
      output: typeof job.output === 'string' ? job.output : previous?.output || ''
    };
  }

  function selectedRecentJob() {
    return recentJobs.find((job) => job.id === node('harnessJobRecent').value) || null;
  }

  function renderRecentJobs() {
    const select = node('harnessJobRecent');
    const previousSelection = selectedRecentJobId || select.value;
    select.replaceChildren();
    if (!recentJobs.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'Load recent jobs to choose';
      select.append(option);
      selectedRecentJobId = '';
      return;
    }
    for (const job of recentJobs) {
      const option = document.createElement('option');
      option.value = job.id;
      const agent = localAgents().find((item) => item.id === job.agentId);
      const label = agent ? (typeof agentListLabel === 'function' ? agentListLabel(agent) : agent.name || agent.id) : 'Local agent';
      const created = job.createdAt ? new Date(job.createdAt).toLocaleString() : 'Recent';
      option.textContent = `${label} · ${job.status} · ${created}`;
      select.append(option);
    }
    selectedRecentJobId = recentJobs.some((job) => job.id === previousSelection) ? previousSelection : recentJobs[0].id;
    select.value = selectedRecentJobId;
  }

  function render() {
    if (!node('harnessJobPanel')) return;
    const select = node('harnessJobAgent');
    const agents = localAgents();
    const previousSelection = select.value;
    select.replaceChildren();
    if (!agents.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'Add a local agent first';
      select.append(option);
    } else {
      for (const agent of agents) {
        const option = document.createElement('option');
        option.value = agent.id;
        const label = typeof agentListLabel === 'function' ? agentListLabel(agent) : agent.name || agent.id;
        option.textContent = `${label} · Local agent`;
        select.append(option);
      }
      select.value = agents.some((agent) => agent.id === previousSelection) ? previousSelection : agents[0].id;
    }

    const prompt = node('harnessJobPrompt');
    const active = Boolean(currentJob);
    const processing = active && ['queued', 'running'].includes(currentJob.status);
    renderRecentJobs();
    select.disabled = busy || !agents.length;
    prompt.disabled = busy;
    node('harnessJobRun').disabled = busy || !agents.length || processing;
    node('harnessJobCheck').disabled = busy || !active;
    node('harnessJobStop').disabled = busy || !processing || currentJob.cancellationRequested;
    node('harnessJobLoadRecent').disabled = busy;
    node('harnessJobRecent').disabled = busy || !recentJobs.length;
    node('harnessJobOpenRecent').disabled = busy || !selectedRecentJob() || !agents.some((agent) => agent.id === selectedRecentJob()?.agentId);

    const currentAgent = agents.find((agent) => agent.id === currentJob?.agentId);
    const label = currentAgent ? (typeof agentListLabel === 'function' ? agentListLabel(currentAgent) : currentAgent.name || currentAgent.id) : 'Local agent';
    node('harnessJobStatus').textContent = active ? `Current job for ${label}: ${currentJob.status}` : 'No current job selected. After reload, load recent jobs and open one manually.';
    node('harnessJobError').textContent = currentJob?.error || '';
    node('harnessJobOutput').textContent = currentJob?.output || '';
  }

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    const agentId = node('harnessJobAgent').value;
    const prompt = node('harnessJobPrompt').value;
    if (!agentId || !prompt.trim() || prompt.length > 8000) {
      node('harnessJobFeedback').textContent = 'Choose a local agent and enter a prompt of up to 8,000 characters. Your draft is kept.';
      return;
    }
    if (currentJob && ['queued', 'running'].includes(currentJob.status)) return;
    let attempt;
    try { attempt = attemptFor(agentId, prompt); }
    catch (error) { node('harnessJobFeedback').textContent = error.message; return; }
    const body = { agentId: attempt.agentId, prompt: attempt.prompt, clientJobId: attempt.clientJobId,
      ...(attempt.approved ? { approved: true } : {}) };

    busy = true;
    node('harnessJobFeedback').textContent = 'Submitting one bounded job…';
    render();
    try {
      let result;
      try {
        result = await api('/api/harness-jobs', { method: 'POST', body: JSON.stringify(body) });
      } catch (error) {
        if (!error.body?.approvalRequired || attempt.approved || typeof window.hexigridModal !== 'function') throw error;
        const confirmed = await window.hexigridModal({ title: 'Approve one harness job?', message: error.message, accept: 'Approve once', danger: true });
        if (!confirmed) {
          node('harnessJobFeedback').textContent = 'Approval cancelled. Your draft is kept; no approved request was sent.';
          return;
        }
        attempt.approved = true;
        result = await api('/api/harness-jobs', { method: 'POST', body: JSON.stringify({ ...body, approved: true }) });
      }
      const job = result?.job;
      if (!job || typeof job.id !== 'string' || !job.id || job.agentId !== attempt.agentId) throw new Error('The response did not include this agent’s job to track. Retry this draft to reuse its request ID.');
      currentJob = jobSnapshot(job);
      retryAttempt = null;
      node('harnessJobFeedback').textContent = ['queued', 'running'].includes(currentJob.status)
        ? `Accepted. Current status is ${currentJob.status}; acceptance does not mean the job is complete. Check progress when you choose.`
        : `Request accepted. Current status is ${currentJob.status}; check progress to load any final output.`;
    } catch (error) {
      node('harnessJobFeedback').textContent = `${error.message || 'The request failed.'} Your draft is kept; retrying the same agent and prompt reuses its request ID.`;
    } finally {
      busy = false;
      render();
    }
  }

  async function checkProgress() {
    if (busy || !currentJob) return;
    const expectedId = currentJob.id;
    busy = true;
    node('harnessJobFeedback').textContent = 'Checking the current job…';
    render();
    try {
      const result = await api(`/api/harness-jobs/${encodeURIComponent(expectedId)}`);
      if (!result?.job || result.job.id !== expectedId) throw new Error('The server returned a different job. The tracked job was kept.');
      currentJob = jobSnapshot(result.job, currentJob);
      node('harnessJobFeedback').textContent = 'Progress updated.';
    } catch (error) {
      node('harnessJobFeedback').textContent = `Progress check failed: ${error.message || 'unknown error'}. The tracked job was kept.`;
    } finally {
      busy = false;
      render();
    }
  }

  async function loadRecentJobs() {
    if (busy) return;
    busy = true;
    node('harnessJobFeedback').textContent = 'Loading recent local jobs…';
    render();
    try {
      const result = await api('/api/harness-jobs');
      if (!Array.isArray(result?.jobs)) throw new Error('The recent jobs list was unavailable.');
      const eligible = new Set(localAgents().map((agent) => agent.id));
      recentJobs = result.jobs.filter((job) => job && typeof job.id === 'string' && job.id &&
        typeof job.agentId === 'string' && eligible.has(job.agentId)).slice(0, 20);
      selectedRecentJobId = recentJobs[0]?.id || '';
      node('harnessJobFeedback').textContent = recentJobs.length
        ? `Loaded ${recentJobs.length} recent local job${recentJobs.length === 1 ? '' : 's'}. Choose one and open it to recover its current result; nothing was rerun.`
        : 'No recent owner jobs are available for the current local agents. Jobs are retained for up to 30 minutes.';
    } catch (error) {
      recentJobs = [];
      selectedRecentJobId = '';
      node('harnessJobFeedback').textContent = `Recent jobs are unavailable: ${error.message || 'unknown error'}. Try loading again later.`;
    } finally {
      busy = false;
      render();
    }
  }

  async function openSelectedRecentJob() {
    if (busy) return;
    const selected = selectedRecentJob();
    if (!selected || !localAgents().some((agent) => agent.id === selected.agentId)) {
      node('harnessJobFeedback').textContent = 'The selected job is unavailable for the current local agent profile. Load recent jobs again.';
      return;
    }
    const expectedId = selected.id;
    const expectedAgentId = selected.agentId;
    busy = true;
    node('harnessJobFeedback').textContent = 'Opening the selected saved job…';
    render();
    try {
      const result = await api(`/api/harness-jobs/${encodeURIComponent(expectedId)}`);
      if (!result?.job || result.job.id !== expectedId || result.job.agentId !== expectedAgentId) {
        throw new Error('The server response did not match the selected job and agent.');
      }
      if (!localAgents().some((agent) => agent.id === expectedAgentId)) {
        throw new Error('The selected job’s agent is no longer an unlinked local agent.');
      }
      currentJob = jobSnapshot(result.job);
      node('harnessJobFeedback').textContent = 'Saved job opened. Its status and output were restored; it was not rerun. Check progress manually or stop it if it is still running.';
    } catch (error) {
      node('harnessJobFeedback').textContent = `Could not open the selected job: ${error.message || 'unknown error'}. It may have expired or become unavailable; no job was created.`;
    } finally {
      busy = false;
      render();
    }
  }

  async function stopCurrentJob() {
    if (busy || !currentJob || !['queued', 'running'].includes(currentJob.status)) return;
    const expectedId = currentJob.id;
    busy = true;
    node('harnessJobFeedback').textContent = 'Stopping the current job…';
    render();
    try {
      const result = await api(`/api/harness-jobs/${encodeURIComponent(expectedId)}/cancel`, { method: 'POST', body: '{}' });
      if (!result?.job || result.job.id !== expectedId) throw new Error('The server returned a different job. The tracked job was kept.');
      currentJob = jobSnapshot(result.job, currentJob);
      node('harnessJobFeedback').textContent = `Stop request returned status ${currentJob.status}.`;
    } catch (error) {
      node('harnessJobFeedback').textContent = `Stop failed: ${error.message || 'unknown error'}. The tracked job was kept.`;
    } finally {
      busy = false;
      render();
    }
  }

  node('harnessJobForm')?.addEventListener('submit', submit);
  node('harnessJobCheck')?.addEventListener('click', checkProgress);
  node('harnessJobStop')?.addEventListener('click', stopCurrentJob);
  node('harnessJobLoadRecent')?.addEventListener('click', loadRecentJobs);
  node('harnessJobRecent')?.addEventListener('change', () => {
    selectedRecentJobId = node('harnessJobRecent').value;
    render();
  });
  node('harnessJobOpenRecent')?.addEventListener('click', openSelectedRecentJob);
  window.HexiGridHarnessJobUi = { render };
  render();
})();
