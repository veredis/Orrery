// Agent output is untrusted: rendering must never produce script, event handlers or unsafe links.
import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.window.document, DOMParser: dom.window.DOMParser, Node: dom.window.Node });
const { renderMarkdown, markdownToMatrixHtml } = await import("./markdown");

describe("markdown sanitisation", () => {
    it("escapes raw HTML and strips dangerous links", () => {
        const html = renderMarkdown('<img src=x onerror="alert(1)"> <script>alert(2)</script> [x](javascript:alert(3)) [ok](https://example.org)');
        expect(html).not.toMatch(/<script|<img|sonw+=|href="javascript/i);
        expect(html).toContain("&lt;script&gt;");
        expect(html).toContain('href="https://example.org"');
    });
    it("renders code blocks with a copy affordance and highlighting", () => {
        const html = renderMarkdown("```ts\nconst a: number = 1;\n```");
        expect(html).toContain("code-block");
        expect(html).toContain("hljs");
    });
    it("produces Matrix formatted_body without unsafe markup", () => {
        const html = markdownToMatrixHtml("**bold** <b onclick=x>hi</b>");
        expect(html).toContain("<strong>bold</strong>");
        expect(html).not.toMatch(/<b[^>]*onclick/);
        expect(html).toContain("&lt;b onclick");
    });
});
