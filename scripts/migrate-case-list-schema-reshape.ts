/**
 * Reshape every persisted module's case-list config to the v2 shape
 * in one pass. Two source shapes feed in; one target shape comes out.
 *
 * Source shapes (per-module, three-way idempotency at the top of the
 * loop):
 *
 *   - **v0** — pre-`caseListConfig` legacy module with parallel
 *     `mod.caseListColumns: { field, header }[]` +
 *     `mod.caseDetailColumns: { field, header }[]` arrays at the
 *     module top level. No structured `caseListConfig` slot.
 *   - **v1** — structured `mod.caseListConfig` with parallel arrays:
 *     `columns[]`, `sort: SortKey[]`, `calculatedColumns[]`,
 *     `searchInputs[]`, optional `detailColumns?: Column[]`,
 *     optional `filter?: Predicate`. Columns are kind-discriminated
 *     unions including the now-gone `search-only` / `time-since-until`
 *     / `late-flag` arms.
 *   - **v2** (target) — `mod.caseListConfig` with three slots:
 *     `columns: Column[]` (every column carries `uuid`, optional
 *     `sort`, optional `visibleInList` / `visibleInDetail`; calc is
 *     a column kind), `filter?: Predicate`, `searchInputs:
 *     SearchInputDef[]` (discriminated `simple` / `advanced` union
 *     with `predicate` on the advanced arm).
 *
 * Decision tree per module — checked in order; first match wins:
 *
 *   1. Survey-only module (`caseListConfig === undefined` AND no v0
 *      top-level fields). Silent skip — there is nothing to migrate.
 *   2. v2 parse on `mod.caseListConfig` succeeds. Skip with a
 *      `version=v2-skipped` log line.
 *   3. v0 detected by `Array.isArray(caseListColumns) ||
 *      Array.isArray(caseDetailColumns)`. Run v0→v2 arm.
 *   4. Inline `legacyV1ConfigSchema.safeParse(mod.caseListConfig)`
 *      succeeds. Run v1→v2 arm.
 *   5. Otherwise — corrupt module. Log WARN with module uuid, bump
 *      `failedCount`, leave the module's slot in place. The whole
 *      app's blueprint write is suspect on any corrupt module — the
 *      per-app try / catch (downstream) treats a corrupt module as a
 *      throw to keep the partial-app shape from leaking through.
 *
 * Per-`searchInput` corrupt-input warnings (a missing `property` on
 * an `xpath`-less v1 input) increment a separate `corruptInputCount`
 * counter; the bad input is dropped, the rest of the input list
 * migrates, and the module's output still parses. Distinct from the
 * module-level `failedCount` above.
 *
 * Safety contract:
 *
 *   - **Dry-run is the default.** Bare invocation scans + classifies
 *     + logs without any Firestore writes; the operator must pass
 *     `--write` to take the live-write path. Production data lives
 *     on the v0 shape, so flipping a doc's `caseListConfig` is
 *     destructive — the cautious default protects against the
 *     "ran the wrong command" failure mode. `--dry-run` is still
 *     accepted as an explicit no-op for shell-history compatibility.
 *   - `--app-id=<id>` for surgical retry.
 *   - Server-side `deleted_at == null` AND `status == "complete"`
 *     filter on the bulk apps query. The `--app-id` path bypasses
 *     the filter.
 *   - Per-app `try / catch` so one bad doc cannot abort the run.
 *   - Per-doc OUTPUT validates against `caseListConfigSchema` before
 *     any Firestore write — the same chokepoint catches v0-style
 *     `field: undefined` legacy entries that Firestore's
 *     `ignoreUndefinedProperties: true` would otherwise round-trip
 *     as a column missing its required `field` slot.
 *   - Per-doc + per-module log lines including the source-version
 *     tag (`v0` / `v1` / `v2-skipped` / `corrupt`) so the operator
 *     can scan a 1000-app run for the breakdown.
 *
 * Usage:
 *   npx tsx scripts/migrate-case-list-schema-reshape.ts                       # dry-run (default)
 *   npx tsx scripts/migrate-case-list-schema-reshape.ts --write               # live writes
 *   npx tsx scripts/migrate-case-list-schema-reshape.ts --app-id=abc123       # dry-run, single app
 *   npx tsx scripts/migrate-case-list-schema-reshape.ts --app-id=abc123 --write
 *   npx tsx scripts/migrate-case-list-schema-reshape.ts --help
 */

import "dotenv/config";
import { z } from "zod";
import { getDb } from "@/lib/db/firestore";
import {
	asUuid,
	type CaseListConfig,
	type Column,
	caseListConfigSchema,
	type SearchInputDef,
	type Uuid,
} from "@/lib/domain";
import {
	predicateSchema,
	relationPathSchema,
	valueExpressionSchema,
} from "@/lib/domain/predicate";
import { log } from "@/lib/logger";

// ── Inline v1 (legacy) schema — parse-only ───────────────────────────
//
// The live `caseListConfigSchema` is the v2 shape. The migration needs
// to identify v1-shaped docs so it can run the v1→v2 arm; that
// requires a parser for the v1 shape. We snapshot the v1 schema inline
// here as parse-only types — we never CONSTRUCT v1 docs from this
// migration, only RECOGNIZE them.
//
// Detection-only constraints:
//
//   - Every kind / type the v1 schema accepted is enumerated; missing
//     one would silently route a real-world v1 doc into the corrupt
//     arm.
//   - Field-level validations match the v1 schema verbatim
//     (e.g. `pattern: z.string().min(1)` on date columns) so a v1 doc
//     that round-trips through this parser carries the same shape
//     guarantees the v1 live schema enforced at write time.
//
// This is the only place legacy v1 schemas exist in the repository.

const legacyV1IdMappingEntrySchema = z.object({
	value: z.string(),
	label: z.string(),
});

const legacyV1TimeSinceUnits = ["days", "weeks", "months", "years"] as const;

const legacyV1PlainColumnSchema = z.object({
	kind: z.literal("plain"),
	field: z.string(),
	header: z.string(),
});

const legacyV1DateColumnSchema = z.object({
	kind: z.literal("date"),
	field: z.string(),
	header: z.string(),
	pattern: z.string().min(1),
});

