import { fail } from "./errors.js";
import { ProjectSchema, SCHEMA_VERSION, type Project } from "./schema.js";

type Migration = (raw: Record<string, unknown>) => Record<string, unknown>;

/**
 * migrations[n] upgrades a version-n document to version n+1. Add a function
 * here and bump SCHEMA_VERSION whenever the on-disk format changes.
 */
const migrations: Record<number, Migration> = {
  // 0: legacy/unversioned drafts -> 1
  0: (raw) => ({ ...raw, schemaVersion: 1 }),
};

/** Parse untrusted JSON into a validated, current-version project. */
export function migrateProject(input: unknown): { project: Project; migratedFrom?: number } {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("invalid_params", "Project file is not a JSON object");
  let raw = input as Record<string, unknown>;
  const from = typeof raw.schemaVersion === "number" ? raw.schemaVersion : 0;
  if (from > SCHEMA_VERSION) fail("unsupported", `Project schema v${from} is newer than this app supports (v${SCHEMA_VERSION})`);
  for (let v = from; v < SCHEMA_VERSION; v++) {
    const m = migrations[v];
    if (!m) fail("unsupported", `No migration from schema v${v}`);
    raw = m(raw);
  }
  const project = ProjectSchema.parse(raw);
  return from === SCHEMA_VERSION ? { project } : { project, migratedFrom: from };
}
