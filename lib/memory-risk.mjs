const MAX_CANDIDATE_BYTES = 8 * 1024;
const MAX_WRITE_TEXT_BYTES = 64 * 1024;
const MAX_WRITE_VALID_WHILE_BYTES = 4 * 1024;
const MAX_WRITE_EVIDENCE_BYTES = 8 * 1024;
const MAX_WRITE_VERIFY_BY_BYTES = 64;
// The longest delayed-instruction pattern has three 200-character gaps; 4 KiB
// carries a complete match across an 8 KiB window edge, including UTF-8 width.
const WRITE_RISK_WINDOW_OVERLAP_BYTES = 4 * 1024;
const CANDIDATE_KEYS = new Set(['kind', 'text', 'evidence_excerpt', 'valid_while', 'verify_by']);
const WRITE_CANDIDATE_KEYS = new Set(['text', 'evidence_excerpt', 'valid_while', 'verify_by']);
const DASHES = /[‐‑‒–—―−﹣－]/gu;
const ZERO_WIDTH_AND_FORMAT = /\p{Cf}/gu;
const REASON_ORDER = Object.freeze([
  'delayed_prompt_injection',
  'high_confidence_ssn',
  'payment_card_number'
]);

const DELAYED_CONTEXT = String.raw`(?:next\s+(?:time|session|conversation|chat|interaction)|in\s+(?:(?:the|a)\s+)?future(?:\s+(?:session|conversation|chat|interaction))?|for\s+(?:the\s+)?future\s+(?:sessions?|conversations?|chats?)|later(?:\s+on)?|on\s+(?:(?:the\s+)?(?:next|future))\s+(?:recall|retrieval|interaction|session|conversation|chat)|when\s+(?:(?:this|that|the)\s+)?(?:memory|note|fact|message)\s+(?:is\s+)?(?:recalled|retrieved|loaded|read|used)|when\s+(?:you|(?:the\s+)?(?:assistant|agent|model|ai|chatbot))\s+(?:next\s+)?(?:return|resume|read|see|start)|whenever\s+(?:you|(?:the\s+)?(?:assistant|agent|model|ai|chatbot))\s+(?:read|see|start)|if\s+(?:you|(?:the\s+)?(?:assistant|agent|model|ai|chatbot))\s+(?:are\s+)?(?:asked|prompted|shown|given)(?:\s+again)?\s+(?:later|next|in\s+future))`;
const SAME_SENTENCE = String.raw`[^.!?\n]{0,200}`;
const DELAYED_RESET = new RegExp(String.raw`\b${DELAYED_CONTEXT}\b${SAME_SENTENCE}\b(?:ignore|disregard|override|forget|bypass|disable|skip|circumvent)\b${SAME_SENTENCE}\b(?:all\s+)?(?:the\s+)?(?:system|developer|prior|previous|standing|safety|security|policy|approval|access(?:\s+control)?|tool)\b${SAME_SENTENCE}\b(?:instructions?|prompts?|rules?|checks?|controls?|approvals?)\b`, 'iu');
const DELAYED_BYPASS = new RegExp(String.raw`\b${DELAYED_CONTEXT}\b${SAME_SENTENCE}\b(?:bypass|skip|disable|evade|circumvent|ignore)\b${SAME_SENTENCE}\b(?:owner\s+)?(?:approval|permission|safety|security|policy|access(?:\s+control)?|guard(?:rail)?s?|checks?)\b`, 'iu');
const DELAYED_DISCLOSURE = new RegExp(String.raw`\b${DELAYED_CONTEXT}\b${SAME_SENTENCE}\b(?:reveal|disclose|send|email|upload|export|dump|print|exfiltrate|share|expose|repeat)\b${SAME_SENTENCE}\b(?:the\s+)?(?:hidden\s+)?(?:system\s+prompt|developer\s+prompt|instructions?|secrets?|credentials?|passwords?|api\s+keys?|private\s+(?:files?|data)|confidential\s+data)\b`, 'iu');