const legacyV1TimeSinceUntilColumnSchema = z.object({
	kind: z.literal("time-since-until"),
	field: z.string(),
	header: z.string(),
	threshold: z.number(),
	unit: z.enum(legacyV1TimeSinceUnits),
	displayLabel: z.string(),
});

const legacyV1PhoneColumnSchema = z.object({
	kind: z.literal("phone"),
	field: z.string(),
	header: z.string(),
});

const legacyV1IdMappingColumnSchema = z.object({
	kind: z.literal("id-mapping"),
	field: z.string(),
	header: z.string(),
	mapping: z.array(legacyV1IdMappingEntrySchema),
});

const legacyV1LateFlagColumnSchema = z.object({
	kind: z.literal("late-flag"),
	field: z.string(),
	header: z.string(),
	threshold: z.number(),
	unit: z.enum(legacyV1TimeSinceUnits),
	flagDisplayValue: z.string(),
});

const legacyV1SearchOnlyColumnSchema = z.object({
	kind: z.literal("search-only"),
	field: z.string(),
	header: z.string(),
});

const legacyV1ColumnSchema = z.discriminatedUnion("kind", [
	legacyV1PlainColumnSchema,
	legacyV1DateColumnSchema,
	legacyV1TimeSinceUntilColumnSchema,
	legacyV1PhoneColumnSchema,
	legacyV1IdMappingColumnSchema,
	legacyV1LateFlagColumnSchema,
	legacyV1SearchOnlyColumnSchema,
]);
type LegacyV1Column = z.infer<typeof legacyV1ColumnSchema>;

const legacyV1SortTypes = ["plain", "date", "integer", "decimal"] as const;
const legacyV1SortDirections = ["asc", "desc"] as const;

const legacyV1SortConfigSchema = z.object({
	type: z.enum(legacyV1SortTypes),
	direction: z.enum(legacyV1SortDirections),
});

const legacyV1CalculatedColumnSchema = z.object({
	id: z.string(),
	header: z.string(),
	expression: valueExpressionSchema,
	sort: legacyV1SortConfigSchema.optional(),
});
type LegacyV1CalculatedColumn = z.infer<typeof legacyV1CalculatedColumnSchema>;

const legacyV1SortKeySourceSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("property"), property: z.string() }),
	z.object({ kind: z.literal("calculated"), columnId: z.string() }),
]);

const legacyV1SortKeySchema = z.object({
	source: legacyV1SortKeySourceSchema,
	type: z.enum(legacyV1SortTypes),
	direction: z.enum(legacyV1SortDirections),
});
type LegacyV1SortKey = z.infer<typeof legacyV1SortKeySchema>;

const legacyV1SearchInputTypes = [
	"text",
	"select",
	"date",
	"date-range",
	"barcode",
] as const;

const legacyV1MultiSelectQuantifiers = ["any", "all"] as const;

const legacyV1SearchInputModeSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("exact") }),
	z.object({ kind: z.literal("fuzzy") }),
	z.object({ kind: z.literal("starts-with") }),
	z.object({ kind: z.literal("phonetic") }),
	z.object({ kind: z.literal("fuzzy-date") }),
	z.object({ kind: z.literal("range") }),
	z.object({
		kind: z.literal("multi-select-contains"),
		quantifier: z.enum(legacyV1MultiSelectQuantifiers),
	}),
]);

/** Legacy v1 search input — no `kind` discriminator, parallel
 *  `(property, mode, via)` and `xpath` slots. The migration's v1→v2
 *  arm picks the `simple` / `advanced` arm based on whether `xpath`
 *  is present. */
const legacyV1SearchInputSchema = z.object({
	name: z.string(),
	label: z.string(),
	type: z.enum(legacyV1SearchInputTypes),
	property: z.string().optional(),
	via: relationPathSchema.optional(),
	mode: legacyV1SearchInputModeSchema.optional(),
	default: valueExpressionSchema.optional(),
	xpath: predicateSchema.optional(),
});
type LegacyV1SearchInput = z.infer<typeof legacyV1SearchInputSchema>;

const legacyV1ConfigSchema = z.object({
	columns: z.array(legacyV1ColumnSchema),
	sort: z.array(legacyV1SortKeySchema),
	filter: predicateSchema.optional(),
	calculatedColumns: z.array(legacyV1CalculatedColumnSchema),
	searchInputs: z.array(legacyV1SearchInputSchema),
	detailColumns: z.array(legacyV1ColumnSchema).optional(),
});
type LegacyV1Config = z.infer<typeof legacyV1ConfigSchema>;

// ── v0 (legacy top-level) shape ──────────────────────────────────────
//
// Pre-`caseListConfig` modules carried two parallel `{ field, header }`
// arrays at the module top level. The `field: undefined` shape is
// preserved by Firestore's `ignoreUndefinedProperties: true` round-trip
// as the absence of the slot — so the migration validates the OUTPUT
// shape downstream rather than rejecting structurally-malformed v0
// rows here at the read boundary.

interface LegacyV0Column {
	field?: unknown;
	header?: unknown;
}

// ── Migrable module shape ────────────────────────────────────────────

/** Source-shape envelope — the migration treats every persisted
 *  module as carrying optional v0 top-level fields AND an optional
 *  `caseListConfig` slot. The decision tree picks the migration arm
 *  by inspecting these three slots. */
interface MigrableModule {
	uuid?: unknown;
	caseListColumns?: LegacyV0Column[];
	caseDetailColumns?: LegacyV0Column[];
	caseListConfig?: unknown;
	[key: string]: unknown;
}

// ── Source-version classification ────────────────────────────────────
//
// The decision-tree's "version" enum surfaces in every per-module log
// line so the operator can scan a 1000-app run for the breakdown.
// `corrupt` is the only arm that increments `failedCount`.

type SourceVersion = "v0" | "v1" | "v2-skipped" | "corrupt" | "no-config";

interface VersionDecision {
	readonly version: SourceVersion;
	/** Present only on `v1` — the pre-parsed legacy config the
	 *  v1→v2 arm consumes. Threading the parsed value through avoids
	 *  re-parsing the same shape on the migration arm. */
	readonly legacyV1?: LegacyV1Config;
}

