/**
 * Run a list of `CheckSpec` against the live data model and return per-check
 * results plus the overall pass/fail.
 */

import type { CheckSpec } from "@a2ui/protocol";
import { BUILTIN_FUNCTIONS, resolveDynamic, type DynamicValue } from "@a2ui/protocol";

export interface CheckOutcome {
  ok: boolean;
  message?: string;
}

export function runChecks(
  checks: CheckSpec[] | undefined,
  dataModel: unknown,
  scopePath?: string
): { allOk: boolean; results: CheckOutcome[] } {
  if (!checks || checks.length === 0) return { allOk: true, results: [] };

  const results: CheckOutcome[] = [];
  let allOk = true;

  for (const check of checks) {
    const fn = BUILTIN_FUNCTIONS[check.call];
    if (!fn) {
      results.push({ ok: true });
      continue;
    }
    const args: Record<string, unknown> = {};
    if (check.args) {
      for (const [k, v] of Object.entries(check.args)) {
        args[k] = resolveDynamic(v as DynamicValue<unknown>, {
          dataModel,
          scopePath,
        });
      }
    }
    const passed = Boolean(fn(args));
    if (!passed) allOk = false;
    results.push({ ok: passed, message: passed ? undefined : check.message });
  }

  return { allOk, results };
}

export function firstFailure(
  checks: CheckSpec[] | undefined,
  dataModel: unknown,
  scopePath?: string
): string | undefined {
  const { results } = runChecks(checks, dataModel, scopePath);
  return results.find((r) => !r.ok)?.message;
}