const SEPARATED_SSN = /(?<!\d)(\d{3})[-\t ](\d{2})[-\t ](\d{4})(?!\d)/gu;
const LABELED_SSN = /\b(?:ssn|social\s+security(?:\s+number)?)\b\s*(?:number\s*)?(?:(?:is)\s*|[:=#]\s*)?(\d{9})(?!\d)/giu;
const CARD_SEQUENCE = /(?<!\d)\d(?:[ \t-]?\d){12,18}(?!\d)/gu;

function result(reasonCodes) {
  const reasons = Object.freeze(reasonCodes.slice(0, 4));
  return Object.freeze({ disposition: reasons.length ? 'quarantine' : 'allow', reasonCodes: reasons });
}

function candidateText(input) {
  if (typeof input === 'string') {
    if (input.length > MAX_CANDIDATE_BYTES) return { content: [], byteCount: MAX_CANDIDATE_BYTES + 1 };
    return { content: [input], byteCount: Buffer.byteLength(input, 'utf8') };
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;

  try {
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(input);
    if (keys.some(key => typeof key !== 'string' || !CANDIDATE_KEYS.has(key)) || !keys.includes('text')) return null;
    const values = Object.create(null);
    let byteCount = 0;
    let codeUnits = 0;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null;
      const value = descriptor.value;
      if (key === 'verify_by') {
        if (value !== null && typeof value !== 'string') return null;
      } else if (typeof value !== 'string') return null;
      values[key] = value;
      if (typeof value === 'string') {
        codeUnits += value.length;
        if (codeUnits > MAX_CANDIDATE_BYTES) return { content: [], byteCount: MAX_CANDIDATE_BYTES + 1 };
        byteCount += Buffer.byteLength(value, 'utf8');
        if (byteCount > MAX_CANDIDATE_BYTES) return { content: [], byteCount };
      }
    }
    if (!values.text.trim()) return null;
    const content = ['text', 'evidence_excerpt', 'valid_while', 'verify_by']
      .filter(key => typeof values[key] === 'string')
      .map(key => values[key]);
    return { content, byteCount };
  } catch {
    // Proxies, throwing traps and unexpected object shapes fail closed without
    // surfacing or serializing any part of the candidate.
    return null;
  }
}

function normalizeForDetection(text) {
  return text.normalize('NFKC').replace(ZERO_WIDTH_AND_FORMAT, '').replace(DASHES, '-').toLowerCase();
}

function validSsn(digits) {
  const area = Number(digits.slice(0, 3));
  const group = digits.slice(3, 5);
  const serial = digits.slice(5);
  return area !== 0 && area !== 666 && area < 900 && group !== '00' && serial !== '0000';
}

function hasHighConfidenceSsn(text) {
  for (const match of text.matchAll(SEPARATED_SSN)) {
    if (validSsn(match.slice(1).join(''))) return true;
  }
  for (const match of text.matchAll(LABELED_SSN)) {
    if (validSsn(match[1])) return true;
  }
  return false;
}

function passesLuhn(digits) {
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (double) { digit *= 2; if (digit > 9) digit -= 9; }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0 && !/^([0-9])\1+$/.test(digits);
}

function hasSupportedCardPrefix(digits) {
  const length = digits.length;
  if ([13, 16, 19].includes(length) && digits.startsWith('4')) return true;
  if (length === 16) {
    const firstTwo = Number(digits.slice(0, 2));
    const firstFour = Number(digits.slice(0, 4));
    if ((firstTwo >= 51 && firstTwo <= 55) || (firstFour >= 2221 && firstFour <= 2720)) return true;
  }
  if (length === 15 && (digits.startsWith('34') || digits.startsWith('37'))) return true;
  if ([16, 19].includes(length)) {
    const firstThree = Number(digits.slice(0, 3));
    const firstSix = Number(digits.slice(0, 6));
    if (digits.startsWith('6011') || digits.startsWith('65') || (firstThree >= 644 && firstThree <= 649) ||
      (firstSix >= 622126 && firstSix <= 622925)) return true;
  }
  return false;
}

function hasHighConfidencePaymentCard(text) {
  for (const match of text.matchAll(CARD_SEQUENCE)) {
    const digits = match[0].replace(/[ \t-]/g, '');
    if (digits.length >= 13 && digits.length <= 19 && hasSupportedCardPrefix(digits) && passesLuhn(digits)) return true;
  }
  return false;
}

/**
 * Deterministically classify a candidate for local review. This is a bounded
 * heuristic, not a comprehensive safety classifier. It never logs, stores,
 * returns, or sends candidate text anywhere.
 */
export function assessMemoryRisk(input) {
  const candidate = candidateText(input);
  if (!candidate) return result(['unsupported_shape']);
  if (candidate.byteCount > MAX_CANDIDATE_BYTES) return result(['input_too_large']);

  const normalized = candidate.content.map(normalizeForDetection);
  // Quotation marks do not make a delayed instruction harmless when the
  // stored memory is later recalled; scan all content, including examples.
  const instructionText = normalized;
  const findings = new Set();
  if (instructionText.some(text => DELAYED_RESET.test(text) || DELAYED_BYPASS.test(text) || DELAYED_DISCLOSURE.test(text))) {
    findings.add('delayed_prompt_injection');
  }
  const fullText = normalized.join('\n');
  if (hasHighConfidenceSsn(fullText)) findings.add('high_confidence_ssn');
  if (hasHighConfidencePaymentCard(fullText)) findings.add('payment_card_number');
  return result(REASON_ORDER.filter(reason => findings.has(reason)));
}

/**
 * Assess already-validated canonical memory fields using bounded overlapping
 * windows. The 8 KiB primitive remains available for extraction-sized inputs;
 * this variant covers the dated store's larger text cap without treating an
 * ordinary long fact as unsafe solely because it is long.
 */
export function assessMemoryWriteRisk(input) {
  const candidate = memoryWriteContent(input);
  if (!candidate) return result(['unsupported_shape']);
  if (candidate.tooLarge) return result(['input_too_large']);
  const content = ['text', 'valid_while', 'evidence_excerpt', 'verify_by']
    .map(key => candidate.values[key])
    .filter(value => typeof value === 'string' && value.length > 0)
    .join(' ');
  const findings = new Set();
  for (const window of writeRiskWindows(content)) {
    for (const reason of assessMemoryRisk(window).reasonCodes) findings.add(reason);
  }
  return result(REASON_ORDER.filter(reason => findings.has(reason)));
}

function memoryWriteContent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  try {
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(input);
    if (keys.some(key => typeof key !== 'string' || !WRITE_CANDIDATE_KEYS.has(key)) || !keys.includes('text')) return null;
    const limits = { text: MAX_WRITE_TEXT_BYTES, valid_while: MAX_WRITE_VALID_WHILE_BYTES,
      evidence_excerpt: MAX_WRITE_EVIDENCE_BYTES, verify_by: MAX_WRITE_VERIFY_BY_BYTES };
    const values = Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null;
      const value = descriptor.value;
      if (key === 'verify_by' && value === null) { values[key] = null; continue; }
      if (typeof value !== 'string') return null;
      if (Buffer.byteLength(value, 'utf8') > limits[key]) return { tooLarge: true };
      values[key] = value;
    }
    if (!values.text.trim()) return null;
    return { values };
  } catch {
    return null;
  }
}

