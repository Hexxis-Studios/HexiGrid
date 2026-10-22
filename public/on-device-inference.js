(() => {
  const state = {
    module: null,
    moduleAttempt: 0,
    engine: null,
    worker: null,
    modelId: '',
    loading: null,
    progress: null,
    loadAttempt: 0,
    cancelLoad: null,
    loadingModelId: '',
    maintenance: null
  };

  function runtimeError(message, cause) {
    const error = new Error(message);
    if (cause) error.cause = cause;
    return error;
  }

  function failureGuidance(error) {
    const detail = String(error?.message || error || '').slice(0, 800);
    if (/out.?of.?memory|allocation|device lost|gpu|webgpu|shader|buffer size/i.test(detail)) {
      return 'This device could not start the selected model. Try a smaller model, close other GPU-heavy apps, then retry. HexiGrid will not send your prompt to a cloud model automatically.';
    }
    if (/failed to fetch|network|download|http\s*[45]\d\d|connection|cors/i.test(detail)) {
      return 'The browser could not download or prepare the local model. Check your connection and available storage, then retry or choose a smaller model. HexiGrid will not send your prompt to a cloud model automatically.';
    }
    return 'The local model could not prepare a reply. Retry, choose a smaller model, or use another connection. HexiGrid will not send your prompt to a cloud model automatically.';
  }

  async function loadModule() {
    // Browsers retain failed module imports by URL; an explicit retry needs a fresh local URL.
    if (!state.module) state.module = import('/vendor/web-llm.js' + (state.moduleAttempt ? `?retry=${state.moduleAttempt}` : '')).catch((error) => {
      state.module = null;
      state.moduleAttempt++;
      throw runtimeError('The on-device model engine could not load. Restore the connection, then refresh supported models or reload HexiGrid.', error);
    });
    return state.module;
  }

  async function getAdapter() {
    if (!window.isSecureContext && !['localhost', '127.0.0.1'].includes(location.hostname)) return null;
    if (!('gpu' in navigator) || typeof navigator.gpu?.requestAdapter !== 'function') return null;
    try { return await navigator.gpu.requestAdapter(); } catch { return null; }
  }

  async function capabilities() {
    const adapter = await getAdapter();
    return {
      supported: Boolean(adapter),
      webgpu: Boolean(adapter),
      secureContext: Boolean(window.isSecureContext || ['localhost', '127.0.0.1'].includes(location.hostname)),
      browser: navigator.userAgentData?.brands?.map((item) => item.brand).join(', ') || navigator.userAgent,
      reason: adapter ? '' : 'This browser does not expose a usable WebGPU adapter. Use a recent browser with hardware acceleration, or connect a cloud/local model instead.'
    };
  }

  function modelRecord(record) {
    const vram = Number(record.vram_required_MB);
    return {
      id: String(record.model_id),
      label: String(record.model_id).replace(/-MLC$/, '').replace(/-Instruct/, ' Instruct').replace(/-/g, ' '),
      vramRequiredMB: Number.isFinite(vram) && vram > 0 ? Math.round(vram * 100) / 100 : null,
      lowResource: record.low_resource_required === true,
      runtime: 'WebLLM',
      free: true,
      local: true,
      browser: true
    };
  }

  async function supportedModels() {
    const capabilitiesResult = await capabilities();
    if (!capabilitiesResult.supported) return { ...capabilitiesResult, models: [] };
    const webllm = await loadModule();
    return { ...capabilitiesResult, models: (webllm.prebuiltAppConfig?.model_list || []).map(modelRecord) };
  }

  async function hasCachedModel(modelId) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,180}$/.test(String(modelId || ''))) return false;
    const webllm = await loadModule();
    return webllm.hasModelInCache(modelId, webllm.prebuiltAppConfig);
  }

  function progressValue(value) {
    const text = String(value?.text || value?.stage || '').trim();
    const fraction = Number(value?.progress);
    return { text: text.slice(0, 240), progress: Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : null };
  }

  function ensureEngine(modelId, onProgress) {
    if (!modelId) return Promise.reject(runtimeError('Choose an on-device model first.'));
    if (state.maintenance) return state.maintenance.then(() => ensureEngine(modelId, onProgress));
    if (state.loading) return state.loadingModelId === modelId ? state.loading : state.loading.then(() => ensureEngine(modelId, onProgress));
    if (state.engine && state.modelId === modelId) return Promise.resolve(state.engine);
    const attempt = ++state.loadAttempt;
    let worker = null;
    let cancelReject;
    const cancelled = new Promise((_, reject) => { cancelReject = reject; });
    state.cancelLoad = cancelReject;
    state.loadingModelId = modelId;
    state.progress = onProgress || null;
    // Reserve the attempt before asynchronous catalog/engine work so concurrent callers share it.
    const preparing = (async () => {
      const catalog = await supportedModels();
      if (!catalog.supported) throw runtimeError(catalog.reason);
      if (!catalog.models.some((item) => item.id === modelId)) throw runtimeError('That on-device model is not supported by this HexiGrid runtime. Refresh the model list.');
      if (attempt !== state.loadAttempt) throw runtimeError('The on-device model download was cancelled.');
      await unloadCurrentEngine();
      const webllm = await loadModule();
      if (attempt !== state.loadAttempt) throw runtimeError('The on-device model download was cancelled.');
      worker = new Worker('/on-device-worker.js', { type: 'module', name: 'hexigrid-on-device-model' });
      state.worker = worker;
      window.dispatchEvent(new CustomEvent('hexigrid:on-device-load-state', { detail: { state: 'loading', modelId, retry: false, cancel: true } }));
      const engine = await webllm.CreateWebWorkerMLCEngine(worker, modelId, {
        appConfig: webllm.prebuiltAppConfig,
        initProgressCallback: (value) => {
          if (attempt !== state.loadAttempt) return;
          const next = progressValue(value);
          state.progress?.(next);
          window.dispatchEvent(new CustomEvent('hexigrid:on-device-progress', { detail: next }));
        }
      });
      if (attempt !== state.loadAttempt) {
        try { await engine.unload?.(); } catch {}
        throw runtimeError('The on-device model download was cancelled.');
      }
      return engine;
    })();
    state.loading = Promise.race([preparing, cancelled]).then((engine) => {
      if (attempt !== state.loadAttempt) throw runtimeError('The on-device model download was cancelled.');
      state.engine = engine;
      state.modelId = modelId;
      window.dispatchEvent(new CustomEvent('hexigrid:on-device-load-state', { detail: { state: 'ready', retry: false, cancel: false } }));
      return engine;
    }).catch((error) => {
      if (attempt !== state.loadAttempt) throw runtimeError('The on-device model download was cancelled.');
      worker?.terminate();
      state.worker = null;
      state.engine = null;
      state.modelId = '';
      const message = worker ? failureGuidance(error) : String(error?.message || failureGuidance(error));
      window.dispatchEvent(new CustomEvent('hexigrid:on-device-load-state', { detail: { state: 'failed', modelId, retry: true, cancel: false, message } }));
      throw runtimeError(message, error);
    }).finally(() => {
      if (attempt !== state.loadAttempt) return;
      state.loading = null;
      state.loadingModelId = '';
      state.progress = null;
      state.cancelLoad = null;
    });
    return state.loading;
  }

  function cancelLoad() {
    if (!state.loading) return false;
    ++state.loadAttempt;
    state.cancelLoad?.(runtimeError('The on-device model download was cancelled.'));
    state.worker?.terminate();
    state.worker = null;
    state.engine = null;
    state.modelId = '';
    state.loading = null;
    state.loadingModelId = '';
    state.cancelLoad = null;
    state.progress = null;
    window.dispatchEvent(new CustomEvent('hexigrid:on-device-load-state', { detail: { state: 'cancelled', retry: true, cancel: false, message: 'The on-device model download was cancelled. Retry when ready.' } }));
    return true;
  }

  async function complete({ modelId, messages, signal, onProgress }) {
    if (typeof modelId !== 'string' || !modelId.trim()) throw runtimeError('Choose an on-device model first.');
    if (signal?.aborted) throw runtimeError('On-device generation was stopped.');
    if (!Array.isArray(messages) || !messages.length) throw runtimeError('The on-device request did not contain a conversation.');
    await window.hexigridCheckUsageBudget?.();
    if (signal?.aborted) throw runtimeError('On-device generation was stopped.');
    const engine = await ensureEngine(modelId, onProgress);
    if (signal?.aborted) throw runtimeError('On-device generation was stopped.');
    const abort = () => { try { engine.interruptGenerate(); } catch {} };
    if (signal?.aborted) abort();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const stream = await engine.chat.completions.create({ messages, temperature: 0.7, max_tokens: 512, stream: true, stream_options: { include_usage: true } });
      let content = '';
      let usage = null;
      for await (const chunk of stream) {
        if (signal?.aborted) abort();
        content += chunk?.choices?.[0]?.delta?.content || '';
        if (chunk?.usage) usage = chunk.usage;
        onProgress?.({ text: content.slice(-240), progress: null, generating: true });
      }
      if (signal?.aborted) throw runtimeError('On-device generation was stopped.');
      if (!content.trim()) throw runtimeError('The on-device model returned no text. Try a smaller model or another connection.');
      return { content: content.trim().slice(0, 20000), inputTokens: Number.isSafeInteger(usage?.prompt_tokens) ? usage.prompt_tokens : null, outputTokens: Number.isSafeInteger(usage?.completion_tokens) ? usage.completion_tokens : null, modelId };
    } catch (error) {
      if (signal?.aborted) throw runtimeError('On-device generation was stopped.');
      throw runtimeError(failureGuidance(error), error);
    } finally { signal?.removeEventListener('abort', abort); }
  }

  function retryLoad(modelId) {
    if (typeof modelId !== 'string' || !modelId.trim()) throw runtimeError('Choose an on-device model first.');
    return ensureEngine(modelId);
  }

  async function unloadCurrentEngine() {
    const engine = state.engine;
    const worker = state.worker;
    state.engine = null;
    state.worker = null;
    state.modelId = '';
    try { await engine?.unload?.(); } catch {}
    worker?.terminate();
  }

  function maintainEngine(operation) {
    const pending = (state.maintenance || Promise.resolve()).catch(() => {}).then(operation);
    state.maintenance = pending;
    return pending.finally(() => { if (state.maintenance === pending) state.maintenance = null; });
  }

  function unload() {
    cancelLoad();
    return maintainEngine(unloadCurrentEngine);
  }

  function clearCache(modelId) {
    if (!modelId || !/^[A-Za-z0-9][A-Za-z0-9._-]{1,180}$/.test(modelId)) return Promise.reject(runtimeError('The browser model identifier is invalid.'));
    if (state.loadingModelId === modelId) cancelLoad();
    return maintainEngine(async () => {
      const webllm = await loadModule();
      if (state.modelId === modelId) await unloadCurrentEngine();
      await webllm.deleteModelAllInfoInCache(modelId, webllm.prebuiltAppConfig);
    });
  }

  window.HexiGridOnDevice = Object.freeze({ capabilities, supportedModels, hasCachedModel, complete, unload, clearCache, cancelLoad, retryLoad, retry: (options) => complete(options), activeModel: () => state.modelId, failureGuidance });
})();
