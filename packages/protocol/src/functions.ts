/**
 * Built-in function registry for the A2UI basic catalog.
 * Used by both server (server-side validation hints) and client (runtime evaluation).
 *
 * Each function takes already-resolved (non-Dynamic) args.
 */

export type BuiltinFn = (args: Record<string, unknown>) => unknown;

export interface CheckResult {
  ok: boolean;
  message?: string;
}

/* ---------------- Validation ---------------- */

const required: BuiltinFn = ({ value }) => {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
};

const regex: BuiltinFn = ({ value, pattern, flags }) => {
  if (typeof value !== "string" || typeof pattern !== "string") return false;
  try {
    return new RegExp(pattern, typeof flags === "string" ? flags : undefined).test(value);
  } catch {
    return false;
  }
};

const length: BuiltinFn = ({ value, min, max }) => {
  const n = typeof value === "string" || Array.isArray(value) ? value.length : 0;
  if (typeof min === "number" && n < min) return false;
  if (typeof max === "number" && n > max) return false;
  return true;
};

const numeric: BuiltinFn = ({ value, min, max, integer }) => {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return false;
  if (integer === true && !Number.isInteger(num)) return false;
  if (typeof min === "number" && num < min) return false;
  if (typeof max === "number" && num > max) return false;
  return true;
};

const email: BuiltinFn = ({ value }) => {
  if (typeof value !== "string") return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
};

/* ---------------- Logical ---------------- */

const and: BuiltinFn = ({ values }) =>
  Array.isArray(values) && values.every((v) => Boolean(v));
const or: BuiltinFn = ({ values }) =>
  Array.isArray(values) && values.some((v) => Boolean(v));
const not: BuiltinFn = ({ value }) => !value;

/* ---------------- Formatting ---------------- */

/**
 * formatString: interpolate ${...} expressions inside `value`.
 *
 * Supported forms inside `${...}`:
 *   - `${/abs/path}` or `${rel/path}`  -> resolved against the data model (scope-aware)
 *   - `${fnName(arg:expr, arg2:expr)}` -> nested function call
 *
 * Escape literal `${` with `\${`.
 *
 * Because formatString needs access to the live data model and scope, the
 * pure built-in implementation here only handles the case where the template
 * has already been pre-resolved by the caller (i.e. value is a plain string).
 * The renderer wraps this with a context-aware version (see resolveDynamic).
 */
const formatString: BuiltinFn = ({ value }) => {
  return typeof value === "string" ? value : String(value ?? "");
};

const formatNumber: BuiltinFn = ({ value, minimumFractionDigits, maximumFractionDigits, locale }) => {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return "";
  return new Intl.NumberFormat(typeof locale === "string" ? locale : undefined, {
    minimumFractionDigits:
      typeof minimumFractionDigits === "number" ? minimumFractionDigits : undefined,
    maximumFractionDigits:
      typeof maximumFractionDigits === "number" ? maximumFractionDigits : undefined,
  }).format(num);
};

const formatCurrency: BuiltinFn = ({ value, currency, locale }) => {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return "";
  return new Intl.NumberFormat(typeof locale === "string" ? locale : undefined, {
    style: "currency",
    currency: typeof currency === "string" ? currency : "USD",
  }).format(num);
};

const formatDate: BuiltinFn = ({ value, format, locale }) => {
  const d = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(d.getTime())) return "";
  if (typeof format === "string") {
    return format
      .replace(/yyyy/g, String(d.getFullYear()))
      .replace(/MM/g, String(d.getMonth() + 1).padStart(2, "0"))
      .replace(/dd/g, String(d.getDate()).padStart(2, "0"))
      .replace(/HH/g, String(d.getHours()).padStart(2, "0"))
      .replace(/mm/g, String(d.getMinutes()).padStart(2, "0"))
      .replace(/ss/g, String(d.getSeconds()).padStart(2, "0"));
  }
  return d.toLocaleString(typeof locale === "string" ? locale : undefined);
};

const pluralize: BuiltinFn = ({ count, one, other, zero }) => {
  const n = typeof count === "number" ? count : Number(count);
  if (n === 0 && typeof zero === "string") return zero;
  if (n === 1 && typeof one === "string") return one;
  return typeof other === "string" ? other : "";
};

/* ---------------- Action ---------------- */

const openUrl: BuiltinFn = ({ url }) => {
  if (typeof url !== "string") return null;
  if (typeof window !== "undefined") {
    window.open(url, "_blank", "noopener,noreferrer");
  }
  return null;
};

/* ---------------- Registry ---------------- */

export const BUILTIN_FUNCTIONS: Record<string, BuiltinFn> = {
  required,
  regex,
  length,
  numeric,
  email,
  and,
  or,
  not,
  formatString,
  formatNumber,
  formatCurrency,
  formatDate,
  pluralize,
  openUrl,
};

export const VALIDATION_FUNCTIONS = new Set([
  "required",
  "regex",
  "length",
  "numeric",
  "email",
]);

export const LOCAL_ACTION_FUNCTIONS = new Set(["openUrl"]);