function* writeRiskWindows(value) {
  // Normalize before windowing so format controls cannot conceal a phrase
  // across a boundary. Every input field is already capped by canonical limits.
  const points = Array.from(normalizeForDetection(value));
  let start = 0;
  while (start < points.length) {
    let end = start;
    let windowBytes = 0;
    while (end < points.length) {
      const bytes = Buffer.byteLength(points[end], 'utf8');
      if (windowBytes + bytes > MAX_CANDIDATE_BYTES) break;
      windowBytes += bytes;
      end += 1;
    }
    if (end === start) return;
    yield points.slice(start, end).join('');
    if (end === points.length) return;

    let nextStart = end;
    let overlapBytes = 0;
    while (nextStart > start) {
      const bytes = Buffer.byteLength(points[nextStart - 1], 'utf8');
      if (overlapBytes + bytes > WRITE_RISK_WINDOW_OVERLAP_BYTES) break;
      overlapBytes += bytes;
      nextStart -= 1;
    }
    start = nextStart;
  }
}

export const memoryRiskLimits = Object.freeze({ maxCandidateBytes: MAX_CANDIDATE_BYTES });
export const memoryWriteRiskLimits = Object.freeze({ textBytes: MAX_WRITE_TEXT_BYTES,
  validWhileBytes: MAX_WRITE_VALID_WHILE_BYTES, evidenceExcerptBytes: MAX_WRITE_EVIDENCE_BYTES,
  verifyByBytes: MAX_WRITE_VERIFY_BY_BYTES, windowBytes: MAX_CANDIDATE_BYTES,
  windowOverlapBytes: WRITE_RISK_WINDOW_OVERLAP_BYTES });
