class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.processCalls = 0;
    this.lastDiagnosticCall = 0;
  }

  process(inputs, outputs) {
    this.processCalls += 1;
    const channels = inputs[0] || [];
    const frameLength = channels[0]?.length || 0;

    if (frameLength > 0) {
      // USB interfaces may expose more than one input channel. Downmix all
      // available channels instead of assuming useful audio is on channel 0.
      const mono = new Float32Array(frameLength);
      for (const channel of channels) {
        if (!channel?.length) continue;
        const n = Math.min(frameLength, channel.length);
        for (let i = 0; i < n; i++) mono[i] += channel[i];
      }
      const divisor = Math.max(1, channels.length);
      for (let i = 0; i < mono.length; i++) mono[i] /= divisor;

      this.port.postMessage({
        type: 'pcm',
        channels: channels.length,
        samples: mono,
      });

      // Keep the downstream graph active but inaudible (renderer gain = 0).
      const output = outputs[0]?.[0];
      if (output?.length) output.fill(0);
    } else if (this.processCalls - this.lastDiagnosticCall >= 375) {
      // Roughly once per second at a 48 kHz / 128-frame render quantum.
      this.lastDiagnosticCall = this.processCalls;
      this.port.postMessage({ type: 'heartbeat', channels: channels.length });
    }

    return true;
  }
}

registerProcessor('pcm-processor', PCMProcessor);
