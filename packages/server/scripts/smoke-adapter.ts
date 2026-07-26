/**
 * Offline smoke test for the A2UI adapter. Plugs a synthetic AgentEvent stream
 * into withA2UIAdapter and prints the resulting stream verbatim. Proves the
 * a + b fix without needing a live LLM call.
 *
 * Run:  cd packages/server && tsx scripts/smoke-adapter.ts
 */

import { withA2UIAdapter } from "../src/http/adapter/a2ui.js";
import type { AgentEvent } from "../src/agent/runner.js";

const SCENARIOS: { name: string; events: AgentEvent[] }[] = [
  // Plain text only — no fences expected.
  {
    name: "plain chat (no a2ui)",
    events: [
      { type: "session", opencodeSessionId: "ses_demo" },
      { type: "step_start" },
      { type: "text", text: "Sure thing. I'll keep it short." },
      { type: "step_finish", reason: "stop" },
      { type: "done" },
    ],
  },
  // Lead-in prose, then a fenced a2ui block, then closing prose.
  {
    name: "prose + a2ui form + prose",
    events: [
      { type: "session", opencodeSessionId: "ses_demo" },
      { type: "step_start" },
      { type: "text", text: "Here's the form you asked for.\n\n" },
      { type: "text", text: '```a2ui\n{"version":"v0.9.1","createSurface":{"surfaceId":"form_1","catalogId":"https://a2ui.org/specification/v0_9_1/catalogs/basic/catalog.json","sendDataModel":true}}\n{"version":"v0.9.1","updateComponents":{"surfaceId":"form_1","components":[{"id":"root","component":"Card","child":"col"}]}}\n```\n\n' },
      { type: "text", text: "Let me know if you need anything else." },
      { type: "step_finish", reason: "stop" },
      { type: "done" },
    ],
  },
  // a2ui block split across multiple text chunks (streaming).
  {
    name: "a2ui block straddles two text chunks",
    events: [
      { type: "text", text: "Opening:\n\n" },
      { type: "text", text: '```a2ui\n{"version":"v0.9.1","createSurface":{"surfaceId":"split_1"}}' },
      { type: "text", text: '\n```\nEnd.' },
    ],
  },
  // Two a2ui blocks in one turn.
  {
    name: "two a2ui blocks in one turn",
    events: [
      { type: "text", text: '```a2ui\n{"version":"v0.9.1","createSurface":{"surfaceId":"a"}}\n```\nmiddle\n```a2ui\n{"version":"v0.9.1","createSurface":{"surfaceId":"b"}}\n```\n' },
    ],
  },
  // Model never closes the fence — everything must fall back to text.
  {
    name: "unclosed fence -> whole buffer is text",
    events: [
      { type: "text", text: 'partial:\n```a2ui\n{"version":"v0.9.1","createSurface":{"surfaceId":"open"}}\n' },
    ],
  },
  // StepList children wrapped as single-element array — must be normalized to
  // bare {path, componentId} by the server adapter (LLM occasionally writes
  // it this way). Surface/structure unchanged otherwise.
  {
    name: "StepList children [{path,componentId}] -> {path,componentId}",
    events: [
      {
        type: "text",
        text:
          '```a2ui\n' +
          '{"version":"v0.9.1","updateComponents":{"surfaceId":"step_strip","components":[' +
          '{"id":"strip","component":"StepList","children":[{"path":"/steps","componentId":"step-item"}]}' +
          ']}}\n' +
          '```\n',
      },
    ],
  },
];

async function* fromArray<T>(arr: T[]): AsyncIterable<T> {
  for (const x of arr) yield x;
}

(async () => {
  for (const sc of SCENARIOS) {
    console.log("\n=== " + sc.name + " ===");
    const events = fromArray(sc.events);
    for await (const ev of withA2UIAdapter(events)) {
      if (ev.type === "text") {
        // Inspect content for any sign of fence leakage.
        const leakage = /```|createSurface|updateComponents|updateDataModel/.test(ev.text);
        console.log(
          "  text:",
          JSON.stringify(ev.text.slice(0, 80)) + (ev.text.length > 80 ? "…" : ""),
          leakage ? "  <-- LEAK" : ""
        );
      } else if (ev.type === "a2ui") {
        const ids = ev.envelopes
          .map((e: any) =>
            e.createSurface?.surfaceId ?? e.updateComponents?.surfaceId ?? "?"
          )
          .join(", ");
        console.log("  a2ui: " + ev.envelopes.length + " envelopes (" + ids + ")");
        // For the StepList normalization case, dump the resolved children shape
        // so the test log shows the unwrap actually happened.
        for (const e of ev.envelopes as any[]) {
          const comps = e.updateComponents?.components ?? [];
          for (const c of comps) {
            if (c.component === "StepList") {
              const childDesc = Array.isArray(c.children)
                ? "array[" + c.children.length + "]"
                : c.children
                ? "bare{" + Object.keys(c.children).join(",") + "}"
                : "none";
              console.log("    StepList.children = " + childDesc);
            }
          }
        }
      } else {
        console.log("  " + ev.type);
      }
    }
  }
})();