/**
 * Keys that exist on the v1 schema's `caseListConfig` shape but are
 * absent on the v2 schema. Their presence on a slot is the
 * structural signal that the slot has not yet been reshaped to v2;
 * the v2 idempotency arm rejects any slot carrying one of these so
 * the per-doc write is not silently a no-op (which would leave the
 * v1-only keys lingering on disk).
 */
const V1_ONLY_KEYS = ["sort", "calculatedColumns", "detailColumns"] as const;

/**
 * Classify a module's case-list shape by walking the decision tree
 * top-to-bottom. The first matching arm wins; subsequent checks are
 * skipped. Surveys-only modules (no v0 top-level fields, no
 * `caseListConfig`) collapse to `no-config` — silent skip with no log.
 *
 * Pure over `mod`; no I/O.
 *
 * Decision-tree order: (1) v2-skipped (already-migrated idempotency),
 * (2) v0, (3) v1, (4) corrupt. The v2 idempotency arm requires both
 * a successful `caseListConfigSchema.safeParse` AND zero v1-only
 * keys on the slot — without the second condition, the empty-array
 * v1 fixture (e.g. a survey-shaped module with empty
 * `columns / sort / calc / inputs`) would parse against v2 with
 * `strip` mode dropping the v1-only keys, and the per-doc write
 * would skip without trimming them.
 */
export function classifyModuleVersion(mod: MigrableModule): VersionDecision {
	const hasV0TopLevel =
		Array.isArray(mod.caseListColumns) || Array.isArray(mod.caseDetailColumns);
	const hasConfigSlot = mod.caseListConfig !== undefined;

	// Survey-only — nothing authored at any layer.
	if (!hasV0TopLevel && !hasConfigSlot) {
		return { version: "no-config" };
	}

	const slot = mod.caseListConfig;
	const slotIsObject = slot !== null && typeof slot === "object";
	const carriesV1OnlyKey = slotIsObject && V1_ONLY_KEYS.some((k) => k in slot);

	// v2 idempotency — slot parses against v2 AND has no v1-only
	// keys. Both gates required so an empty-array v1 doc (which
	// happens to satisfy v2's `strip`-mode parse) routes to the v1
	// arm and gets the v1-only keys trimmed on write.
	if (slotIsObject && !carriesV1OnlyKey) {
		const v2Parse = caseListConfigSchema.safeParse(slot);
		if (v2Parse.success) {
			return { version: "v2-skipped" };
		}
	}

	// v0 detection — top-level legacy arrays. Routes ahead of v1
	// because v0 is unambiguously a top-level shape; a mixed-state
	// doc (top-level v0 fields AND a partial `caseListConfig`)
	// migrates from the authoritative v0 source.
	if (hasV0TopLevel) {
		return { version: "v0" };
	}

	// v1 detection — the v1 schema parses on the slot.
	if (slotIsObject) {
		const v1Parse = legacyV1ConfigSchema.safeParse(slot);
		if (v1Parse.success) {
			return { version: "v1", legacyV1: v1Parse.data };
		}
	}

	// None of the above — the slot is present but unrecognized.
	return { version: "corrupt" };
}

// ── Uuid mint helper ─────────────────────────────────────────────────
//
// Both arms need fresh uuids: v0 generates a uuid for every legacy
// `(field, header)` pair; v1 generates a uuid for every plain / date /
// phone / id-mapping / interval / search-input row, and falls back to
// a fresh mint when the v1 calc-column's `id` slot is empty (the v2
// uuid schema rejects empty strings, so the calc-column's `id` cannot
// always become the new `uuid` verbatim).

function newUuid(): Uuid {
	return asUuid(crypto.randomUUID());
}

// ── v0 → v2 transformation arm ───────────────────────────────────────
//
// The v0 source has only `(field, header)` pairs split across
// `caseListColumns` (visible in the case list) and `caseDetailColumns`
// (visible in the case detail). The v2 target carries one column array
// with per-column visibility flags. The transformation:
//
//   1. Walk `caseListColumns` first. Every entry becomes a v2 plain
//      column with `visibleInList: true`. If the same `field` also
//      appears in `caseDetailColumns`, the column gets
//      `visibleInDetail: true`; otherwise `visibleInDetail: false`.
//   2. Walk `caseDetailColumns`. Entries whose `field` is NOT in
//      `caseListColumns` become detail-only v2 plain columns —
//      `visibleInList: false`, `visibleInDetail: true`.
//
// Header collisions: when the same `field` appears in both legacy
// arrays with DIFFERENT `header` values, the `caseListColumns` header
// wins (the more visible surface). The migration logs an INFO so the
// operator knows the legacy detail header was dropped.
//
// `caseListConfig.filter` and `searchInputs[]` start empty.

interface MigrationContext {
	/** Identifies the doc + module in log lines so the operator can
	 *  cross-reference WARN / INFO output against Firestore. */
	readonly appId: string;
	readonly moduleUuid: string;
}

/**
 * Coerce a v0 row's `(field, header)` pair to strings. The schema's
 * `ignoreUndefinedProperties: true` round-trip preserves non-string
 * values verbatim, so the OUTPUT validation step at the call boundary
 * rejects any row whose `field` / `header` is missing.
 */
function readV0Cell(
	cell: LegacyV0Column,
): { field: string; header: string } | undefined {
	const field = typeof cell.field === "string" ? cell.field : undefined;
	const header = typeof cell.header === "string" ? cell.header : undefined;
	if (field === undefined || header === undefined) return undefined;
	return { field, header };
}

/**
 * Build the v2 column array from the v0 source. Order:
 * `caseListColumns` first, then any detail-only columns in
 * `caseDetailColumns` order. Header collisions log INFO and the
 * caseList header wins.
 */
