/**
 * MinIO object storage for conversation-generated images.
 *
 * Graceful degradation is the core contract: if MinIO is not configured
 * (MINIO_ENDPOINT empty / MINIO_DISABLED) or the peer is unreachable, every
 * function here is a safe no-op that returns null / passes the original value
 * through untouched. Image capture must NEVER break a chat turn.
 *
 * All uploaded images are served back through the server's `/api/files/*`
 * proxy (see http/files.ts) so the bucket need not be public, there are no
 * CORS concerns, and dev traffic flows through the existing vite `/api` proxy.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { ENV, workspaceRoot } from "../env.js";
import type { FastifyReply } from "fastify";
import { Client } from "minio";

let cachedClient: Client | null | undefined;
let bucketEnsured = false;

/** MinIO is only active when configured AND not explicitly disabled. */
export function minioEnabled(): boolean {
  if (ENV.MINIO_DISABLED) return false;
  return (
    ENV.MINIO_ENDPOINT.length > 0 &&
    ENV.MINIO_ACCESS_KEY.length > 0 &&
    ENV.MINIO_SECRET_KEY.length > 0
  );
}

/** Lazy singleton client. Returns null when disabled (or on construction error). */
function getMinioClient(): Client | null {
  if (!minioEnabled()) return null;
  if (cachedClient !== undefined) return cachedClient;
  try {
    cachedClient = new Client({
      endPoint: ENV.MINIO_ENDPOINT,
      port: ENV.MINIO_PORT,
      useSSL: ENV.MINIO_USE_SSL,
      accessKey: ENV.MINIO_ACCESS_KEY,
      secretKey: ENV.MINIO_SECRET_KEY,
    });
  } catch (err) {
    process.stderr.write(
      `[minio] client init failed: ${(err as Error).message} (image capture disabled)\n`
    );
    cachedClient = null;
  }
  return cachedClient;
}

/** Best-effort bucket creation on first use. Failures are logged, not thrown. */
async function ensureBucket(client: Client): Promise<void> {
  if (bucketEnsured) return;
  try {
    const exists = await client.bucketExists(ENV.MINIO_BUCKET);
    if (!exists) await client.makeBucket(ENV.MINIO_BUCKET);
    bucketEnsured = true;
  } catch (err) {
    process.stderr.write(
      `[minio] ensureBucket("${ENV.MINIO_BUCKET}") failed: ${(err as Error).message}\n`
    );
  }
}

/** sha1 of a buffer, for dedup. */
function hashBuf(buf: Buffer): string {
  return createHash("sha1").update(buf).digest("hex");
}

const urlCache = new Map<string, string>();
const URL_CACHE_CAP = 256;

/** Map a content-type (image/png) to a file extension (png; jpeg -> jpg). */
function extForContentType(ct: string): string {
  const sub = ct.split(";")[0].trim().split("/")[1] ?? "bin";
  if (sub === "jpeg") return "jpg";
  return sub || "bin";
}

/**
 * Upload a raw image buffer to MinIO and return the `/api/files/<key>` URL.
 * Returns null on any failure (MinIO disabled, upload error) - caller keeps
 * the original value.
 */
export async function uploadImage(
  buf: Buffer,
  ext: string,
  contentType: string
): Promise<string | null> {
  const client = getMinioClient();
  if (!client) return null;

  const cacheKey = hashBuf(buf);
  const cached = urlCache.get(cacheKey);
  if (cached) return cached;

  await ensureBucket(client);

  // Build a stable, collision-free object key: a2ui/<date>/<hash>.<ext>
  const date = new Date().toISOString().slice(0, 10);
  const safeExt = ext.replace(/[^a-zA-Z0-9]/g, "") || "bin";
  const key = `a2ui/${date}/${cacheKey}.${safeExt}`;

  try {
    await client.putObject(ENV.MINIO_BUCKET, key, buf, buf.length, {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
    });
  } catch (err) {
    process.stderr.write(
      `[minio] putObject failed: ${(err as Error).message}\n`
    );
    return null;
  }

  const url = `/api/files/${key}`;
  if (urlCache.size >= URL_CACHE_CAP) {
    // Drop the oldest entry to bound memory.
    const firstKey = urlCache.keys().next().value;
    if (firstKey) urlCache.delete(firstKey);
  }
  urlCache.set(cacheKey, url);
  return url;
}

/**
 * Parse a `data:` URI into { buffer, contentType }. Returns null if it isn't an
 * image data URI.
 */
