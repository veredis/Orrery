// Splitting long dictation for Whisper, which hears 30 s at a time. Cutting at natural pauses into
// pieces under 30 s and transcribing each on its own avoids the library's overlapping-chunk
// stitching, which can drop or duplicate text.

export const SAMPLE_RATE = 16000; // dictation.ts resamples to this

export function rms(a: Float32Array): number {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * a[i];
    return Math.sqrt(s / Math.max(a.length, 1));
}

/** Split audio into pieces of at most `maxS` seconds, cutting at the quietest 0.2 s between `minS` and `maxS`. */
export function splitAtPauses(a: Float32Array, sr = SAMPLE_RATE, minS = 15, maxS = 28): Float32Array[] {
    const MAX = Math.round(maxS * sr);
    const MIN = Math.round(minS * sr);
    const win = Math.round(0.2 * sr);
    const hop = Math.round(0.05 * sr);
    const out: Float32Array[] = [];
    let start = 0;
    while (a.length - start > MAX) {
        let cut = start + MAX;
        let best = Infinity;
        for (let p = start + MIN; p + win <= start + MAX; p += hop) {
            let e = 0;
            for (let i = p; i < p + win; i++) e += a[i] * a[i];
            if (e < best) {
                best = e;
                cut = p + (win >> 1);
            }
        }
        out.push(a.subarray(start, cut));
        start = cut;
    }
    out.push(a.subarray(start));
    return out;
}

/** Pieces worth transcribing: long enough to hold a word and not silent (Whisper invents text for silence). */
export const worthTranscribing = (seg: Float32Array, sr = SAMPLE_RATE) => seg.length >= sr * 0.3 && rms(seg) >= 0.002;
