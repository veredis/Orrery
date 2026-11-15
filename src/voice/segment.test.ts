import { describe, expect, it } from "vitest";
import { SAMPLE_RATE as SR, splitAtPauses, worthTranscribing } from "./segment";

/** Build audio from [seconds, loud?] runs: loud = 0.3-amplitude tone, quiet = silence. */
function audio(runs: [number, boolean][]): Float32Array {
    const total = runs.reduce((n, [s]) => n + Math.round(s * SR), 0);
    const a = new Float32Array(total);
    let o = 0;
    for (const [s, loud] of runs) {
        const n = Math.round(s * SR);
        if (loud) for (let i = 0; i < n; i++) a[o + i] = 0.3 * Math.sin((2 * Math.PI * 220 * (o + i)) / SR);
        o += n;
    }
    return a;
}

describe("splitAtPauses", () => {
    it("keeps short recordings whole", () => {
        const a = audio([[20, true]]);
        const parts = splitAtPauses(a);
        expect(parts).toHaveLength(1);
        expect(parts[0].length).toBe(a.length);
    });

    it("covers every sample exactly once, in order, with every piece under 30 s", () => {
        const runs: [number, boolean][] = [];
        for (let i = 0; i < 30; i++) runs.push([4.5, true], [0.6, false]); // ~153 s of speech with pauses
        const a = audio(runs);
        const parts = splitAtPauses(a);
        expect(parts.length).toBeGreaterThan(5);
        let o = 0;
        for (const p of parts) {
            expect(p.length).toBeLessThanOrEqual(28 * SR);
            expect(p.byteOffset / 4).toBe(o); // contiguous views of the same buffer
            o += p.length;
        }
        expect(o).toBe(a.length);
    });

    it("cuts inside a pause, not mid-word", () => {
        // Speech for 20 s, a 1 s pause, then more speech: the cut must land in the pause.
        const a = audio([[20, true], [1, false], [15, true]]);
        const [first] = splitAtPauses(a);
        expect(first.length / SR).toBeGreaterThanOrEqual(20);
        expect(first.length / SR).toBeLessThanOrEqual(21);
    });
});

describe("worthTranscribing", () => {
    it("skips silence and tiny pieces", () => {
        expect(worthTranscribing(audio([[3, false]]))).toBe(false);
        expect(worthTranscribing(audio([[0.1, true]]))).toBe(false);
        expect(worthTranscribing(audio([[2, true]]))).toBe(true);
    });
});
