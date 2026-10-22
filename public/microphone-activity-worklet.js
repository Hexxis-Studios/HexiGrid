// Audio-thread meter: no raw samples leave this processor and no microphone
// signal reaches the speakers. It does not depend on visible-page frames.
class MicrophoneActivity extends AudioWorkletProcessor {
  constructor() { super(); this.sum = 0; this.samples = 0; }
  process(inputs, outputs) {
    for (const channels of outputs) for (const channel of channels) channel.fill(0);
    const input = inputs[0]?.[0];
    if (input) {
      for (const sample of input) this.sum += sample * sample;
      this.samples += input.length;
      if (this.samples >= sampleRate / 20) {
        this.port.postMessage({ level: Math.min(1, Math.sqrt(this.sum / this.samples) * 3.5), durationMs: this.samples / sampleRate * 1000 });
        this.sum = 0; this.samples = 0;
      }
    }
    return true;
  }
}
registerProcessor('hexigrid-microphone-activity', MicrophoneActivity);