function transformV0Columns(
	listSrc: LegacyV0Column[],
	detailSrc: LegacyV0Column[],
	ctx: MigrationContext,
): Column[] {
	// Index detail columns by `field` for O(1) presence + header
	// lookup during the list-columns walk.
	const detailByField = new Map<string, string>();
	for (const cell of detailSrc) {
		const parsed = readV0Cell(cell);
		if (parsed === undefined) continue;
		detailByField.set(parsed.field, parsed.header);
	}

	const out: Column[] = [];
	const fieldsInList = new Set<string>();

	for (const cell of listSrc) {
		const parsed = readV0Cell(cell);
		if (parsed === undefined) continue;
		const detailHeader = detailByField.get(parsed.field);
		const visibleInDetail = detailHeader !== undefined;

		// Header collision — same field in both arrays, different
		// header. The caseList header wins; the detail header is
		// dropped with an INFO log line so the operator knows.
		if (detailHeader !== undefined && detailHeader !== parsed.header) {
			log.info(
				`[migrate-case-list-schema-reshape] header collision for app=${ctx.appId} module=${ctx.moduleUuid} field=${parsed.field}: kept "${parsed.header}", dropped "${detailHeader}"`,
			);
		}

		out.push({
			uuid: newUuid(),
			kind: "plain",
			field: parsed.field,
			header: parsed.header,
			visibleInList: true,
			visibleInDetail,
		});
		fieldsInList.add(parsed.field);
	}

	for (const cell of detailSrc) {
		const parsed = readV0Cell(cell);
		if (parsed === undefined) continue;
		// Already covered by the listSrc walk — skip.
		if (fieldsInList.has(parsed.field)) continue;
		out.push({
			uuid: newUuid(),
			kind: "plain",
			field: parsed.field,
			header: parsed.header,
			visibleInList: false,
			visibleInDetail: true,
		});
	}

	return out;
}

function transformV0(
	mod: MigrableModule,
	ctx: MigrationContext,
): CaseListConfig {
	const listSrc = Array.isArray(mod.caseListColumns) ? mod.caseListColumns : [];
	const detailSrc = Array.isArray(mod.caseDetailColumns)
		? mod.caseDetailColumns
		: [];
	return {
		columns: transformV0Columns(listSrc, detailSrc, ctx),
		searchInputs: [],
	};
}

// ── v1 → v2 transformation arm ───────────────────────────────────────
//
// The v1 source carries parallel arrays. The transformation:
//
//   1. Walk `columns[]` and convert each kind to its v2 equivalent.
//      `search-only` becomes plain + `visibleInList: false`.
//      `time-since-until` becomes interval + `display: "always"`.
//      `late-flag` becomes interval + `display: "flag"`. Other arms
//      pass through unchanged structurally — the schema-shape diff is
//      the addition of `uuid`, optional `sort`, and optional
//      visibility flags. Each column gets a fresh uuid.
//   2. Walk `calculatedColumns[]` and append each as a `kind:
//      "calculated"` column. The v1 `id` becomes the v2 `uuid` when
//      non-empty; an empty `id` mints a fresh uuid (the v2 uuid
//      schema rejects empty strings).
//   3. Walk `sort[]` and distribute each `SortKey` onto the matching
//      column. Property-source keys match by `column.field`; calc-
//      source keys match by the calc column's resolved uuid (built
//      in the calc walk above). Priority is the sort-array index.
//   4. If `detailColumns[]` is present, distribute `visibleInList:
//      false` flags onto columns NOT in `detailColumns`; add any
//      detail-only columns from `detailColumns` not already present
//      with `visibleInList: false`.
//   5. Walk `searchInputs[]` and dispatch per `xpath` presence: with
//      `xpath` → `kind: "advanced"` carrying `predicate` (the
//      `xpath` body); without → `kind: "simple"` carrying
//      `(property, mode, via)`. A simple input lacking `property` is
//      a corrupt input — log WARN, bump `corruptInputCount`, drop
//      it. The rest of the input list still migrates; the module's
//      output still parses.
//   6. Filter is preserved verbatim.

/** Per-doc counters returned by the v1→v2 arm — bubbles up to the
 *  per-app summary so the operator sees the corrupt-input total. */
interface V1ArmCounters {
	corruptInputCount: number;
}

/**
 * Match key for non-calc display columns — used to align v2 columns
 * to legacy `detailColumns` entries by content. v1 docs round-trip
 * through Firestore, so reference equality across the parsed
 * `columns` and `detailColumns` arrays is unreliable even when they
 * pointed to the same in-memory object pre-persistence; the match
 * key resolves identity by `kind:field`. The v1 schema's
 * `detailColumns` is `Column[]` (display kinds only — no calc), so
 * one match-key shape covers every detail entry.
 */
function nonCalcMatchKey(col: LegacyV1Column): string {
	return `${col.kind}:${col.field}`;
}

/**
 * Determine sort source's resolved match — for property keys, the
 * key is `prop:${property}`; for calc keys, `calc:${columnId}`. The
 * sort distribution uses these to find the column that owns the
 * sort directive.
 */
function sortKeyMatch(key: LegacyV1SortKey): string {
	if (key.source.kind === "property") return `prop:${key.source.property}`;
	return `calc:${key.source.columnId}`;
}

/**
 * Match a v2 column to a v1 sort key's source. Property keys match
 * any non-calc column whose `field` equals the property; calc keys
 * match the calc column tracked by its prior `id`.
 */
function columnSortMatchKey(
	col: Column,
	calcUuidByLegacyId: ReadonlyMap<string, Uuid>,
): string | undefined {
	if (col.kind === "calculated") {
		// Reverse-lookup: find the legacy id whose freshly-resolved
		// uuid matches this column. Sort keys reference the legacy id,
		// so the comparison runs through the legacy-id key.
		for (const [legacyId, uuid] of calcUuidByLegacyId.entries()) {
			if (uuid === col.uuid) return `calc:${legacyId}`;
		}
		return undefined;
	}
	return `prop:${col.field}`;
}

function convertV1Column(col: LegacyV1Column): Column {
	const uuid = newUuid();
	switch (col.kind) {
		case "plain":
			return { uuid, kind: "plain", field: col.field, header: col.header };
		case "date":
			return {
				uuid,
				kind: "date",
				field: col.field,
				header: col.header,
				pattern: col.pattern,
			};
		case "phone":
			return { uuid, kind: "phone", field: col.field, header: col.header };
		case "id-mapping":
			return {
				uuid,
				kind: "id-mapping",
				field: col.field,
				header: col.header,
				mapping: col.mapping,
			};
		case "time-since-until":
			return {
				uuid,
				kind: "interval",
				field: col.field,
				header: col.header,
				threshold: col.threshold,
				unit: col.unit,
				display: "always",
				text: col.displayLabel,
			};
		case "late-flag":
			return {
				uuid,
				kind: "interval",
				field: col.field,
				header: col.header,
				threshold: col.threshold,
				unit: col.unit,
				display: "flag",
				text: col.flagDisplayValue,
			};
		case "search-only":
			return {
				uuid,
				kind: "plain",
				field: col.field,
				header: col.header,
				visibleInList: false,
			};
	}
}

