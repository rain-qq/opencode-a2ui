/**
 * CLI driver for the opencode agent runtime. Verification surface while there
 * is no HTTP layer yet.
 *
 * Usage:
 *   pnpm agent "<message>"                 # fresh opencode session
 *   pnpm agent "follow up" -c              # continue opencode's last session
 *   pnpm agent "follow up" --session <id>  # continue a specific session
 *
 * Under ACP, model/agent selection and tool-permission (the old `-m`,
 * `--agent`, `--auto`) are opencode-config-driven (opencode.jsonc) rather than
 * per-invocation CLI flags. `--pure` still applies.
 *
 * `text` events stream to stdout (the model's answer); everything else
 * (steps, tools, reasoning, traces, errors, the assigned session id) goes to
 * stderr so the answer can be piped cleanly.
 */

import { AcpClient } from "./opencode/acp-client.js";
import { runAgent, type AgentEvent } from "./agent/runner.js";

interface CliArgs {
  message: string;
  session?: string;
  continueLast?: boolean;
  pure?: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { message: "", help: false };
  const parts: string[] = [];
  const take = (i: number): string | undefined => argv[i];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "-h":
      case "--help":
        out.help = true;
        break;
      case "-c":
      case "--continue":
        out.continueLast = true;
        break;
      case "--pure":
        out.pure = true;
        break;
      case "--no-pure":
        out.pure = false;
        break;
      case "-s":
      case "--session":
        out.session = take(++i);
        break;
      default:
        if (a.startsWith("--session=")) out.session = a.slice("--session=".length);
        else parts.push(a);
    }
  }
  out.message = parts.join(" ").trim();
  return out;
}

const USAGE = `opencode agent runtime (底座, ACP)

用法:
  pnpm agent "<message>"                  开启新会话
  pnpm agent "follow up" -c               续接 opencode 最近一次会话
  pnpm agent "follow up" --session <id>   续接指定会话

选项:
  -c, --continue              续接 opencode 最近会话
  -s, --session <id>          续接指定 opencode 会话 id
      --pure / --no-pure       是否禁用外部插件(默认开)
  -h, --help                  显示本帮助

说明: ACP 链路下，模型/agent 选择与工具权限由 opencode 配置(opencode.jsonc)
决定，不再是每次调用的 CLI 参数。`;

const tty = !!process.stderr.isTTY;
const c = {
  dim: (s: string) => (tty ? `\x1b[2m${s}\x1b[22m` : s),
  cyan: (s: string) => (tty ? `\x1b[36m${s}\x1b[39m` : s),
  green: (s: string) => (tty ? `\x1b[32m${s}\x1b[39m` : s),
  red: (s: string) => (tty ? `\x1b[31m${s}\x1b[39m` : s),
  yellow: (s: string) => (tty ? `\x1b[33m${s}\x1b[39m` : s),
  magenta: (s: string) => (tty ? `\x1b[35m${s}\x1b[39m` : s),
};

function preview(v: unknown, max = 200): string {
  if (v === undefined || v === null) return "";
  const text = typeof v === "string" ? v : JSON.stringify(v);
  return text.length > max ? text.slice(0, max) + "…" : text;
}

function printEvent(ev: AgentEvent, emittedText: { value: boolean }) {
  switch (ev.type) {
    case "session":
      process.stderr.write(
        c.cyan(`# opencode session: ${ev.opencodeSessionId}`) +
          c.dim("  (用 --session <id> 或 -c 续接)\n")
      );
      break;
    case "trace":
      process.stderr.write(c.dim(`• ${ev.message}\n`));
      break;
    case "step_start":
      process.stderr.write(c.dim("▶ step\n"));
      break;
    case "step_finish":
      process.stderr.write(c.dim(`◀ step${ev.reason ? ` (${ev.reason})` : ""}\n`));
      break;
    case "tool_call":
      process.stderr.write(
        c.yellow(`🔧 ${ev.name}`) + c.dim(`(${preview(ev.args)})\n`)
      );
      break;
    case "tool_result":
      if (ev.error !== undefined) {
        process.stderr.write(c.red(`✖ ${ev.id} error: ${ev.error}\n`));
      } else {
        process.stderr.write(c.green(`✅ ${ev.id}`) + c.dim(` → ${preview(ev.result)}\n`));
      }
      break;
    case "reasoning":
      process.stderr.write(c.magenta(`💭 ${preview(ev.text, 400)}\n`));
      break;
    case "text":
      process.stdout.write(ev.text);
      emittedText.value = true;
      break;
    case "error":
      process.stderr.write(c.red(`✖ ${ev.code}: ${ev.message}\n`));
      break;
    case "done":
      break;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE + "\n");
    return;
  }
  if (!args.message && !args.continueLast && !args.session) {
    process.stderr.write(USAGE + "\n");
    process.exit(1);
  }

  const client = new AcpClient({
    ...(args.pure !== undefined ? { pure: args.pure } : {}),
  });

  try {
    await client.initialize();
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    const hint =
      e.code === "ENOENT"
        ? `找不到可执行文件。请把 OPENCODE_BIN 设为 opencode 真实可执行文件的绝对路径(Windows 上通常是 ...\\node_modules\\opencode-ai\\bin\\opencode.exe,不要用 .cmd/.ps1 shim)。`
        : (err as Error).message;
    process.stderr.write(c.red(`fatal: ACP initialize failed: ${hint}\n`));
    process.exit(1);
  }

  const emittedText = { value: false };
  try {
    for await (const ev of runAgent(
      {
        sessionId: "cli",
        message: args.message,
        opencodeSessionId: args.session,
        continueLast: args.continueLast,
      },
      { client }
    )) {
      printEvent(ev, emittedText);
    }
  } finally {
    client.dispose();
  }
  if (emittedText.value) {
    // Ensure the answer ends with a newline so the next shell prompt is clean.
    process.stdout.write("\n");
  }
}

main().catch((err) => {
  process.stderr.write(c.red(`fatal: ${(err as Error).message}\n`));
  process.exit(1);
});
