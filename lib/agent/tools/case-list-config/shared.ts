/**
 * Shared input schemas + uuid helpers for the case-list-config SA
 * tools.
 *
 * The case-list config has three slots — `columns`, `filter?`,
 * `searchInputs` — and the SA tool surface decomposes into:
 *
 *   - One wholesale tool for `filter` (`setCaseListFilter`) — a filter
 *     is one Predicate, so the wholesale shape fits.
 *   - Op tools for the two arrays — a list-add (`addCaseListColumns` /
 *     `addSearchInputs`) plus update / remove / reorder for each of
 *     `columns` and `searchInputs`. The add tools take a list (one item is
 *     a length-1 array); the rest keep each call's payload small + the SA's
 *     working memory of authored uuids tractable.
 *
 * The ops route their array-walk + error-shaping through the
 * `addColumnsMutation` / `addSearchInputsMutation` family in
 * `lib/agent/blueprintHelpers.ts` — the same builders any non-SA
 * caller (UI mutation) reuses. This file owns the SA-boundary inputs:
 *
 *   - `columnInputSchema` / `searchInputDefInputSchema` — the
 *     discriminated-union shapes the SA passes when adding or updating
 *     an entry. `uuid` is omitted from each arm; the tool mints it on
 *     `add` and looks it up on `update`.
 *   - `newUuid` — uuid mint helper.
 *
 * The `moduleNotFoundResult` helper is consumed by every case-list-
 * config tool; its definition lives at `tools/shared/` because more
 * than one SA tool family uses it. The re-export below preserves the
 * existing import path inside this family.
 */

import { z } from "zod";
import {
	type Column,
	columnSchema,
	type SearchInputDef,
	type SearchInputType,
	searchInputDefSchema,
	type Uuid,
} from "@/lib/domain";

// `moduleNotFoundResult` is shared across SA tool families (the
// case-list-config quartet here, the case-search-config tools, …) so
// it lives at `tools/shared/`. The re-export below keeps every existing
// case-list-config consumer's import path stable on the relocation.
export { moduleNotFoundResult } from "../shared/moduleNotFoundResult";

// ── Tool input schemas — column + search-input shapes without uuid ──
//
// `addCaseListColumns` mints a fresh uuid per column; `updateCaseListColumn`
// preserves the existing uuid keyed by `columnUuid`. Both accept the
// same kind-discriminated body, so we reuse one input schema across
// both surfaces. Same approach for the search-input tools.
//
// Each arm comes from `columnSchema.options` / `searchInputDefSchema.options`
// with `uuid` and `order` omitted — both are tool-owned (uuid minted on add /
// carried on update; the fractional `order` sort key is computed by the
// gesture/diff layer, never authored by the SA). Destructuring per-arm preserves the TS-inferred
// per-arm shape so the discriminated union retypes cleanly — the
// `Iterable<ZodObject>.map(...)` form drops the per-arm narrowing into
// a non-callable union TS can't dispatch through `omit`.

// Positional destructure of the domain `columnSchema` arms — the order
// MUST track `columnSchema`'s `z.discriminatedUnion([...])` member order
// in `lib/domain/modules.ts`. Adding a column kind there requires adding
// it here (and to `columnInputSchema` below) in the same position.
const [
	plainColumnArm,
	dateColumnArm,
	phoneColumnArm,
	idMappingColumnArm,
	imageMapColumnArm,
	intervalColumnArm,
	calculatedColumnArm,
] = columnSchema.options;

/**
 * Per-arm `Column` schema with the `uuid` and `order` slots omitted.
 * Surface the SA passes when adding or updating a column — the uuid is owned
 * by the tool (minted on add, looked up by `columnUuid` on update) and the
 * fractional `order` sort key is computed by the gesture/diff layer.
 */
export const columnInputSchema = z.discriminatedUnion("kind", [
	plainColumnArm.omit({ uuid: true, order: true }),
	dateColumnArm.omit({ uuid: true, order: true }),
	phoneColumnArm.omit({ uuid: true, order: true }),
	idMappingColumnArm.omit({ uuid: true, order: true }),
	imageMapColumnArm.omit({ uuid: true, order: true }),
	intervalColumnArm.omit({ uuid: true, order: true }),
	calculatedColumnArm.omit({ uuid: true, order: true }),
]);
export type ColumnInput = z.infer<typeof columnInputSchema>;