function convertV1Calc(calc: LegacyV1CalculatedColumn): {
	column: Extract<Column, { kind: "calculated" }>;
	legacyId: string;
} {
	// v1 `id` becomes the new `uuid` when non-empty. The v2 uuid
	// schema's `min(1)` rejects empties, so an empty legacy id mints
	// a fresh uuid — sort-key references that pointed at the empty
	// id rewrite to the freshly minted uuid via the calc-by-legacy-id
	// map below.
	const uuid = calc.id.length > 0 ? asUuid(calc.id) : newUuid();
	return {
		column: {
			uuid,
			kind: "calculated",
			header: calc.header,
			expression: calc.expression,
		},
		legacyId: calc.id,
	};
}

function convertV1SearchInput(
	input: LegacyV1SearchInput,
	ctx: MigrationContext,
	counters: V1ArmCounters,
): SearchInputDef | undefined {
	const uuid = newUuid();
	const common = {
		uuid,
		name: input.name,
		label: input.label,
		type: input.type,
	};

	// Advanced arm — `xpath` present. The `(property, mode, via)`
	// slots are dropped per the v2 discriminated shape; preserving
	// them would fail the v2 schema parse on the advanced arm.
	if (input.xpath !== undefined) {
		const out: SearchInputDef = {
			...common,
			kind: "advanced",
			predicate: input.xpath,
		};
		if (input.default !== undefined) out.default = input.default;
		return out;
	}

	// Simple arm — `(property, mode, via)`. `property` is required
	// at the v2 simple arm; an `xpath`-less input lacking property
	// is a corrupt input. Log + drop.
	if (input.property === undefined) {
		log.warn(
			`[migrate-case-list-schema-reshape] corrupt search input on app=${ctx.appId} module=${ctx.moduleUuid} name=${input.name}: dropped (no xpath, no property)`,
		);
		counters.corruptInputCount += 1;
		return undefined;
	}

	const out: SearchInputDef = {
		...common,
		kind: "simple",
		property: input.property,
	};
	if (input.default !== undefined) out.default = input.default;
	if (input.via !== undefined && input.via.kind !== "self") out.via = input.via;
	if (input.mode !== undefined) out.mode = input.mode;
	return out;
}

function transformV1(
	src: LegacyV1Config,
	ctx: MigrationContext,
	counters: V1ArmCounters,
): CaseListConfig {
	// 1. Convert non-calc columns. Track each row's content match-key
	//    (`kind:field`) so the detail-membership distribution can
	//    align v2 columns to detailColumns entries by content.
	const columns: Column[] = src.columns.map(convertV1Column);
	const columnSrcMatchKeys: string[] = src.columns.map(nonCalcMatchKey);

	// 2. Convert calc columns. Track the legacy id → resolved uuid
	//    map so sort-key references can rewrite through it. Append
	//    each calc's content match-key (`calc:${id}`) onto the
	//    parallel array so detail membership can address calcs by id.
	const calcUuidByLegacyId = new Map<string, Uuid>();
	for (const calc of src.calculatedColumns) {
		const { column, legacyId } = convertV1Calc(calc);
		columns.push(column);
		columnSrcMatchKeys.push(`calc:${legacyId}`);
		// Empty legacy ids cannot be used as a map key for sort-key
		// reverse lookup — skip the index entry. Sort keys against
		// empty-id calcs cannot be rewritten and fall through to the
		// "no match" branch below; the sort directive is dropped.
		if (legacyId.length > 0) calcUuidByLegacyId.set(legacyId, column.uuid);
	}

	// 3. Distribute sort. Build an index from column match-key →
	//    column position so the per-key walk is O(1) per key.
	const colIndexByKey = new Map<string, number>();
	for (let i = 0; i < columns.length; i += 1) {
		const key = columnSortMatchKey(columns[i], calcUuidByLegacyId);
		if (key !== undefined && !colIndexByKey.has(key)) {
			colIndexByKey.set(key, i);
		}
	}
	for (let priority = 0; priority < src.sort.length; priority += 1) {
		const key = src.sort[priority];
		const matchKey = sortKeyMatch(key);
		const colIndex = colIndexByKey.get(matchKey);
		// No matching column — the sort directive's source has no
		// resolvable column. Drop it; the v2 shape has no parallel
		// sort array to leak into.
		if (colIndex === undefined) continue;
		columns[colIndex] = {
			...columns[colIndex],
			sort: { direction: key.direction, priority },
		};
	}

	// 4. Distribute visibility from `detailColumns`. The v1 doc
	//    treated `detailColumns` as the long-detail override; absent
	//    ≡ "long detail mirrors short detail's columns". When
	//    present, columns NOT in detail get `visibleInDetail: false`,
	//    and detail-only columns (display entries in detail but not
	//    in `columns`) join the v2 columns array with `visibleInList:
	//    false`. The v1 `detailColumns` schema is `Column[]` (display
	//    kinds only — no calc), so the detail walk only routes
	//    through the non-calc converter.
	const detail = src.detailColumns;
	if (detail !== undefined) {
		const detailKeys = new Set(detail.map(nonCalcMatchKey));
		// Mark every existing column's `visibleInDetail` based on
		// membership.
		for (let i = 0; i < columns.length; i += 1) {
			const matchKey = columnSrcMatchKeys[i];
			columns[i] = {
				...columns[i],
				visibleInDetail: detailKeys.has(matchKey),
			};
		}
		// Detail-only entries — convert each, mark
		// `visibleInList: false`, and append.
		const existingKeys = new Set(columnSrcMatchKeys);
		for (const dCol of detail) {
			const dKey = nonCalcMatchKey(dCol);
			if (existingKeys.has(dKey)) continue;
			const converted = convertV1Column(dCol);
			columns.push({ ...converted, visibleInList: false });
		}
	}

	// 5. Convert search inputs.
	const searchInputs: SearchInputDef[] = [];
	for (const input of src.searchInputs) {
		const converted = convertV1SearchInput(input, ctx, counters);
		if (converted !== undefined) searchInputs.push(converted);
	}

	// 6. Filter passes through verbatim.
	const out: CaseListConfig = { columns, searchInputs };
	if (src.filter !== undefined) out.filter = src.filter;
	return out;
}

