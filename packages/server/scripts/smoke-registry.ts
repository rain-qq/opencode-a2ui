import { getRegistry, buildSelectionPrefix } from "../src/agent/registry.js";

const r = getRegistry();
console.log("agents:", r.agents.map((a) => a.id).join(","));
console.log("skills:", r.skills.map((s) => s.id).join(","));
console.log("mcps:", r.mcps.map((c) => c.id).join(","));
console.log("prefix-empty:", JSON.stringify(buildSelectionPrefix(undefined)));
console.log(
  "prefix-full:",
  JSON.stringify(
    buildSelectionPrefix({
      agents: ["code-reviewer"],
      skills: ["web-search", "translate"],
      mcps: ["github"],
    })
  )
);