const [simpleSearchInputArm, advancedSearchInputArm] =
	searchInputDefSchema.options;

/**
 * The widget kinds the SA (and MCP clients) can author — the domain
 * enum minus `select`. Nova's wire prompt carries no itemset slot, so
 * CCHQ renders a `select` prompt as a plain text input
 * (`QueryPrompt.isSelect()` is false without an `<itemset>` child):
 * the validator rejects the simple-arm shape outright
 * (`searchInputSelectWidgetNotSupported`) and the advanced-arm shape
 * silently degrades to text. Neither is a state the model should be
 * able to express, so the tool boundary narrows the enum instead of
 * letting the gate (or the runtime) break the news. The domain enum
 * keeps `select` for the day the wire grows an itemset source.
 */
export const SA_SEARCH_INPUT_TYPES = [
	"text",
	"date",
	"date-range",
	"barcode",
] as const satisfies readonly SearchInputType[];

const saSearchInputType = z
	.enum(SA_SEARCH_INPUT_TYPES)
	.describe(
		"Widget the search screen renders for this input. There is no dropdown widget — filter a fixed-option property with a `text` input, or compose the membership check as an advanced-arm `selected(...)` predicate.",
	);

/**
 * Per-arm `SearchInputDef` schema with the `uuid` and `order` slots omitted
 * and the `type` enum narrowed to the SA-authorable widget kinds.
 * Mirrors `columnInputSchema` for the search-input add / update tools.
 */
export const searchInputDefInputSchema = z.discriminatedUnion("kind", [
	simpleSearchInputArm
		.omit({ uuid: true, order: true })
		.extend({ type: saSearchInputType }),
	advancedSearchInputArm
		.omit({ uuid: true, order: true })
		.extend({ type: saSearchInputType }),
]);
export type SearchInputDefInput = z.infer<typeof searchInputDefInputSchema>;

// ── Uuid stamp helpers ──────────────────────────────────────────────
//
// The two stamp helpers below lift a uuid-less SA input back onto the
// canonical domain shape (`Column`, `SearchInputDef`) by spreading the
// minted (or carried-through) uuid into the object. Their cast lives
// adjacent to the per-arm-omit machinery that makes the cast necessary
// — keeping the rationale and the workaround in one place.

/**
 * Stamp the supplied uuid onto a kind-discriminated input column. The
 * cast is required because TS does not preserve per-arm narrowing
 * across a spread on a discriminated union — the structural identity
 * of each arm is preserved at runtime, but the resulting object's
 * static type widens to `Record<string, unknown>` after the spread.
 * The cast funnels back through `Column`, which is exactly the shape
 * the spread produces (every arm of `Column` carries `uuid` plus the
 * arm's discriminator + per-kind fields, all of which `column` already
 * supplies).
 *
 * Used by `addCaseListColumns` (uuid minted via `newUuid`) and
 * `updateCaseListColumn` (uuid carried through from `columnUuid`).
 */
export function stampColumnUuid(column: ColumnInput, uuid: Uuid): Column {
	return { ...column, uuid } as Column;
}

/**
 * Stamp the supplied uuid onto a kind-discriminated input search
 * input. Same per-arm-narrowing reasoning as `stampColumnUuid` —
 * spread on a discriminated union widens to `Record<string, unknown>`
 * statically, and the cast funnels back through `SearchInputDef`.
 *
 * Used by `addSearchInputs` (uuid minted via `newUuid`) and
 * `updateSearchInput` (uuid carried through from `searchInputUuid`).
 */
export function stampSearchInputUuid(
	input: SearchInputDefInput,
	uuid: Uuid,
): SearchInputDef {
	return { ...input, uuid } as SearchInputDef;
}

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
// JSON Schema for the provider tool-input compiler) can't accept `uuidSchema`
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