// ── Per-module migration ─────────────────────────────────────────────

/** Decision-tree result for one module — the next shape (when
 *  migration applied) plus the source-version tag for the per-module
 *  log line plus per-arm counters. `nextConfig === undefined` means
 *  the module's slot stays as-is (v2-skipped, no-config) or the
 *  module is corrupt and the per-app try / catch will fail the
 *  whole-doc write (corrupt). */
interface ModuleMigrationResult {
	readonly version: SourceVersion;
	readonly nextConfig?: CaseListConfig;
	readonly counters: V1ArmCounters;
}

export function migrateOneModule(
	mod: MigrableModule,
	ctx: MigrationContext,
): ModuleMigrationResult {
	const decision = classifyModuleVersion(mod);
	const counters: V1ArmCounters = { corruptInputCount: 0 };

	switch (decision.version) {
		case "no-config":
		case "v2-skipped":
			return { version: decision.version, counters };
		case "v0":
			return {
				version: "v0",
				nextConfig: transformV0(mod, ctx),
				counters,
			};
		case "v1":
			// Non-null assertion is safe: the classifier returns the
			// parsed legacy data on the v1 arm.
			return {
				version: "v1",
				// biome-ignore lint/style/noNonNullAssertion: classifier guarantees `legacyV1` on the v1 arm
				nextConfig: transformV1(decision.legacyV1!, ctx, counters),
				counters,
			};
		case "corrupt":
			return { version: "corrupt", counters };
	}
}

// ── Per-app migration ────────────────────────────────────────────────
//
// The per-module loop applies the migration to every module in the
// blueprint. The whole-app write only proceeds when:
//
//   - At least one module produced a v0 or v1 next-config (otherwise
//     the doc is already on the v2 shape or has no case lists at
//     all).
//   - Every output `caseListConfig` slot passes
//     `caseListConfigSchema.safeParse` — the OUTPUT validation
//     chokepoint that catches a structurally-broken migration arm
//     before any Firestore write proceeds.
//   - No module classified as `corrupt`. A corrupt module fails the
//     whole-app write — partial-app writes mixing shapes inside one
//     blueprint are not safe.
//
// Throwing on corrupt / output-validation-fail routes the failure
// through the outer `try / catch` so one bad doc does not abort the
// run.

interface BlueprintShape {
	modules?: { [uuid: string]: MigrableModule };
	[key: string]: unknown;
}

export interface PerModuleDiff {
	readonly uuid: string;
	readonly version: SourceVersion;
	readonly columnCount?: number;
	readonly searchInputCount?: number;
}

export interface PerAppMigrateResult {
	readonly blueprint: BlueprintShape;
	readonly migratedModules: number;
	/** Modules whose `caseListConfig` is structurally unrecognized
	 *  (neither v0, v1, nor v2). The caller treats `> 0` as a failure
	 *  signal and skips the whole-app write — partial-app writes
	 *  mixing the corrupt-module's stale shape with rewritten
	 *  siblings would leak inconsistent state. */
	readonly corruptModuleCount: number;
	readonly diffs: PerModuleDiff[];
	readonly corruptInputCount: number;
}

/**
 * Per-app migration. Walks every module in the blueprint, applies
 * the decision tree, and assembles the rewritten blueprint. Surfaces
 * three signals the per-app caller acts on:
 *
 *   - `migratedModules > 0` — the caller persists the rewritten
 *     blueprint when the run is in live-write mode (`--write`),
 *     or skips the write when the run is in the default dry-run
 *     mode.
 *   - `corruptModuleCount > 0` — at least one module's
 *     `caseListConfig` is structurally unrecognized. The caller
 *     bumps `failedCount`, logs WARN, and SKIPS the whole-app write
 *     (a partial-app write mixing the corrupt-module's stale shape
 *     with rewritten siblings would leak inconsistent state).
 *   - `corruptInputCount > 0` — at least one v1 search input lacked
 *     both `xpath` and `property`. Inputs are dropped; the rest of
 *     the input list still migrates. The caller surfaces the count
 *     in the run summary but does not skip the write.
 *
 * Output validation runs on every v0 / v1 result before declaring
 * the migration sound. A failed parse throws so the per-app try /
 * catch routes the failure through the same lane Firestore-write
 * rejections take.
 */
export function migrateAppBlueprint(
	blueprint: BlueprintShape,
	appId: string,
): PerAppMigrateResult {
	const modules = blueprint.modules;
	if (!modules || typeof modules !== "object") {
		return {
			blueprint,
			migratedModules: 0,
			corruptModuleCount: 0,
			diffs: [],
			corruptInputCount: 0,
		};
	}

	const nextModules: { [uuid: string]: MigrableModule } = {};
	const diffs: PerModuleDiff[] = [];
	let corruptInputCount = 0;
	let corruptModuleCount = 0;
	let migratedModules = 0;

	for (const [uuid, mod] of Object.entries(modules)) {
		const ctx: MigrationContext = { appId, moduleUuid: uuid };
		const result = migrateOneModule(mod, ctx);
		corruptInputCount += result.counters.corruptInputCount;

		if (result.version === "corrupt") {
			corruptModuleCount += 1;
			nextModules[uuid] = mod;
			diffs.push({ uuid, version: "corrupt" });
			continue;
		}

		// `no-config` and `v2-skipped` pass through unchanged.
		if (result.nextConfig === undefined) {
			nextModules[uuid] = mod;
			diffs.push({ uuid, version: result.version });
			continue;
		}

		// v0 / v1 — apply the migration. Strip the v0 top-level
		// fields (whether or not they were present) so the doc lands
		// on the v2 shape verbatim. Validate the OUTPUT against the
		// v2 schema before declaring the migration sound.
		const nextMod: MigrableModule = { ...mod };
		delete nextMod.caseListColumns;
		delete nextMod.caseDetailColumns;
		nextMod.caseListConfig = result.nextConfig;

		const parsed = caseListConfigSchema.safeParse(result.nextConfig);
		if (!parsed.success) {
			throw new Error(
				`caseListConfigSchema.safeParse failed at module ${uuid} after ${result.version} migration: ${parsed.error.message}`,
			);
		}

		nextModules[uuid] = nextMod;
		diffs.push({
			uuid,
			version: result.version,
			columnCount: result.nextConfig.columns.length,
			searchInputCount: result.nextConfig.searchInputs.length,
		});
		migratedModules += 1;
	}

	if (migratedModules === 0) {
		return {
			blueprint,
			migratedModules: 0,
			corruptModuleCount,
			diffs,
			corruptInputCount,
		};
	}

	return {
		blueprint: { ...blueprint, modules: nextModules },
		migratedModules,
		corruptModuleCount,
		diffs,
		corruptInputCount,
	};
}

