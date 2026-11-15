import { EventType, Preset, Visibility, type MatrixClient, type MatrixEvent, type Room } from "matrix-js-sdk";
import { encryptAttachment } from "matrix-encrypt-attachment";
import { markdownToMatrixHtml } from "../lib/markdown";

export interface SendOpts {
    replyTo?: MatrixEvent;
    /** treat as raw text even if it contains markdown (commands) */
    plain?: boolean;
}

export async function sendText(client: MatrixClient, roomId: string, text: string, opts: SendOpts = {}): Promise<string> {
    const content: Record<string, unknown> = { msgtype: "m.text", body: text, "m.mentions": {} };
    if (!opts.plain) {
        const html = markdownToMatrixHtml(text);
        if (html) {
            content.format = "org.matrix.custom.html";
            content.formatted_body = html;
        }
    }
    if (opts.replyTo?.getId()) content["m.relates_to"] = { "m.in_reply_to": { event_id: opts.replyTo.getId() } };
    const res = await client.sendEvent(roomId, EventType.RoomMessage, content as never);
    return res.event_id;
}

/** Agent control commands are sent as ordinary plain text (Hermes' documented `!` alias). */
export function sendCommand(client: MatrixClient, roomId: string, command: string): Promise<string> {
    return sendText(client, roomId, command, { plain: true });
}

export async function editText(client: MatrixClient, roomId: string, original: MatrixEvent, text: string): Promise<void> {
    const html = markdownToMatrixHtml(text);
    const newContent: Record<string, unknown> = { msgtype: "m.text", body: text, "m.mentions": {} };
    if (html) Object.assign(newContent, { format: "org.matrix.custom.html", formatted_body: html });
    await client.sendEvent(roomId, EventType.RoomMessage, {
        ...newContent,
        body: ` * ${text}`,
        "m.new_content": newContent,
        "m.relates_to": { rel_type: "m.replace", event_id: original.getId() },
    } as never);
}

export async function react(client: MatrixClient, roomId: string, eventId: string, key: string): Promise<void> {
    await client.sendEvent(roomId, EventType.Reaction, { "m.relates_to": { rel_type: "m.annotation", event_id: eventId, key } } as never);
}

export async function redact(client: MatrixClient, roomId: string, eventId: string, reason?: string): Promise<void> {
    await client.redactEvent(roomId, eventId, undefined, reason ? { reason } : undefined);
}

async function imageInfo(file: File): Promise<{ w: number; h: number } | null> {
    if (!file.type.startsWith("image/")) return null;
    try {
        const bmp = await createImageBitmap(file);
        const r = { w: bmp.width, h: bmp.height };
        bmp.close();
        return r;
    } catch {
        return null;
    }
}

export async function sendFile(
    client: MatrixClient,
    room: Room,
    file: File,
    onProgress?: (loaded: number, total: number) => void,
): Promise<void> {
    const encrypted = await client.getCrypto()?.isEncryptionEnabledInRoom(room.roomId);
    const mimetype = file.type || "application/octet-stream";
    const msgtype = mimetype.startsWith("image/") ? "m.image" : mimetype.startsWith("video/") ? "m.video" : mimetype.startsWith("audio/") ? "m.audio" : "m.file";
    const info: Record<string, unknown> = { mimetype, size: file.size };
    const dims = await imageInfo(file);
    if (dims) Object.assign(info, dims);
    const content: Record<string, unknown> = { msgtype, body: file.name, filename: file.name, info };
    const progressHandler = onProgress ? (p: { loaded: number; total: number }) => onProgress(p.loaded, p.total) : undefined;
    if (encrypted) {
        const { data, info: keyInfo } = await encryptAttachment(await file.arrayBuffer());
        const up = await client.uploadContent(new Blob([data]), { type: "application/octet-stream", includeFilename: false, progressHandler });
        content.file = { ...keyInfo, url: up.content_uri, mimetype };
    } else {
        const up = await client.uploadContent(file, { type: mimetype, name: file.name, progressHandler });
        content.url = up.content_uri;
    }
    await client.sendEvent(room.roomId, EventType.RoomMessage, content as never);
}

/** A new conversation = a new private, end-to-end encrypted room with the agent invited. */
export async function createConversation(client: MatrixClient, opts: { name: string; agentUserId?: string; topic?: string }): Promise<string> {
    const invite = opts.agentUserId ? [opts.agentUserId] : [];
    const { room_id } = await client.createRoom({
        name: opts.name,
        topic: opts.topic,
        preset: Preset.TrustedPrivateChat,
        visibility: Visibility.Private,
        invite,
        is_direct: invite.length === 1,
        initial_state: [{ type: EventType.RoomEncryption, state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } }],
    });
    if (opts.agentUserId) {
        // Record it as a direct chat like other Matrix clients do.
        const direct = (client.getAccountData(EventType.Direct)?.getContent() ?? {}) as Record<string, string[]>;
        const list = new Set(direct[opts.agentUserId] ?? []);
        list.add(room_id);
        await client.setAccountData(EventType.Direct, { ...direct, [opts.agentUserId]: [...list] }).catch(() => undefined);
    }
    return room_id;
}

export async function renameRoom(client: MatrixClient, roomId: string, name: string): Promise<void> {
    await client.setRoomName(roomId, name);
}

/** Leave and forget: the room disappears from this account; other members keep their copy. */
export async function leaveAndForget(client: MatrixClient, roomId: string): Promise<void> {
    await client.leave(roomId);
    await client.forget(roomId).catch(() => undefined);
}
