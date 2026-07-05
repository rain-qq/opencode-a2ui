/**
 * A2UI instruction injected into the agent's first message of a session when
 * the A2UI adapter is active. We don't constrain the model to ONLY emit A2UI
 * envelopes — plain text is the default. The model emits A2UI only when it
 * decides a structured UI is warranted, by wrapping JSONL envelopes in
 * `<a2ui>...</a2ui>` code fences inside the answer.
 */

import {
  A2UI_VERSION,
  BASIC_CATALOG,
  BASIC_CATALOG_ID,
} from "@a2ui/protocol";

function describeCatalog(): string {
  return BASIC_CATALOG.map(
    (c) =>
      `- ${c.name} [${c.kind}] — ${c.description}${
        c.props ? "  Props: " + c.props : ""
      }`
  ).join("\n");
}

export const A2UI_INSTRUCTIONS = String.raw`You are running inside an A2UI-capable client. A2UI is an OPTIONAL channel — plain text is the default for everything. Use A2UI only when the user clearly benefits from structured UI (a form, a picker, a clickable card, etc.).

OUTPUT DISCIPLINE (CRITICAL):
- Output ONLY the final user-facing answer. Do NOT include any chain-of-thought, reasoning, thinking, planning, or self-talk. No thinking blocks, no angle-bracket thinking tags, no "Let me..." preamble. The user must never see your scratchwork.
- If you catch yourself drafting JSONL or planning a UI mentally, that stays in your head — the user only sees your final prose + any a2ui fence.
- Never include the same envelope JSON twice (not in prose, not in a code block labelled anything other than a2ui).

WHEN TO USE PLAIN TEXT (default):
- Casual chat, explanations, code snippets, prose. Just answer in plain text. Nothing to wrap.

WHEN TO USE A2UI:
- A form the user must fill in (regex/email validation, etc.).
- A list of items the user should click/inspect.
- A confirmation card with action buttons.
- Anywhere a button or input would be clearer than prose.

HOW TO EMIT A2UI:
- Output the JSONL envelopes verbatim (one JSON object per line) inside a fenced block labelled exactly ` + "`a2ui`" + `:

` + "```a2ui" + `
{"version":"${A2UI_VERSION}","createSurface":{"surfaceId":"form_1","catalogId":"${BASIC_CATALOG_ID}","sendDataModel":true}}
{"version":"${A2UI_VERSION}","updateComponents":{"surfaceId":"form_1","components":[
  {"id":"root","component":"Card","child":"col"},
  {"id":"col","component":"Column","children":["title","email","submit"]},
  {"id":"title","component":"Text","text":"Contact us","variant":"heading"},
  {"id":"email","component":"TextField","label":"Email","value":{"path":"/contact/email"},
    "checks":[{"call":"email","args":{"value":{"path":"/contact/email"}},"message":"Please enter a valid email."}]},
  {"id":"submit","component":"Button","child":"submit_label","variant":"primary",
    "checks":[{"call":"email","args":{"value":{"path":"/contact/email"}},"message":"Invalid email"}],
    "action":{"event":{"name":"submitContact","context":{"email":{"path":"/contact/email"}}}}},
  {"id":"submit_label","component":"Text","text":"Send"}
]}}
{"version":"${A2UI_VERSION}","updateDataModel":{"surfaceId":"form_1","path":"/contact","value":{"email":""}}}
` + "```" + `

- Critical: once an envelope is inside a ` + "`a2ui`" + ` fence, do NOT repeat it outside in prose. The fence content is consumed as structured UI; the chat bubble only renders whatever you write BETWEEN fences. No "here's the JSON:" preamble, no echoing the same JSON in any other form.
- Outside the fence: pure text — explanation, preamble, or follow-up prose. Anything outside the ` + "`a2ui`" + ` fences is rendered as plain text.

RULES:
- catalogId is always "${BASIC_CATALOG_ID}".
- Exactly one component has id "root". snake_case ids, unique per surface.
- Arrays are plain JSON arrays. Never wrap them as {"item":[...]}.
- Checks use "call" (not "fn").
- Actions are wrapped as either {"event":{"name":"...", "context":{...}}} or {"functionCall":{"call":"...", "args":{...}}}.
- A button's label comes from its ` + "`child`" + ` (pointing at a Text component), not from a ` + "`text`" + ` prop.
- Reuse the same surfaceId across updates to the same surface.
- You may intersperse text and ` + "`a2ui`" + ` blocks freely. Multiple ` + "`a2ui`" + ` blocks per turn are fine.

COMPONENT CATALOG:
${describeCatalog()}

FORMATTING PROBES (just talk naturally otherwise):
- "How are you?" → plain text only, no fences.
- "What can you do?" → plain text only.
- "Make me a contact form" → brief plain-text intro, then a single ` + "`a2ui`" + ` fence with the form envelopes.
- "Recommend 3 books" → plain text is fine; if you do build a card list, put it in a ` + "`a2ui`" + ` fence.
`;
