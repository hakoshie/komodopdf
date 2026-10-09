import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import MarkdownRenderer from "../../src/components/MarkdownRenderer";
import { normalizeMathDelimiters } from "../../src/utils/mathMarkdown";

describe("math and Markdown", () => {
  it("renders dollar and TeX delimiters with accessible math", () => {
    const html = renderToStaticMarkup(<MarkdownRenderer content={String.raw`Inline $x^2$, $1/2$, and \(\frac{1}{2}\).

\[E = mc^2\]

$$
\int_0^1 x dx
$$`} />);
    expect(html.match(/class="katex"/g)).toHaveLength(5);
    expect(html).toContain("<math");
    expect(html.match(/katex-display/g)).toHaveLength(2);
  });

  it("preserves code, currency, lists, and incomplete streaming expressions", () => {
    const input = "Prices $5 and $10.\n\n* first\n* second\n\n`\\(x*y\\)`\n\n```tex\n\\[a*b\\]\n```";
    expect(normalizeMathDelimiters(input)).toBe(input);
    const html = renderToStaticMarkup(<MarkdownRenderer content={input} />);
    expect(html).toContain("<ul>");
    expect(html).toContain("$5 and $10");
    expect(html).toContain("\\[a*b\\]");
    expect(html).not.toContain('class="katex"');
    expect(() => renderToStaticMarkup(<MarkdownRenderer content={String.raw`\(\frac{1}{`} />)).not.toThrow();
  });

  it("does not authorize HTML or trusted KaTeX commands", () => {
    const html = renderToStaticMarkup(<MarkdownRenderer content={String.raw`<script>alert(1)</script>

\(\href{javascript:alert(1)}{click}\)`} />);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain('href="javascript:');
  });
});
