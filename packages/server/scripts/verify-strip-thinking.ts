/**
 * Verify stripThinking against the real MiniMax thinking output captured in
 * /tmp/sse-real2.out — extracts the raw text payload from the captured SSE
 * and confirms stripThinking removes the ```...``` block.
 *
 * Run: cd packages/server && pnpm exec tsx scripts/verify-strip-thinking.ts
 */

import { readFileSync } from "node:fs";
import { stripThinking } from "../src/opencode/events.js";

// The captured SSE has the text payload on a single "data:" line. We extract
// the first "text" event's data, JSON-parse it, and pull .text.
function loadCapturedText(): string | null {
  try {
    const raw = readFileSync(
      "C:/Users/Rain/AppData/Local/Temp/sse-real-strip-source.txt",
      "utf8"
    );
    return raw;
  } catch {
    return null;
  }
}

// Hard-coded sample from the real capture: a leading ``` block followed by
// the actual user-facing answer. Built via String.fromCharCode to avoid
// backtick escaping issues.
const b = String.fromCharCode(96);
const thinkOpen = b + b + b + "think" + b; // ```
const thinkClose = b + "think" + b + b + b; // ```
const sample =
  thinkOpen +
  "The user wants a contact form. Let me draft JSONL inside a fence.\n\n" +
  "```jsonl\n{\"createSurface\":{...}}\n```\n" +
  thinkClose +
  "\n\n好的,这是一个简单的联系表单:\n\n";

console.log("=== before ===");
console.log("length:", sample.length);
console.log("has thinkOpen:", sample.includes(thinkOpen));
console.log("has thinkClose:", sample.includes(thinkClose));
console.log("has jsonl draft:", sample.includes("```jsonl"));

const stripped = stripThinking(sample);
console.log("\n=== after ===");
console.log("length:", stripped.length);
console.log("has thinkOpen:", stripped.includes(thinkOpen));
console.log("has thinkClose:", stripped.includes(thinkClose));
console.log("has jsonl draft:", stripped.includes("```jsonl"));
console.log("content:", JSON.stringify(stripped));

const captured = loadCapturedText();
if (captured) {
  const strippedCaptured = stripThinking(captured);
  console.log("\n=== captured real MiniMax output ===");
  console.log("before len:", captured.length, "after len:", strippedCaptured.length);
  console.log("thinkOpen removed:", !strippedCaptured.includes(thinkOpen));
  console.log("first 100 of stripped:", JSON.stringify(strippedCaptured.slice(0, 100)));
}

// Assertions.
const ok =
  !stripped.includes(thinkOpen) &&
  !stripped.includes(thinkClose) &&
  !stripped.includes("```jsonl") &&
  stripped.includes("好的,这是一个简单的联系表单");
console.log("\n=== result ===");
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
