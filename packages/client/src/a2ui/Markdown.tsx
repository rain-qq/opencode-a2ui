/**
 * Shared Markdown renderer.
 *
 * Used by the assistant_text conversation bubble and the A2UI `Text`
 * component (its catalog entry is "Simple Markdown text.") so LLM output and
 * `Text`-bound content share one look.
 *
 * Pipeline:
 *   remark-gfm       -> tables, task lists, strikethrough, autolinks
 *   rehype-highlight -> highlight.js token coloring for fenced code
 *
 * react-markdown does NOT render raw HTML by default, so model output cannot
 * inject <script>/on* handlers - safe without a sanitizer.
 *
 * Memoized: streaming appends to the *current* assistant bubble on every
 * delta, but prior bubbles' content is stable, so this skips re-parsing the
 * whole history each render.
 */

import { memo } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";

const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS = [rehypeHighlight];

const components: Components = {
  // Block code: framed container. rehype-highlight already colored the inner
  // <code> tokens (it adds `hljs` + per-token spans); we only frame it.
  pre({ children }) {
    return <pre className="md-code-block">{children}</pre>;
  },
  code({ className, children }) {
    // Block code keeps its `language-xxx hljs` classes (styled by the
    // container); only bare inline <code> (no className) gets the pill style.
    if (className) {
      return <code className={className}>{children}</code>;
    }
    return <code className="md-code-inline">{children}</code>;
  },
  a({ href, children, title }) {
    return (
      <a href={href} title={title} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
};

export interface MarkdownProps {
  content: string;
}

export const MarkdownView = memo(function MarkdownView({ content }: MarkdownProps) {
  return (
    <div className="md-body">
      <Markdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={components}
      >
        {content}
      </Markdown>
    </div>
  );
});
