/**
 * Image-capture transform. Sits in the SSE pipeline and uploads inline images
 * to MinIO BEFORE they reach the client, rewriting references to `/api/files/...`
 *
 * Scope (the discrete, non-streamed sources - the streamed-text case is handled
 * client-side in the Markdown renderer, where a single image token can span
 * many `text` deltas and cannot be rewritten mid-stream):
 *
 *   - tool_result.result   -> detectAndUploadImages (recursive walk)
 *   - a2ui envelope         -> Image/Video component `url` + createSurface
 *                              theme.iconUrl (literal strings only)
 *
 * Graceful: if MinIO is disabled/unreachable the originals pass through.
 * See storage/minio.ts.
 */

import type { A2UIEnvelope, ComponentNode } from "@a2ui/protocol";
import type { AgentEvent } from "../agent/runner.js";
import { captureImageUrl, detectAndUploadImages } from "../storage/minio.js";

const IMAGE_COMPONENTS = new Set(["Image", "Video"]);

/** Upload images referenced by one envelope's components + theme. */
async function captureEnvelope(env: A2UIEnvelope): Promise<A2UIEnvelope> {
  let changed = false;
  const next: A2UIEnvelope = { ...env };

  // createSurface theme.iconUrl
  const cs = env.createSurface;
  if (cs?.theme?.iconUrl) {
    const url = await captureImageUrl(cs.theme.iconUrl);
    if (url !== cs.theme.iconUrl) {
      next.createSurface = {
        ...cs,
        theme: { ...cs.theme, iconUrl: url },
      };
      changed = true;
    }
  }

  // updateComponents: walk Image/Video nodes; rewrite literal `url` props.
  const uc = env.updateComponents;
  if (uc?.components?.length) {
    const comps = await Promise.all(
      uc.components.map(async (node) => {
        if (!IMAGE_COMPONENTS.has(node.component)) return node;
        const url = node.url;
        if (typeof url !== "string") return node;
        const rewritten = await captureImageUrl(url);
        if (rewritten === url) return node;
        changed = true;
        return { ...node, url: rewritten } as ComponentNode;
      })
    );
    if (changed) {
      next.updateComponents = { ...uc, components: comps };
    }
  }

  return changed ? next : env;
}

/**
 * Transform an AgentEvent stream: upload inline images from tool_result and
 * a2ui events, yielding the (possibly rewritten) events downstream. Events of
 * other types pass through untouched and without await.
 */
export async function* withImageCapture(
  events: AsyncIterable<AgentEvent>
): AsyncIterable<AgentEvent> {
  for await (const ev of events) {
    if (
      ev.type === "tool_result" &&
      ev.result !== undefined &&
      ev.result !== null
    ) {
      const result = await detectAndUploadImages(ev.result);
      if (result !== ev.result) {
        yield { ...ev, result };
        continue;
      }
      yield ev;
      continue;
    }

    if (ev.type === "a2ui" && ev.envelopes?.length) {
      const envelopes = await Promise.all(ev.envelopes.map(captureEnvelope));
      yield { ...ev, envelopes };
      continue;
    }

    yield ev;
  }
}
