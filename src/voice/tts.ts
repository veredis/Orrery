// Read-aloud for assistant replies, using the platform's speech synthesizer (Windows voices in the
// desktop app; Android's TTS engine on the phone). Separate from dictation.
import { create } from "zustand";
import { markdownToPlain } from "../lib/markdown";

export const ttsSupported = () => typeof speechSynthesis !== "undefined";

export const useSpeech = create<{ speakingId: string | null }>(() => ({ speakingId: null }));

export function speak(id: string, markdown: string): void {
    if (!ttsSupported()) return;
    speechSynthesis.cancel();
    if (useSpeech.getState().speakingId === id) {
        useSpeech.setState({ speakingId: null });
        return;
    }
    const u = new SpeechSynthesisUtterance(markdownToPlain(markdown).slice(0, 8000));
    u.lang = navigator.language || "en-US";
    u.onend = u.onerror = () => {
        if (useSpeech.getState().speakingId === id) useSpeech.setState({ speakingId: null });
    };
    useSpeech.setState({ speakingId: id });
    speechSynthesis.speak(u);
}

export function stopSpeaking(): void {
    if (ttsSupported()) speechSynthesis.cancel();
    useSpeech.setState({ speakingId: null });
}
