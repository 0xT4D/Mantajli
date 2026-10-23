/** Error categories shared by commands, tools, the engine and the AI layer. */
export type ErrorCategory =
  | "invalid_params"
  | "not_found"
  | "conflict"
  | "locked"
  | "missing_asset"
  | "unsupported"
  | "dependency_unavailable"
  | "render_failed"
  | "io_error"
  | "cancelled"
  | "permission_denied"
  | "internal";

export class MantagliError extends Error {
  constructor(
    public readonly category: ErrorCategory,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "MantagliError";
  }
}

export function fail(category: ErrorCategory, message: string, details?: unknown): never {
  throw new MantagliError(category, message, details);
}

export function toErrorPayload(e: unknown): { category: ErrorCategory; message: string; details?: unknown } {
  if (e instanceof MantagliError) return { category: e.category, message: e.message, details: e.details };
  if (e && typeof e === "object" && "issues" in e && Array.isArray((e as { issues: unknown[] }).issues)) {
    const issues = (e as { issues: { path: unknown[]; message: string }[] }).issues;
    return {
      category: "invalid_params",
      message: issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
    };
  }
  return { category: "internal", message: e instanceof Error ? e.message : String(e) };
}
