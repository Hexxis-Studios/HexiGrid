// Isolated-world adapter: interact only with the explicitly selected chat.
// Inspect only the selected log for submission receipts; never inspect cookies
// or account sessions, and never send conversation history back to the host.
if (!globalThis.hexigridCallChatAttached) {
  globalThis.hexigridCallChatAttached = true;
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message.type !== 'call-utterance') return false;
    const { selection, turn } = message;
    const composer = document.querySelector('textarea[aria-label="Message"]');
    if (location.href !== selection.url || !composer || composer.value.trim()) {
      respond({ untouched: true }); return false;
    }
    // This connector is bound to the paired owner. Call/turn routing and
    // authorization stay in the connector, not in each visible utterance.
    const text = `Caller ID: paired-owner\n\n${turn.text}`;
    const normalizedText = text.replace(/\s+/g, ' ').trim();
    const occurrences = () => (document.querySelector('[role="log"]')?.innerText || '')
      .replace(/\s+/g, ' ').split(normalizedText).length - 1;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(composer, text);
    composer.dispatchEvent(new Event('input', { bubbles: true }));
    // Muse creates Send only after React processes the draft. Observe that
    // update instead of holding a button from the empty composer.
    let preparationTimer;
    let preparationFinished = false;
    const preparation = new MutationObserver(submitWhenReady);
    function submitWhenReady() {
      if (preparationFinished) return;
      if (location.href !== selection.url || composer.value !== text) {
        preparationFinished = true;
        preparation.disconnect(); clearTimeout(preparationTimer);
        respond({ untouched: true }); return;
      }
      const sendButton = document.querySelector('button[aria-label="Send"]');
      if (!sendButton || sendButton.disabled) return;
      preparationFinished = true;
      preparation.disconnect(); clearTimeout(preparationTimer);
      const previousOccurrences = occurrences();
      const observer = new MutationObserver(() => {
        if (occurrences() > previousOccurrences && composer.value === '') {
          observer.disconnect(); clearTimeout(timer); respond({ submitted: true });
        }
      });
      const timer = setTimeout(() => { observer.disconnect(); respond({ submitted: false }); }, 8000);
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      sendButton.click();
    }
    preparation.observe(document.body, { childList: true, subtree: true, attributes: true });
    preparationTimer = setTimeout(() => {
      preparationFinished = true;
      preparation.disconnect(); respond({ untouched: true });
    }, 2000);
    queueMicrotask(submitWhenReady);
    return true;
  });
}