// ── CLI option parsing ───────────────────────────────────────────────

export interface MigrateOptions {
	/** When `true`, scan + classify + log without any Firestore writes.
	 *  Defaults to `true` — production data is on the v0 shape and a
	 *  bare invocation must not mutate every live app doc. Operators
	 *  pass `--write` (the only live-write opt-in) to flip this to
	 *  `false` after they've reviewed the dry-run output. `--dry-run`
	 *  is an explicit no-op against the new dry-run default; accepted
	 *  so operators who pass it explicitly hit the same dry pass. */
	readonly dryRun: boolean;
	/** Surgical-retry path. When set, the run targets one app by id;
	 *  the bulk apps-query filter is bypassed. */
	readonly appId?: string;
	/** Print usage and exit. */
	readonly help: boolean;
}

const HELP_TEXT = [
	"Usage: migrate-case-list-schema-reshape [options]",
	"",
	"  Reshape every persisted module's case-list config to the v2 shape.",
	"  v0 (legacy top-level columns) AND v1 (parallel-array config) sources",
	"  migrate to the v2 three-slot shape in one pass.",
	"",
	"  DEFAULT MODE: dry-run. The script scans, classifies, and logs every",
	"  per-app diff WITHOUT writing to Firestore. The operator must pass",
	"  --write to take the live-write path; this is the only flag that",
	"  flips dry-run off.",
	"",
	"Options:",
	"  --write           Opt INTO live writes. Required to mutate Firestore;",
	"                    without it the run is a dry pass.",
	"  --dry-run         Explicit no-op (dry-run is already the default).",
	"                    Accepted for shell-history compatibility.",
	"  --app-id=<id>     Target one app by id; bypasses the bulk apps query.",
	"  --help, -h        Print this help text and exit.",
	"",
	"Examples:",
	"  # Dry-run pass over every eligible app (default; no writes).",
	"  npx tsx scripts/migrate-case-list-schema-reshape.ts",
	"",
	"  # Live-write pass over every eligible app — only after a dry-run.",
	"  npx tsx scripts/migrate-case-list-schema-reshape.ts --write",
	"",
	"  # Surgical-retry: dry-run a single app.",
	"  npx tsx scripts/migrate-case-list-schema-reshape.ts --app-id=abc123",
	"",
	"  # Surgical-retry: write a single app.",
	"  npx tsx scripts/migrate-case-list-schema-reshape.ts --app-id=abc123 --write",
	"",
	"Per-module log line tags surface the source-version breakdown:",
	"  v0 / v1            migrated; counted toward modulesMigrated",
	"  v2-skipped         already on the new shape; idempotent skip",
	"  corrupt            unrecognized; whole-app write skipped, failedCount++",
].join("\n");

export function parseArgs(argv: readonly string[]): MigrateOptions {
	// Dry-run is the cautious default — production data is on the v0
	// shape and a bare invocation must not mutate every live app doc.
	// `--write` is the only opt-in to live writes; `--dry-run` is an
	// explicit no-op against the dry-run default, accepted so operators
	// who pass it explicitly hit the same dry pass.
	let dryRun = true;
	let appId: string | undefined;
	let help = false;
	for (const arg of argv) {
		if (arg === "--dry-run") {
			// Explicit no-op against the new dry-run default; accepted
			// so operators who pass it explicitly hit the same dry pass.
			dryRun = true;
			continue;
		}
		if (arg === "--write") {
			// The only path to live Firestore writes. Mirrors how
			// most modern destructive CLIs gate on an opt-in verb
			// rather than a no-flag default; reads as an action in
			// help text ("--write live records") rather than a double
			// negation ("--no-dry-run").
			dryRun = false;
			continue;
		}
		if (arg === "--help" || arg === "-h") {
			help = true;
			continue;
		}
		if (arg.startsWith("--app-id=")) {
			const value = arg.slice("--app-id=".length);
			if (value.length === 0) {
				throw new Error("--app-id flag requires a non-empty value");
			}
			appId = value;
			continue;
		}
		throw new Error(`Unrecognized argument: ${arg}`);
	}
	return { dryRun, appId, help };
}

// ── Run summary + main loop ──────────────────────────────────────────

export interface RunSummary {
	readonly scanned: number;
	readonly appsTouched: number;
	readonly modulesMigrated: number;
	readonly failedCount: number;
	readonly corruptInputCount: number;
}

/**
 * The minimal Firestore-doc shape the per-app loop touches. The bulk
 * `query.get()` path and the `doc(appId).get()` surgical-retry path
 * both produce snapshots of this shape. Defining the contract here
 * (rather than importing the `@google-cloud/firestore` types) keeps
 * the test mock surface narrow — the test only stubs what the
 * migration actually uses.
 */
interface AppDocSnapshot {
	readonly id: string;
	data(): { blueprint?: unknown; owner?: unknown } | undefined;
	readonly ref: {
		update(patch: { blueprint: unknown }): Promise<unknown>;
	};
}

/** Per-app processing outcome — counters bubble up to the run-level
 *  summary; `failed: true` is the corrupt-module signal that bumps
 *  `failedCount` without taking the throw lane. */
interface ProcessAppOutcome {
	readonly migratedModules: number;
	readonly corruptInputCount: number;
	readonly failed: boolean;
}

