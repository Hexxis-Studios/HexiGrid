const plain = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function malformed() {
  throw new Error('The MCP server returned a malformed tool result.');
}

function optionalRecord(record, key) {
  if (Object.hasOwn(record, key) && !plain(record[key])) malformed();
}

function annotations(block) {
  optionalRecord(block, 'annotations');
  const value = block.annotations;
  if (!value) return;
  if (Object.hasOwn(value, 'audience') && (!Array.isArray(value.audience) || value.audience.some((role) => role !== 'user' && role !== 'assistant'))) malformed();
  if (Object.hasOwn(value, 'priority') && (typeof value.priority !== 'number' || !Number.isFinite(value.priority) || value.priority < 0 || value.priority > 1)) malformed();
  if (Object.hasOwn(value, 'lastModified') && typeof value.lastModified !== 'string') malformed();
}

function common(block) {
  optionalRecord(block, '_meta');
  annotations(block);
}

function stringField(value, key) {
  return typeof value[key] === 'string';
}

function contentBlock(block) {
  if (!plain(block) || typeof block.type !== 'string') malformed();
  common(block);
  switch (block.type) {
    case 'text':
      if (!stringField(block, 'text')) malformed();
      return;
    case 'image':
    case 'audio':
      if (!stringField(block, 'data') || !stringField(block, 'mimeType')) malformed();
      return;
    case 'resource_link':
      if (!stringField(block, 'name') || !stringField(block, 'uri')) malformed();
      for (const key of ['title', 'description', 'mimeType']) if (Object.hasOwn(block, key) && !stringField(block, key)) malformed();
      if (Object.hasOwn(block, 'size') && (!Number.isInteger(block.size) || block.size < 0)) malformed();
      if (Object.hasOwn(block, 'icons')) {
        if (!Array.isArray(block.icons)) malformed();
        for (const icon of block.icons) {
          if (!plain(icon) || !stringField(icon, 'src')) malformed();
          for (const key of ['mimeType']) if (Object.hasOwn(icon, key) && !stringField(icon, key)) malformed();
          if (Object.hasOwn(icon, 'sizes') && (!Array.isArray(icon.sizes) || icon.sizes.some((size) => typeof size !== 'string'))) malformed();
          if (Object.hasOwn(icon, 'theme') && icon.theme !== 'light' && icon.theme !== 'dark') malformed();
        }
      }
      return;
    case 'resource': {
      const resource = block.resource;
      if (!plain(resource) || !stringField(resource, 'uri')) malformed();
      if (Object.hasOwn(resource, 'mimeType') && !stringField(resource, 'mimeType')) malformed();
      optionalRecord(resource, '_meta');
      const hasText = Object.hasOwn(resource, 'text'), hasBlob = Object.hasOwn(resource, 'blob');
      if (hasText === hasBlob || (hasText && typeof resource.text !== 'string') || (hasBlob && typeof resource.blob !== 'string')) malformed();
      return;
    }
    default:
      malformed();
  }
}

export function validateMcpCallToolResult(result) {
  if (!plain(result) || !Array.isArray(result.content)) malformed();
  optionalRecord(result, 'structuredContent');
  optionalRecord(result, '_meta');
  if (Object.hasOwn(result, 'isError') && typeof result.isError !== 'boolean') malformed();
  for (const block of result.content) contentBlock(block);
  return result;
}