// ── Uuid-keyed array helpers ────────────────────────────────────────
//
// Pure generic primitives over `{ uuid: Uuid }[]` arrays — the same
// shape every case-list-config slot's op walks (columns, search-inputs,
// any other case-list-shaped array). Reused by the
// `addColumnsMutation` / `addSearchInputsMutation` family in
// `lib/agent/blueprintHelpers.ts` and available to non-SA consumers
// (UI mutations, test fixtures) that operate on the same `{ uuid }[]`
// shape.
//
// Each helper returns a tagged result the caller destructures: success
// → `{ ok: true, items }` carrying the post-mutation array; failure →
// `{ error }` with an Elm-style message naming the missing / unknown
// uuid plus a recovery hint. The agent layer forwards the error string
// verbatim to the SA; the UI layer surfaces its own affordance against
// the same predicate.

/**
 * Tagged result of a uuid-keyed array operation. `ok` carries the
 * post-mutation array as a fresh copy; `error` carries a single
 * human-readable error string the caller forwards.
 */
export type ArrayOpResult<T> = { ok: true; items: T[] } | { error: string };

/**
 * Replace the entry whose `uuid` matches `targetUuid` with `replacement`.
 * Returns a fresh array on success; returns an Elm-style error naming
 * the missing uuid + a recovery hint on failure. `entityLabel` is the
 * human-readable noun the caller wants in error text (e.g. `"case list
 * column"`, `"search input"`).
 */
export function replaceByUuid<T extends { uuid: Uuid }>(
	items: readonly T[],
	targetUuid: Uuid,
	replacement: T,
	entityLabel: string,
): ArrayOpResult<T> {
	const index = items.findIndex((item) => item.uuid === targetUuid);
	if (index < 0) {
		return {
			error: `Tried to update ${entityLabel} ${targetUuid}. Found no entry with that uuid in the module's case list. Look at getModule's projection or run searchBlueprint to surface the current uuids.`,
		};
	}
	const next = items.slice();
	next[index] = replacement;
	return { ok: true, items: next };
}

/**
 * Drop the entry whose `uuid` matches `targetUuid`. Returns a fresh
 * array on success; returns an Elm-style error naming the missing uuid
 * + a recovery hint on failure.
 */
export function removeByUuid<T extends { uuid: Uuid }>(
	items: readonly T[],
	targetUuid: Uuid,
	entityLabel: string,
): ArrayOpResult<T> {
	const index = items.findIndex((item) => item.uuid === targetUuid);
	if (index < 0) {
		return {
			error: `Tried to remove ${entityLabel} ${targetUuid}. Found no entry with that uuid in the module's case list. Look at getModule's projection or run searchBlueprint to surface the current uuids.`,
		};
	}
	const next = items.slice();
	next.splice(index, 1);
	return { ok: true, items: next };
}

/**
 * Reorder the array to match `requestedOrder`. The sequence must be a
 * permutation of the current uuids — every existing uuid present, no
 * duplicates, no unknowns. Three failure arms surface predictably so
 * the caller can repair its request:
 *
 *   - Length mismatch (different cardinality) — names expected vs
 *     actual count.
 *   - Duplicate uuid in the request — names the duplicate.
 *   - Unknown uuid (not in the source array) — names the unknown uuid.
 */
export function reorderByUuid<T extends { uuid: Uuid }>(
	items: readonly T[],
	requestedOrder: readonly Uuid[],
	entityLabel: string,
): ArrayOpResult<T> {
	if (requestedOrder.length !== items.length) {
		return {
			error: `Tried to reorder ${entityLabel}s. Found ${items.length} entries on the module but the request supplied ${requestedOrder.length} uuids. Try a uuid array that contains every existing uuid exactly once.`,
		};
	}
	const seen = new Set<Uuid>();
	for (const uuid of requestedOrder) {
		if (seen.has(uuid)) {
			return {
				error: `Tried to reorder ${entityLabel}s. Found duplicate uuid ${uuid} in the requested order. Try a uuid array with each existing uuid listed exactly once.`,
			};
		}
		seen.add(uuid);
	}
	const byUuid = new Map<Uuid, T>();
	for (const item of items) {
		byUuid.set(item.uuid, item);
	}
	const next: T[] = [];
	for (const uuid of requestedOrder) {
		const item = byUuid.get(uuid);
		if (item === undefined) {
			return {
				error: `Tried to reorder ${entityLabel}s. Found unknown uuid ${uuid} in the requested order — that uuid is not present on the module. Look at getModule's projection for the current uuids.`,
			};
		}
		next.push(item);
	}
	return { ok: true, items: next };
}
