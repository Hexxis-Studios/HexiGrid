(() => {
  const STORAGE_KEY = 'hexigrid-button-sounds';
  let audioContext = null;

  function soundsEnabled() {
    return window.HexiGridPreferences.getItem(STORAGE_KEY) !== 'off';
  }

  function setSoundsEnabled(enabled, { preview = false } = {}) {
    window.HexiGridPreferences.setItem(STORAGE_KEY, enabled ? 'on' : 'off');
    if (enabled && preview) playClick();
  }

  function makeClick(context) {
    const startedAt = context.currentTime;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(540, startedAt);
    oscillator.frequency.exponentialRampToValueAtTime(360, startedAt + 0.035);
    gain.gain.setValueAtTime(0.0001, startedAt);
    gain.gain.exponentialRampToValueAtTime(0.022, startedAt + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, startedAt + 0.045);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(startedAt);
    oscillator.stop(startedAt + 0.05);
  }

  function makeFacetTick(context, startedAt, index, count) {
    const oscillator = context.createOscillator();
    const overtone = context.createOscillator();
    const gain = context.createGain();
    const overtoneGain = context.createGain();
    const progress = count > 1 ? index / (count - 1) : 1;
    const base = 460 + progress * 310 + (index % 4) * 24;
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(base * 1.72, startedAt);
    oscillator.frequency.exponentialRampToValueAtTime(base, startedAt + .052);
    overtone.type = 'triangle';
    overtone.frequency.setValueAtTime(base * 2.18, startedAt);
    overtone.frequency.exponentialRampToValueAtTime(base * 1.42, startedAt + .032);
    gain.gain.setValueAtTime(.0001, startedAt);
    gain.gain.exponentialRampToValueAtTime(.0105, startedAt + .004);
    gain.gain.exponentialRampToValueAtTime(.0001, startedAt + .072);
    overtoneGain.gain.setValueAtTime(.0001, startedAt);
    overtoneGain.gain.exponentialRampToValueAtTime(.0038, startedAt + .003);
    overtoneGain.gain.exponentialRampToValueAtTime(.0001, startedAt + .038);
    oscillator.connect(gain);
    overtone.connect(overtoneGain);
    gain.connect(context.destination);
    overtoneGain.connect(context.destination);
    oscillator.start(startedAt);
    overtone.start(startedAt);
    oscillator.stop(startedAt + .08);
    overtone.stop(startedAt + .045);
  }

  function playFacetSequence({ count = 20, stepMs = 102 } = {}) {
    if (!soundsEnabled()) return;
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    try {
      audioContext ||= new AudioContext({ latencyHint: 'interactive' });
      const schedule = () => {
        const firstTick = audioContext.currentTime + .045;
        for (let index = 0; index < count; index += 1) {
          makeFacetTick(audioContext, firstTick + index * stepMs / 1000, index, count);
        }
      };
      if (audioContext.state === 'suspended') audioContext.resume().then(schedule).catch(() => {});
      else if (audioContext.state === 'running') schedule();
    } catch {
      // Boot audio is optional and must never delay entry.
    }
  }

  function playClick() {
    if (!soundsEnabled()) return;
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    try {
      audioContext ||= new AudioContext({ latencyHint: 'interactive' });
      if (audioContext.state === 'suspended') audioContext.resume().then(() => makeClick(audioContext)).catch(() => {});
      else if (audioContext.state === 'running') makeClick(audioContext);
    } catch {
      // Optional sound must never interrupt the button action.
    }
  }

  function actionableButton(target) {
    const button = target.closest?.('button,[role="button"]');
    return button && !button.disabled && button.getAttribute('aria-disabled') !== 'true' ? button : null;
  }

  function release(button) {
    button.classList.remove('hex-pressed', 'hex-released');
    void button.offsetWidth;
    button.classList.add('hex-released');
    window.setTimeout(() => button.classList.remove('hex-released'), 280);
  }

  document.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const button = actionableButton(event.target);
    if (!button) return;
    button.classList.add('hex-pressed');
    playClick();
  }, { capture: true, passive: true });
  document.addEventListener('pointerup', (event) => { const button = actionableButton(event.target); if (button) release(button); }, { capture: true, passive: true });
  document.addEventListener('pointercancel', (event) => { const button = actionableButton(event.target); if (button) release(button); }, { capture: true, passive: true });
  window.addEventListener('blur', () => document.querySelectorAll('.hex-pressed').forEach(release));

  window.HexiInteractions = { soundsEnabled, setSoundsEnabled, playClick, playFacetSequence };
})();
