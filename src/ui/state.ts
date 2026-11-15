import { create } from "zustand";
import type { DictationEngine, WhisperModel } from "../voice/dictation";

export type Section = "chats" | "agents" | "tasks" | "settings";
export type Theme = "dark" | "light" | "system";

export interface LocalSettings {
    theme: Theme;
    dictationEngine: DictationEngine;
    whisperModel: WhisperModel;
    enterToSend: boolean;
    showControlMessages: boolean;
    notifications: boolean;
    readAloud: boolean;
    /** Desktop app: look for a new release at launch and every few hours (installing still needs a click). */
    autoCheckUpdates: boolean;
}

const SETTINGS_KEY = "orrery.settings.v1";
const isMobile = /Android|iPhone|iPad/i.test(navigator.userAgent);
const defaults: LocalSettings = {
    theme: "dark",
    dictationEngine: "local",
    whisperModel: "onnx-community/whisper-base.en",
    enterToSend: !isMobile,
    showControlMessages: false,
    notifications: false,
    readAloud: true,
    autoCheckUpdates: true,
};
function loadSettings(): LocalSettings {
    try {
        return { ...defaults, ...(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") as Partial<LocalSettings>) };
    } catch {
        return defaults;
    }
}

interface UIState {
    section: Section;
    roomId: string | null;
    /** phone layout: list (sidebar) or chat */
    mobileView: "list" | "chat";
    activityOpen: boolean;
    sidebarCollapsed: boolean;
    settings: LocalSettings;
    toasts: { id: number; text: string; kind?: "error" | "info" }[];
    lightbox: string | null;
    highlightEventId: string | null;
    prefill: string | null;
}

export const useUI = create<UIState>(() => ({
    section: "chats",
    roomId: localStorage.getItem("orrery.lastRoom"),
    mobileView: "list",
    activityOpen: false,
    sidebarCollapsed: false,
    settings: loadSettings(),
    toasts: [],
    lightbox: null,
    highlightEventId: null,
    prefill: null,
}));

export function openRoom(roomId: string | null, eventId?: string) {
    if (roomId) localStorage.setItem("orrery.lastRoom", roomId);
    useUI.setState({ roomId, section: "chats", mobileView: roomId ? "chat" : "list", highlightEventId: eventId ?? null });
}
export function setSection(section: Section) {
    useUI.setState({ section, mobileView: section === "chats" ? useUI.getState().mobileView : "list" });
}
export function updateSettings(patch: Partial<LocalSettings>) {
    const settings = { ...useUI.getState().settings, ...patch };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    useUI.setState({ settings });
    applyTheme(settings.theme);
}
export function applyTheme(theme: Theme) {
    const t = theme === "system" ? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark") : theme;
    document.documentElement.dataset.theme = t;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", t === "light" ? "#f7f6fb" : "#14111f");
}

let toastSeq = 0;
export function toast(text: string, kind: "error" | "info" = "info") {
    const id = ++toastSeq;
    useUI.setState((s) => ({ toasts: [...s.toasts, { id, text, kind }] }));
    setTimeout(() => useUI.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === "error" ? 6500 : 3500);
}

// Drafts persist per conversation on this device.
export const drafts = {
    get: (roomId: string) => localStorage.getItem(`orrery.draft.${roomId}`) ?? "",
    set: (roomId: string, text: string) => {
        if (text) localStorage.setItem(`orrery.draft.${roomId}`, text);
        else localStorage.removeItem(`orrery.draft.${roomId}`);
    },
};
