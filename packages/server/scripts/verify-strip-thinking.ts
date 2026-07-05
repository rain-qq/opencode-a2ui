/**
 * Verify stripThinking against in-source fixtures covering every supported
 * thinking-tag variant. The script intentionally does NOT read from a captured
 * opencode SSE file — captured output changes as we tune upstream config, and
 * a stale fixture would silently mask regressions.
 *
 * Run: cd packages/server && pnpm exec tsx scripts/verify-strip-thinking.ts
 */

import { stripThinking } from "../src/opencode/events.js";

const b = String.fromCharCode(96); // "`"
const thinkOpen = b + b + b + "think" + b;
const thinkClose = b + "think" + b + b + b;

interface Case {
  name: string;
  input: string;
  expected: string;
}

const cases: Case[] = [
  {
    name: "```think``` block removed",
    input:
      thinkOpen +
      "Let me think about the contact form.\n" +
      "```jsonl\n{\"createSurface\":{...}}\n```\n" +
      thinkClose +
      "\n好的，这是一个简单的联系表单。",
    expected: "\n好的，这是一个简单的联系表单。",
  },
  {
    name: "<thinking>...</thinking> block removed",
    input:
      "<thinking>Plan a UI.</thinking>\n下面是结果。",
    expected: "\n下面是结果。",
  },
  {
    name: "【思考】...【/思考】 block removed",
    input: "【思考】先想想怎么答。\n【/思考】\n答案。",
    expected: "\n答案。",
  },
  {
    name: "multiple ```think``` blocks all removed",
    input:
      thinkOpen + "first\n" + thinkClose +
      "A\n" +
      thinkOpen + "second\n" + thinkClose +
      "B",
    expected: "A\nB",
  },
  {
    name: "unclosed ```think opener is left in place (leak-not-swallow)",
    input: thinkOpen + "no closer here\n正文继续。",
    expected: thinkOpen + "no closer here\n正文继续。",
  },
  {
    name: "clean text with no thinking tags passes through unchanged",
    input: "文琪是一位演员。",
    expected: "文琪是一位演员。",
  },
  {
    name: "reasoning_split:true path — bare reasoning prose (no tags) is NOT stripped",
    // When reasoning_split:true is set on the API, Minimax returns reasoning in
    // an independent field and `content` stays clean. But opencode's
    // @ai-sdk/openai provider doesn't surface reasoning_content, so it never
    // reaches text. If reasoning ever DID leak back into text as bare prose
    // (no tags), stripThinking must NOT eat it — that would silently swallow
    // the answer.
    input:
      "Let me reason step by step about this request.\n" +
      "答案是 42。",
    expected:
      "Let me reason step by step about this request.\n" +
      "答案是 42。",
  },
];

let pass = 0;
let fail = 0;
for (const c of cases) {
  const got = stripThinking(c.input);
  const ok = got === c.expected;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${c.name}`);
  if (!ok) {
    console.log(`  input:    ${JSON.stringify(c.input)}`);
    console.log(`  expected: ${JSON.stringify(c.expected)}`);
    console.log(`  got:      ${JSON.stringify(got)}`);
    fail++;
  } else {
    pass++;
  }
}

console.log(`\n${pass}/${cases.length} passed`);
process.exit(fail === 0 ? 0 : 1);