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

import { memo, useEffect, useState } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";
import { uploadImage } from "./transport.js";

const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS = [rehypeHighlight];

/** A data: image URI (base64 or url-encoded). The only src form we capture
 *  client-side - the browser has the bytes and can POST them. Remote http(s)
 *  URLs are left as-is; local file paths can't be read from the browser and
 *  are handled server-side only (via the A2UI Image component / tool results). */
function isDataImageUri(src: unknown): boolean {
  return typeof src === "string" && src.startsWith("data:image/");
}

/**
 * <img> that uploads inline `data:` images to MinIO and swaps the src once the
 * upload resolves. While uploading it shows a shimmer placeholder so the
 * layout doesn't jump. Already-uploaded data URIs are cached in transport's
 * uploadCache so re-renders (streaming) don't re-upload.
 */
function MarkdownImage({
  src,
  alt,
  title,
}: {
  src?: string;
  alt?: string;
  title?: string;
}) {
  const [resolved, setResolved] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const capture = isDataImageUri(src);

  useEffect(() => {
    if (!capture || !src) return;
    let cancelled = false;
    setLoading(true);
    uploadImage(src).then((url) => {
      if (cancelled) return;
      if (url) setResolved(url);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [src, capture]);

  if (capture) {
    if (resolved) {
      return <img className="md-image" src={resolved} alt={alt} title={title} loading="lazy" />;
    }
    return <div className="md-image-placeholder" aria-label={alt ?? "uploading image"} />;
  }
  return <img className="md-image" src={src} alt={alt} title={title} loading="lazy" />;
}

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
  img({ src, alt, title }) {
    return <MarkdownImage src={src as string | undefined} alt={alt} title={title} />;
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
