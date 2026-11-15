// Collects microphone PCM for on-device dictation. Audio stays in this page; nothing is uploaded.
class CaptureProcessor extends AudioWorkletProcessor {
    process(inputs) {
        const ch = inputs[0] && inputs[0][0];
        if (ch && ch.length) {
            let sum = 0;
            for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i];
            this.port.postMessage({ pcm: ch.slice(0), rms: Math.sqrt(sum / ch.length) });
        }
        return true;
    }
}
registerProcessor("orrery-capture", CaptureProcessor);
