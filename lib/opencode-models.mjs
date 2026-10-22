function readJsonObject(lines, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  const parts = [];
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    parts.push(line);
    for (const character of line) {
      if (escaped) { escaped = false; continue; }
      if (character === '\\' && inString) { escaped = true; continue; }
      if (character === '"') { inString = !inString; continue; }
      if (!inString && character === '{') depth += 1;
      if (!inString && character === '}') depth -= 1;
    }
    if (depth === 0 && parts.join('').trim().startsWith('{')) return { value: JSON.parse(parts.join('\n')), end: index };
  }
  throw new Error('OpenCode returned incomplete model metadata.');
}

export function parseOpenCodeModels(output) {
  const lines = String(output || '').split(/\r?\n/);
  const models = [];
  for (let index = 0; index < lines.length; index += 1) {
    const id = lines[index].trim();
    if (!/^[a-z0-9._-]+\/[a-z0-9._-]+$/i.test(id) || lines[index + 1]?.trim() !== '{') continue;
    try {
      const parsed = readJsonObject(lines, index + 1);
      const metadata = parsed.value;
      const inputCost = metadata.cost?.input;
      const outputCost = metadata.cost?.output;
      // Missing/coerced prices must never authorize the free-only route.
      const costKnown = typeof inputCost === 'number' && Number.isFinite(inputCost) && inputCost >= 0
        && typeof outputCost === 'number' && Number.isFinite(outputCost) && outputCost >= 0;
      models.push({
        id,
        label: String(metadata.name || metadata.id || id.split('/').pop()).slice(0, 160),
        provider: String(metadata.providerID || id.split('/')[0]).slice(0, 80),
        free: costKnown && inputCost === 0 && outputCost === 0,
        pricing: costKnown ? { input: inputCost, output: outputCost } : null,
        context: Number.isSafeInteger(metadata.limit?.context) ? metadata.limit.context : null,
        capabilities: {
          reasoning: metadata.capabilities?.reasoning === true,
          tools: metadata.capabilities?.toolcall === true,
          images: metadata.capabilities?.input?.image === true
        },
        status: metadata.status === 'deprecated' ? 'deprecated' : 'available'
      });
      index = parsed.end;
    } catch { /* Ignore one malformed catalog entry without inventing a replacement. */ }
  }
  return [...new Map(models.map((model) => [model.id, model])).values()];
}
