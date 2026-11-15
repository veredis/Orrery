// Markdown rendering for chat. All agent/peer content is untrusted: raw HTML inside markdown is
// escaped, and every rendered string passes through DOMPurify with a small allowlist. Links are
// restricted to http(s)/mailto and always open outside the app.
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import { Marked, type Tokens } from "marked";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const ALLOWED_TAGS = [
    "a", "b", "strong", "i", "em", "u", "s", "del", "strike", "code", "pre", "p", "br", "hr", "blockquote", "ul", "ol",
    "li", "h1", "h2", "h3", "h4", "h5", "h6", "table", "thead", "tbody", "tr", "th", "td", "span", "div", "sup", "sub",
    "details", "summary", "button", "input",
];
const ALLOWED_ATTR = ["href", "title", "class", "data-copy", "type", "start", "checked", "disabled", "colspan", "rowspan", "data-mx-maths", "align"];
const SAFE_LINK = /^(https?:|mailto:)/i;
const SAFE_CLASS = /^(hljs(-[\w-]+)?|language-[\w+-]+|code-(block|head|copy|lang)|task-list-item|contains-task-list)$/;

let hooked = false;
function ensureHooks() {
    if (hooked) return;
    hooked = true;
    DOMPurify.addHook("uponSanitizeAttribute", (node, data) => {
        if (data.attrName === "class") {
            data.attrValue = data.attrValue.split(/\s+/).filter((c) => SAFE_CLASS.test(c)).join(" ");
            if (!data.attrValue) data.keepAttr = false;
        }
        if (data.attrName === "type" && node.nodeName === "INPUT" && data.attrValue !== "checkbox") data.keepAttr = false;
        if (data.attrName === "type" && node.nodeName === "BUTTON") data.attrValue = "button";
    });
    DOMPurify.addHook("afterSanitizeAttributes", (node) => {
        if (node.nodeName === "A") {
            const href = node.getAttribute("href") ?? "";
            if (!SAFE_LINK.test(href)) node.removeAttribute("href");
            node.setAttribute("target", "_blank");
            node.setAttribute("rel", "noopener noreferrer nofollow");
        }
        if (node.nodeName === "INPUT") node.setAttribute("disabled", "");
    });
}

export function sanitize(html: string): string {
    ensureHooks();
    return DOMPurify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR, ALLOW_DATA_ATTR: false, FORBID_TAGS: ["style", "img", "iframe", "form"] });
}

function highlight(code: string, lang?: string): { html: string; lang: string } {
    const l = (lang ?? "").toLowerCase().split(/\s/)[0];
    if (l && hljs.getLanguage(l)) return { html: hljs.highlight(code, { language: l, ignoreIllegals: true }).value, lang: l };
    if (code.length < 4000 && !["text", "plaintext", "txt", "output", "console"].includes(l)) {
        const auto = hljs.highlightAuto(code);
        if (auto.relevance > 6) return { html: auto.value, lang: l || auto.language || "" };
    }
    return { html: esc(code), lang: l };
}

const display = new Marked({ gfm: true, breaks: true });
display.use({
    renderer: {
        html: ({ text }: Tokens.HTML | Tokens.Tag) => esc(text),
        code: ({ text, lang }: Tokens.Code) => {
            const h = highlight(text, lang);
            return `<div class="code-block"><div class="code-head"><span class="code-lang">${esc(h.lang || "code")}</span><button type="button" class="code-copy" data-copy="1">Copy</button></div><pre><code class="hljs${h.lang ? ` language-${esc(h.lang)}` : ""}">${h.html}</code></pre></div>`;
        },
    },
});

const outbound = new Marked({ gfm: true, breaks: true });
outbound.use({ renderer: { html: ({ text }: Tokens.HTML | Tokens.Tag) => esc(text) } });

const renderCache = new Map<string, string>();
export function renderMarkdown(text: string): string {
    const hit = renderCache.get(text);
    if (hit !== undefined) return hit;
    const out = sanitize(display.parse(text, { async: false }) as string);
    if (renderCache.size > 800) renderCache.clear();
    renderCache.set(text, out);
    return out;
}

/** HTML for `formatted_body`, or null when the message has no formatting worth sending. */
export function markdownToMatrixHtml(text: string): string | null {
    const html = (outbound.parse(text, { async: false }) as string).trim();
    const plain = `<p>${esc(text).replace(/\n/g, "<br>")}</p>`;
    if (html === plain || html === `<p>${esc(text)}</p>`) return null;
    return sanitize(html);
}

export function markdownToPlain(text: string): string {
    return text
        .replace(/```[\s\S]*?```/g, " code block ")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/[*_~#>|]/g, "")
        .replace(/\n{2,}/g, "\n")
        .trim();
}