/**
 * Per-app processing — wraps the read / classify / migrate / safeParse
 * / write triplet in one error-bounded unit. Returns the per-app
 * counters the run-level summary aggregates plus a `failed` flag the
 * caller increments `failedCount` on.
 *
 * Two failure surfaces:
 *
 *   - **Corrupt modules** — recognized at classification time, NOT a
 *     thrown exception. The function logs WARN, skips the write,
 *     and returns `failed: true`. Matches the plan's WARN-level
 *     contract for corrupt-module classification.
 *   - **Unforeseen exceptions** — output-safeParse failure or
 *     Firestore write rejection. These propagate through the
 *     promise rejection lane; the caller's `try / catch` handles
 *     them as ERROR-level failures. The two paths are kept distinct
 *     so the operator can tell "I authored a config we can't
 *     parse" (WARN, recoverable) from "the migration's output
 *     itself is broken" (ERROR, programming bug).
 */
async function processApp(
	app: AppDocSnapshot,
	dryRun: boolean,
): Promise<ProcessAppOutcome> {
	const data = app.data() ?? {};
	const blueprint = data.blueprint;
	if (!blueprint || typeof blueprint !== "object") {
		return { migratedModules: 0, corruptInputCount: 0, failed: false };
	}

	const result = migrateAppBlueprint(blueprint as BlueprintShape, app.id);
	const owner = typeof data.owner === "string" ? data.owner : "<unknown>";
	const moduleSummary = result.diffs
		.map(
			(d) =>
				`${d.uuid}(version=${d.version}${
					d.columnCount !== undefined ? ` cols=${d.columnCount}` : ""
				}${
					d.searchInputCount !== undefined
						? ` inputs=${d.searchInputCount}`
						: ""
				})`,
		)
		.join(",");
	log.info(
		`[migrate-case-list-schema-reshape] app=${app.id} owner=${owner} migrated=${result.migratedModules} corruptInputs=${result.corruptInputCount} modules=[${moduleSummary}]`,
	);

	// Corrupt-module signal — log WARN and SKIP the write. A partial-
	// app write mixing the corrupt-module's stale shape with
	// rewritten siblings is the failure mode this gate prevents.
	if (result.corruptModuleCount > 0) {
		const corruptUuids = result.diffs
			.filter((d) => d.version === "corrupt")
			.map((d) => d.uuid)
			.join(",");
		log.warn(
			`[migrate-case-list-schema-reshape] app=${app.id} skipped: ${result.corruptModuleCount} module(s) classified as corrupt (caseListConfig is neither v0, v1, nor v2). Operator triage needed for: ${corruptUuids}`,
		);
		return {
			migratedModules: 0,
			corruptInputCount: result.corruptInputCount,
			failed: true,
		};
	}

	if (result.migratedModules === 0) {
		return {
			migratedModules: 0,
			corruptInputCount: result.corruptInputCount,
			failed: false,
		};
	}

	if (!dryRun) {
		await app.ref.update({ blueprint: result.blueprint });
	}

	return {
		migratedModules: result.migratedModules,
		corruptInputCount: result.corruptInputCount,
		failed: false,
	};
}

/**
 * Drive the migration. Exported so the test surface can invoke it
 * with mocked Firestore handles + structured options instead of
 * scraping `process.argv`.
 *
 * Returns the run-level counters so callers can assert + the CLI
 * entry below decides on a non-zero exit when `failedCount > 0`.
 */
export async function run(options: MigrateOptions): Promise<RunSummary> {
	const { dryRun, appId } = options;

	const db = getDb() as unknown as {
		collection(name: string): {
			where(
				field: string,
				op: string,
				value: unknown,
			): {
				where(
					field: string,
					op: string,
					value: unknown,
				): { get(): Promise<{ docs: AppDocSnapshot[] }> };
			};
			doc(id: string): {
				get(): Promise<AppDocSnapshot & { exists: boolean }>;
			};
		};
	};

	const docs: AppDocSnapshot[] = [];
	if (appId !== undefined) {
		// Surgical-retry path — reads one row by id even when
		// `deleted_at` / `status` would have excluded it from the bulk
		// scan. The operator narrowing to a single id has already
		// weighed whether the row is in scope; the filter would
		// suppress legitimate retries on (e.g.) an `error`-status app
		// the operator wants to revisit after a manual fix.
		const snap = await db.collection("apps").doc(appId).get();
		if (snap.exists) docs.push(snap);
	} else {
		// Bulk path — server-side filter mirrors the codebase
		// convention. Soft-deletes are out of scope; `generating`
		// rows would race the migration; `error` rows have suspect
		// blueprint shape.
		const result = await db
			.collection("apps")
			.where("deleted_at", "==", null)
			.where("status", "==", "complete")
			.get();
		for (const snap of result.docs) docs.push(snap);
	}

	let scanned = 0;
	let appsTouched = 0;
	let modulesMigrated = 0;
	let failedCount = 0;
	let corruptInputCount = 0;

	for (const app of docs) {
		scanned += 1;
		try {
			const r = await processApp(app, dryRun);
			if (r.migratedModules > 0) appsTouched += 1;
			if (r.failed) failedCount += 1;
			modulesMigrated += r.migratedModules;
			corruptInputCount += r.corruptInputCount;
		} catch (err) {
			// Unforeseen exception — output-safeParse failure or
			// Firestore write rejection. Distinct from the corrupt-
			// module path above, which is recognized at classification
			// time and logged WARN by `processApp` directly.
			failedCount += 1;
			log.error(
				`[migrate-case-list-schema-reshape] app=${app.id} failed: ${
					err instanceof Error ? err.message : String(err)
				}`,
				err,
			);
		}
	}

	log.info(
		`[migrate-case-list-schema-reshape] apps_scanned=${scanned} apps_succeeded=${appsTouched} apps_failed=${failedCount} modules_migrated=${modulesMigrated} corrupt_inputs=${corruptInputCount} dryRun=${dryRun}`,
	);

	return {
		scanned,
		appsTouched,
		modulesMigrated,
		failedCount,
		corruptInputCount,
	};
}

// ── CLI entrypoint ───────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
	let opts: MigrateOptions;
	try {
		opts = parseArgs(process.argv.slice(2));
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		console.error("");
		console.error(HELP_TEXT);
		process.exit(2);
	}
	if (opts.help) {
		console.log(HELP_TEXT);
		process.exit(0);
	}
	run(opts)
		.then((summary) => {
			if (summary.failedCount > 0) process.exit(1);
		})
		.catch((err) => {
			console.error(err);
			process.exit(1);
		});
}
