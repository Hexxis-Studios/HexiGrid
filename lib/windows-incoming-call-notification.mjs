import nodeNotifier from 'node-notifier';
import { fileURLToPath } from 'node:url';

export const HEXIGRID_WINDOWS_TOAST_APP_ID = 'Hexxis.Studios.HexiGrid';
const HEXIGRID_TOAST_ICON = fileURLToPath(new URL('../public/icon-192.png', import.meta.url));

function safeCallerName(value) {
  const name = String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return (name || 'Your paired agent').slice(0, 80);
}

function normalizeAction(response, metadata) {
  // node-notifier's WindowsToaster passes its parsed result object as the
  // second callback argument (including activationType/button). Keep string
  // handling for other notifier implementations and existing adapters.
  const value = metadata?.activationType || response?.activationType || response?.button || response;
  const action = String(value || '').trim().toLowerCase();
  if (action === 'allow' || action === 'accept') return 'accept';
  if (action === 'deny' || action === 'decline') return 'decline';
  return '';
}

/**
 * Show a non-focusing Windows toast for an agent-originated call. The OS
 * callback carries only the action and this notification's captured call ID;
 * the caller revalidates the live bridge, Link grants, policy and call state.
 */
export function createWindowsIncomingCallNotifier({
  platform = process.platform,
  notifier = nodeNotifier,
  onAction = async () => {},
  onError = () => {}
} = {}) {
  let reporter;
  if (platform === 'win32') {
    try { reporter = new notifier.WindowsToaster({ withFallback: false }); }
    catch (error) { onError(error); }
  }

  return {
    available: Boolean(reporter),
    notify(voiceCall) {
      if (!reporter || voiceCall?.direction !== 'agent-to-owner' || voiceCall?.status !== 'ringing' || !voiceCall?.id) return false;
      let handled = false;
      try {
        reporter.notify({
          title: 'HexiGrid',
          message: `${safeCallerName(voiceCall.callerName)} wants to call you.`,
          icon: HEXIGRID_TOAST_ICON,
          actions: ['Allow', 'Deny'],
          appID: HEXIGRID_WINDOWS_TOAST_APP_ID,
        timeout: 45,
          sound: true
        }, (error, response, metadata) => {
          if (error) {
            handled = true;
            onError(error, { callId: String(voiceCall.id) });
            return;
          }
          if (handled) {
            return;
          }
          const action = normalizeAction(response, metadata);
          if (!action) return;
          handled = true;
          Promise.resolve(onAction({ action, callId: String(voiceCall.id) }))
            .catch(actionError => onError(actionError, { callId: String(voiceCall.id) }));
        });
        return true;
      } catch (error) {
        onError(error, { callId: String(voiceCall.id) });
        return false;
      }
    }
  };
}