function parseDataUri(s: string): { buf: Buffer; contentType: string; ext: string } | null {
  const m = /^data:([^,]*?),([^\n\r]*)$/s.exec(s);
  if (!m) return null;
  const meta = m[1] || "image/png";
  const data = m[2];
  if (!meta.startsWith("image/")) return null;
  const contentType = meta.split(";")[0] || "image/png";
  const isBase64 = meta.includes("base64");
  let buf: Buffer;
  try {
    buf = isBase64
      ? Buffer.from(data, "base64")
      : Buffer.from(decodeURIComponent(data), "utf-8");
  } catch {
    return null;
  }
  if (buf.length === 0) return null;
  return { buf, contentType, ext: extForContentType(contentType) };
}

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;

/**
 * Resolve a candidate local image path to an absolute path if it points to a
 * readable image file; otherwise null. Conservative: only existing files.
 */
function resolveLocalImagePath(p: string): string | null {
  if (!p || !IMAGE_EXT_RE.test(p)) return null;
  const abs = isAbsolute(p) ? p : join(workspaceRoot, p);
  if (!existsSync(abs)) return null;
  return abs;
}

/** Read a local image file into { buffer, contentType, ext }. */
function readLocalImage(absPath: string): { buf: Buffer; contentType: string; ext: string } | null {
  try {
    const buf = readFileSync(absPath);
    const ext = (absPath.toLowerCase().match(IMAGE_EXT_RE)?.[1] ?? "bin").replace("jpeg", "jpg");
    const contentType = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
    return { buf, contentType, ext };
  } catch {
    return null;
  }
}

const DATA_URI_RE = /data:image\/[a-zA-Z0-9.+-]+(;base64)?,[^\s)"'\]]+/g;
const MD_LOCAL_IMG_RE = /(!\[[^\]]*\]\()([^)\s]+)(\))/g;

/**
 * Capture a SINGLE image from a bare url string: a `data:` URI or a path to a
 * local image file. Returns the `/api/files/...` url, or the original string
 * if it is a remote http(s) url, a non-image, or anything upload failed on.
 *
 * Unlike `detectAndUploadImages` (recursive), this does NOT walk into objects -
 * use it on A2UI component `url` props that are LITERAL strings. A DynamicValue
 * that is a PathRef/FunctionCall (an object) must be left untouched: its `path`
 * is a data-model pointer, NOT a file path, and recursing would mis-upload it.
 */
