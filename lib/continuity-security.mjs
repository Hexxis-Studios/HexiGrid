const MAX_SCAN_DEPTH = 40;
const MAX_SCAN_NODES = 100000;

const SENSITIVE_FIELD = /^(?:password|passwd|passphrase|api[_-]?key|secret(?:[_-]?key)?|private[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|bearer[_-]?token|session[_-]?(?:id|token|cookie)|cookie|credential(?:s)?|wallet[_-]?(?:seed|secret)|mnemonic|recovery[_-]?(?:phrase|code))$/i;
const SENSITIVE_PATH = /(?:^|\/)(?:\.env(?:\.[^/]*)?|credentials?(?:\.[^/]*)?|id_(?:rsa|dsa|ecdsa|ed25519)|wallet(?:\.[^/]*)?|cookies?(?:\.[^/]*)?)(?:$|\/)/i;
const EXECUTABLE_PATH = /\.(?:exe|dll|com|scr|msi|msp|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|sh|bash|zsh|fish|app|dmg|pkg|deb|rpm|apk|jar|class|wasm)$/i;

const VALUE_PATTERNS = Object.freeze([
  ['private key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/i],
  ['access token', /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[opusr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AIza[0-9A-Za-z_-]{30,})\b/],
  ['signed token', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/],
  ['authorization value', /\b(?:authorization\s*:\s*|bearer\s+|basic\s+)[A-Za-z0-9+/_.=-]{12,}/i],
  ['credential-like value', /\b(?:password|passwd|passphrase|api[_ -]?key|secret[_ -]?key|access[_ -]?token|refresh[_ -]?token|cookie)\s*[:=]\s*["']?[^\s"']{8,}/i],
  ['embedded URL credential', /\bhttps?:\/\/[^\s/:@]{1,128}:[^\s/@]{4,128}@/i],
  ['wallet recovery phrase', /\b(?:seed phrase|recovery phrase|mnemonic)\s*[:=]\s*(?:[a-z]+\s+){7,23}[a-z]+\b/i]
]);

function safeSegment(value) {
  const text = String(value || '');
  return /^[A-Za-z0-9_.-]{1,80}$/.test(text) ? text : '[field]';
}

function finding(kind, path) {
  return { kind, path: String(path || '$').slice(0, 500) };
}

export function scanContinuitySecrets(value) {
  const findings = [];
  const seen = new Set();
  let nodes = 0;
  const add = (kind, path) => {
    const key = `${kind}:${path}`;
    if (!seen.has(key)) { seen.add(key); findings.push(finding(kind, path)); }
  };
  const visit = (item, path, depth) => {
    nodes += 1;
    if (nodes > MAX_SCAN_NODES) throw new Error('Continuity safety scan stopped because the draft is too complex.');
    if (depth > MAX_SCAN_DEPTH) throw new Error('Continuity safety scan stopped because the draft is nested too deeply.');
    if (typeof item === 'string') {
      for (const [kind, pattern] of VALUE_PATTERNS) if (pattern.test(item)) add(kind, path);
      return;
    }
    if (Array.isArray(item)) { item.forEach((entry, index) => visit(entry, `${path}[${index}]`, depth + 1)); return; }
    if (!item || typeof item !== 'object') return;
    for (const [key, entry] of Object.entries(item)) {
      const childPath = `${path}.${safeSegment(key)}`;
      if (SENSITIVE_FIELD.test(key) && entry !== '' && entry !== null && entry !== undefined) add('sensitive field', childPath);
      visit(entry, childPath, depth + 1);
    }
  };
  visit(value, '$', 0);
  return findings;
}

export function assertContinuitySafe(value) {
  const findings = scanContinuitySecrets(value);
  if (!findings.length) return [];
  const kinds = [...new Set(findings.map((item) => item.kind))].join(', ');
  const error = new Error(`Continuity safety scan rejected ${findings.length} possible secret${findings.length === 1 ? '' : 's'} (${kinds}). Remove them before continuing.`);
  error.code = 'CONTINUITY_SECRET';
  error.findings = findings;
  throw error;
}

export function normalizeContinuityPath(input) {
  const source = String(input || '').replace(/\\/g, '/').trim();
  if (!source || source.length > 240 || source.startsWith('/') || /^[A-Za-z]:\//.test(source) || source.includes('\0')) throw new Error('Continuity content requires a safe relative path.');
  const parts = source.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) throw new Error('Continuity content paths cannot escape the package.');
  const normalized = parts.join('/');
  if (SENSITIVE_PATH.test(normalized)) throw new Error('Continuity content cannot include credential or secret-store files.');
  if (EXECUTABLE_PATH.test(normalized)) throw new Error('Continuity content cannot include executable files.');
  return normalized;
}

export function publicSecretFindings(findings = []) {
  return findings.map((item) => ({ kind: String(item.kind || 'possible secret').slice(0, 80), path: String(item.path || '$').slice(0, 500) }));
}
