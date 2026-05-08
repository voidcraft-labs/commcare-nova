/**
 * Shared input schemas + uuid helpers for the case-list-config SA
 * tools.
 *
 * The case-list config has three slots — `columns`, `filter?`,
 * `searchInputs` — and the SA tool surface decomposes into:
 *
 *   - One wholesale tool for `filter` (`setCaseListFilter`) — a filter
 *     is one Predicate, so the wholesale shape fits.
 *   - Eight atomic-op tools for the two arrays — add / update / remove /
 *     reorder for each of `columns` and `searchInputs`. Atomic ops keep
 *     each call's payload small + the SA's working memory of authored
 *     uuids tractable.
 *
 * The atomic ops route their array-walk + error-shaping through the
 * `addColumnMutation` / `addSearchInputMutation` family in
 * `lib/agent/blueprintHelpers.ts` — the same builders any non-SA caller
 * (UI mutation, future migration script) reuses. This file owns the
 * SA-boundary inputs:
 *
 *   - `columnInputSchema` / `searchInputDefInputSchema` — the
 *     discriminated-union shapes the SA passes when adding or updating
 *     an entry. `uuid` is omitted from each arm; the tool mints it on
 *     `add` and looks it up on `update`.
 *   - `newUuid` — uuid mint helper.
 */

import { z } from "zod";
import {
	type CaseListConfig,
	columnSchema,
	type Module,
	searchInputDefSchema,
	type Uuid,
} from "@/lib/domain";

// ── Tool input schemas — column + search-input shapes without uuid ──
//
// `addCaseListColumn` mints a fresh uuid; `updateCaseListColumn`
// preserves the existing uuid keyed by `columnUuid`. Both accept the
// same kind-discriminated body, so we reuse one input schema across
// both surfaces. Same approach for the search-input tools.
//
// Each arm comes from `columnSchema.options` / `searchInputDefSchema.options`
// with `uuid` omitted. Destructuring per-arm preserves the TS-inferred
// per-arm shape so the discriminated union retypes cleanly — the
// `Iterable<ZodObject>.map(...)` form drops the per-arm narrowing into
// a non-callable union TS can't dispatch through `omit`.

const [
	plainColumnArm,
	dateColumnArm,
	phoneColumnArm,
	idMappingColumnArm,
	intervalColumnArm,
	calculatedColumnArm,
] = columnSchema.options;

/**
 * Per-arm `Column` schema with the `uuid` slot omitted. Surface the SA
 * passes when adding or updating a column — the uuid is owned by the
 * tool (minted on add, looked up by `columnUuid` on update).
 */
export const columnInputSchema = z.discriminatedUnion("kind", [
	plainColumnArm.omit({ uuid: true }),
	dateColumnArm.omit({ uuid: true }),
	phoneColumnArm.omit({ uuid: true }),
	idMappingColumnArm.omit({ uuid: true }),
	intervalColumnArm.omit({ uuid: true }),
	calculatedColumnArm.omit({ uuid: true }),
]);
export type ColumnInput = z.infer<typeof columnInputSchema>;

const [simpleSearchInputArm, advancedSearchInputArm] =
	searchInputDefSchema.options;

/**
 * Per-arm `SearchInputDef` schema with the `uuid` slot omitted. Mirrors
 * `columnInputSchema` for the search-input add / update tools.
 */
export const searchInputDefInputSchema = z.discriminatedUnion("kind", [
	simpleSearchInputArm.omit({ uuid: true }),
	advancedSearchInputArm.omit({ uuid: true }),
]);
export type SearchInputDefInput = z.infer<typeof searchInputDefInputSchema>;

// ── Uuid generation ─────────────────────────────────────────────────

/**
 * Mint a fresh `Uuid` for a freshly-authored column or search input.
 * Wraps `crypto.randomUUID()` so call sites stay typed against the
 * branded `Uuid` shape rather than reaching for `asUuid` inline at
 * every add path.
 */
export function newUuid(): Uuid {
	return crypto.randomUUID() as Uuid;
}

// ── Uuid input schema ───────────────────────────────────────────────
//
// `uuidSchema` (in `lib/domain/uuid.ts`) brands the parsed string as a
// `Uuid` via `.transform(...)`. That transform makes the schema
// unrepresentable in JSON Schema — `z.toJSONSchema(uuidSchema)` throws,
// which means the SA tool surface (which lowers every input schema to
// JSON Schema for the Anthropic compiler) can't accept `uuidSchema`
// directly as a top-level field.
//
// `uuidInputSchema` is the wire-shape version: a plain
// `z.string().min(1)` that lowers cleanly to JSON Schema. Tool bodies
// brand the parsed value with `asUuid(...)` before handing it to the
// blueprintHelpers atomic builders.
//
// Used by every atomic-op tool that addresses an existing column /
// search input by uuid (`updateCaseListColumn`, `removeCaseListColumn`,
// `reorderCaseListColumns`, and the search-input parallels).

/**
 * JSON-Schema-safe Uuid wire schema. Accepts a non-empty string at the
 * SA boundary; tool bodies cast through `asUuid` before threading the
 * value into the branded `Uuid`-typed mutation builders.
 */
export const uuidInputSchema = z.string().min(1);

// ── Snapshot helpers ────────────────────────────────────────────────

/**
 * Empty `caseListConfig` snapshot used when a module has no config
 * yet. Three slots: `columns` and `searchInputs` start as empty
 * arrays, `filter` is omitted (the schema treats absence as "no
 * filter" — writing a literal `undefined` would round-trip as an
 * explicit clear at the reducer's `Object.assign`).
 *
 * Exposed as a builder rather than a frozen constant so each call gets
 * its own array literals — defense in depth against a tool body
 * mutating the array in place.
 */
export function emptyCaseListConfig(): CaseListConfig {
	return { columns: [], searchInputs: [] };
}

/**
 * Pick the existing `caseListConfig` snapshot off the supplied module
 * entity, falling back to an empty config when the module has none.
 * Read by `setCaseListFilter` before applying its slot-specific
 * mutation so the surrounding slots survive the patch. The atomic-op
 * tools route through `lib/agent/blueprintHelpers.ts`'s case-list
 * mutation builders, which snapshot internally; this helper is for
 * the wholesale tools that apply their own patch shape.
 */
export function baseCaseListConfig(mod: Module): CaseListConfig {
	return mod.caseListConfig ?? emptyCaseListConfig();
}