export async function captureImageUrl(s: string): Promise<string> {
  if (!minioEnabled() || typeof s !== "string" || s.length === 0) return s;
  // Remote URLs are already hosted - leave them.
  if (/^https?:\/\//i.test(s)) return s;

  const data = parseDataUri(s);
  if (data) {
    const url = await uploadImage(data.buf, data.ext, data.contentType);
    return url ?? s;
  }
  const local = resolveLocalImagePath(s);
  if (local) {
    const img = readLocalImage(local);
    if (img) {
      const url = await uploadImage(img.buf, img.ext, img.contentType);
      return url ?? s;
    }
  }
  return s;
}

/**
 * Upload a `data:image/...;base64,...` URI (e.g. from a client file input)
 * and return its `/api/files/...` url. Returns null for non-image data URIs
 * or when MinIO is unavailable. Used by the `/api/images/upload` endpoint and
 * the client-side Markdown image capture path.
 */
export async function uploadFromDataUri(dataUri: string): Promise<string | null> {
  const parsed = parseDataUri(dataUri);
  if (!parsed) return null;
  return await uploadImage(parsed.buf, parsed.ext, parsed.contentType);
}

/** Strip the `/api/files/` prefix to recover the MinIO object key. */
export function attachmentUrlToKey(url: string): string | null {
  const prefix = "/api/files/";
  if (!url.startsWith(prefix)) return null;
  const key = url.slice(prefix.length);
  if (!key || key.includes("..")) return null;
  return key;
}

/**
 * Pull image bytes from MinIO for an `/api/files/<key>` url. Returns
 * { buf, contentType } or null if MinIO is disabled, the key is invalid,
 * or the object can't be fetched. Used by the agent runner to inline images
 * into ACP prompts (ACP only accepts base64, not URLs).
 */
export async function fetchImageBytes(
  url: string
): Promise<{ buf: Buffer; contentType: string } | null> {
  const client = getMinioClient();
  if (!client) return null;
  const key = attachmentUrlToKey(url);
  if (!key) return null;
  try {
    const stat = await client.statObject(ENV.MINIO_BUCKET, key);
    const rawCt =
      (stat.metaData as Record<string, string> | undefined)?.["Content-Type"];
    const contentType = rawCt?.split(";")[0].trim() || "application/octet-stream";
    const stream = await client.getObject(ENV.MINIO_BUCKET, key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
    }
    return { buf: Buffer.concat(chunks), contentType };
  } catch (err) {
    process.stderr.write(
      `[minio] fetchImageBytes("${key}") failed: ${(err as Error).message}\n`
    );
    return null;
  }
}



/**
 * Scan a string for inline image payloads (data: URIs and markdown refs to
 * local image files), upload each, and return the string with URLs rewritten
 * to `/api/files/...`. Non-image data: URIs and remote http(s) URLs are left
 * untouched. Returns the original string on any failure (best-effort).
 */
async function captureStringImages(s: string): Promise<string> {
  let out = s;

  // 1) Inline data: image URIs (base64 or url-encoded).
  const dataMatches = out.match(DATA_URI_RE);
  if (dataMatches) {
    for (const dataUri of dataMatches) {
      const parsed = parseDataUri(dataUri);
      if (!parsed) continue;
      const url = await uploadImage(parsed.buf, parsed.ext, parsed.contentType);
      if (url) out = out.split(dataUri).join(url);
    }
  }

  // 2) Markdown image links whose URL is a local existing image file:
  //    ![alt](./local.png) -> ![alt](/api/files/...)
  out = await replaceAsync(out, MD_LOCAL_IMG_RE, async (_m, p1, pathRaw, p3) => {
    const local = resolveLocalImagePath(pathRaw);
    if (!local) return `${p1}${pathRaw}${p3}`;
    const img = readLocalImage(local);
    if (!img) return `${p1}${pathRaw}${p3}`;
    const url = await uploadImage(img.buf, img.ext, img.contentType);
    return url ? `${p1}${url}${p3}` : `${p1}${pathRaw}${p3}`;
  });

  return out;
}

/** Tiny async-aware String.replace. */
async function replaceAsync(
  str: string,
  re: RegExp,
  fn: (m: string, ...args: string[]) => Promise<string>
): Promise<string> {
  const tasks: Promise<string>[] = [];
  str.replace(re, (m, ...args) => {
    tasks.push(fn(m, ...(args as string[])));
    return m;
  });
  const results = await Promise.all(tasks);
  let i = 0;
  return str.replace(re, () => results[i++]);
}

/**
 * Recursively walk a value (string / array / plain object) and upload every
 * inline image found, returning a NEW value with URLs rewritten. Graceful: on
 * any error the original value is returned. Use for tool_result payloads and
 * A2UI envelope component props.
 */
export async function detectAndUploadImages<T>(value: T): Promise<T> {
  if (!minioEnabled()) return value;
  try {
    return (await walk(value)) as T;
  } catch (err) {
    process.stderr.write(
      `[minio] detectAndUploadImages failed: ${(err as Error).message}\n`
    );
    return value;
  }
}

async function walk(v: unknown): Promise<unknown> {
  if (typeof v === "string") return await captureStringImages(v);
  if (Array.isArray(v)) return Promise.all(v.map(walk));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = await walk(val);
    }
    return out;
  }
  return v;
}

/**
 * Stream a stored object back to the client (the `/api/files/*` handler).
 * Sets Content-Type from the object's stored metadata. 404s if the object is
 * missing; 503 if MinIO is unavailable.
 */
export async function streamObjectToReply(
  reply: FastifyReply,
  key: string
): Promise<void> {
  const client = getMinioClient();
  if (!client) {
    reply.code(503).send({ error: "image storage unavailable" });
    return;
  }
  try {
    const stat = await client.statObject(ENV.MINIO_BUCKET, key);
    const contentType =
      (stat.metaData as Record<string, string> | undefined)?.["Content-Type"] ??
      "application/octet-stream";
    reply.raw.setHeader("Content-Type", contentType);
    if (stat.size) reply.raw.setHeader("Content-Length", stat.size);
    reply.raw.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    reply.hijack();
    const stream = await client.getObject(ENV.MINIO_BUCKET, key);
    stream.on("error", () => {
      try {
        reply.raw.end();
      } catch {
        /* socket closed */
      }
    });
    stream.pipe(reply.raw);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "NotFound") {
      reply.code(404).send({ error: "not found" });
      return;
    }
    process.stderr.write(
      `[minio] streamObject failed: ${(err as Error).message}\n`
    );
    reply.code(503).send({ error: "image storage unavailable" });
  }
}
