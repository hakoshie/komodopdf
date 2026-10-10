import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { openUrl } from "@tauri-apps/plugin-opener";
import { normalizeMathDelimiters } from "../utils/mathMarkdown";
import "katex/dist/katex.min.css";

interface MarkdownRendererProps {
  content: string;
}

const MarkdownRenderer = memo(function MarkdownRenderer({
  content,
}: MarkdownRendererProps) {
  const cleaned = normalizeMathDelimiters(content);
  return (
    <div className="ai-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: false }]]}
        rehypePlugins={[[rehypeKatex, { strict: "ignore", trust: false }]]}
        components={{ a: ({ href, children }) => {
          if (!href || !/^https?:\/\//i.test(href)) return <span>{children}</span>;
          return <a href={href} target="_blank" rel="noopener noreferrer" onClick={(event) => {
            event.preventDefault();
            void openUrl(href).catch((error) => console.error("Could not open source link", error));
          }}>{children}</a>;
        } }}
      >{cleaned}</ReactMarkdown>
    </div>
  );
});

export default MarkdownRenderer;
