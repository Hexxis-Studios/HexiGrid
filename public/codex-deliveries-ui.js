(() => {
  const labels = { queued: 'Waiting to send', submitting: 'Submitting', 'awaiting-reply': 'Waiting for reply', 'delivery-uncertain': 'Inspect target before retrying', 'local-thread': 'Claimed by local task' };
  window.HexiGridCodexDeliveries = {
    attach(root, { request, refresh }) {
      let busy = false;
      root.addEventListener('click', async event => {
        const cancel = event.target.closest('[data-keep-delivery]');
        if (cancel) { const row = cancel.closest('article'); row.querySelector('[data-review-delivery]').disabled = false; cancel.parentElement.remove(); return; }
        const review = event.target.closest('[data-review-delivery]');
        if (review && !busy) {
          review.disabled = true;
          const controls = root.ownerDocument.createElement('div'); controls.className = 'delivery-review-actions';
          const confirm = root.ownerDocument.createElement('button'); confirm.type = 'button'; confirm.dataset.dismissDelivery = review.dataset.reviewDelivery; confirm.textContent = 'Confirm dismissal';
          const keep = root.ownerDocument.createElement('button'); keep.type = 'button'; keep.dataset.keepDelivery = ''; keep.textContent = 'Keep delivery';
          controls.append(confirm, keep); review.parentElement.append(controls); return;
        }
        const button = event.target.closest('[data-dismiss-delivery]');
        if (!button || busy) return;
        busy = true; button.disabled = true;
        const status = root.querySelector('[data-delivery-feedback]');
        try {
          await request(`/api/codex-deliveries/${encodeURIComponent(button.dataset.dismissDelivery)}/dismiss`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'dismiss', expectedDelivery: 'delivery-uncertain', approved: true }) });
          await refresh();
        } catch (error) { status.textContent = error.message; button.disabled = false; }
        finally { busy = false; }
      });
      return {
        render(deliveries = []) {
          root.replaceChildren();
          const document = root.ownerDocument;
          const status = document.createElement('p'); status.dataset.deliveryFeedback = ''; status.setAttribute('role', 'status');
          status.textContent = deliveries.length ? `${deliveries.length} pending deliveries. Held messages are never resent automatically.` : 'No pending Codex deliveries.';
          root.append(status);
          for (const item of deliveries) {
            const row = document.createElement('article'); row.className = 'record panel codex-delivery-row';
            const title = document.createElement('strong'); title.textContent = labels[item.delivery] || 'Pending review'; row.append(title);
            const target = document.createElement('p'); target.textContent = `Conversation: ${item.threadTitle || item.threadName || item.threadId || 'Default conversation'} · ${item.createdAt || ''}`; row.append(target);
            const id = document.createElement('code'); id.textContent = item.id; row.append(id);
            if (item.reviewRequired) {
              const note = document.createElement('p'); note.textContent = 'Delivery may already have happened. Inspect the target first. Dismiss removes pending reply tracking only; it never resends the message or stops Codex work.'; row.append(note);
              const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary-button'; button.dataset.reviewDelivery = item.id; button.textContent = 'Review held delivery'; row.append(button);
            }
            root.append(row);
          }
        }
      };
    }
  };
})();
