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
	canonicalCasePropertyName,
	columnSchema,
	DEFAULT_SEARCH_MODE_KIND,
	type SearchInputDef,
	type SearchInputType,
	searchInputDefSchema,
	type Uuid,
} from "@/lib/domain";
import { expressionReadsCaseData } from "@/lib/domain/predicate";
import {
	canonicalizeExpressionCaseProperties,
	canonicalizePredicateCaseProperties,
} from "../shared/canonicalCaseProperties";

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
// Each arm comes from `columnSchema.options` / `searchInputDefSchema.options`.
// Column identity plus generic/Results/Details order keys are tool-owned and
// omitted: uuid is minted/carried by the tool, while ordering is authored only
// through `reorderCaseListColumns`, never as technical keys supplied by the
// SA. Destructuring per-arm preserves the TS-inferred per-arm shape so the
// discriminated union retypes cleanly — the
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
 * Per-arm `Column` schema with identity + all order-key slots omitted.
 * Surface the SA passes when adding or updating a column — the uuid is owned
 * by the tool (minted on add, looked up by `columnUuid` on update) and the
 * fractional order keys are computed by the reorder/diff layer.
 */
const columnToolOwnedSlots = {
	uuid: true,
	order: true,
	listOrder: true,
	detailOrder: true,
} as const;

export const columnInputSchema = z
	.discriminatedUnion("kind", [
		plainColumnArm.omit(columnToolOwnedSlots),
		dateColumnArm.omit(columnToolOwnedSlots),
		phoneColumnArm.omit(columnToolOwnedSlots),
		idMappingColumnArm.omit(columnToolOwnedSlots),
		imageMapColumnArm.omit(columnToolOwnedSlots),
		intervalColumnArm.omit(columnToolOwnedSlots),
		calculatedColumnArm.omit(columnToolOwnedSlots),
	])
	.superRefine((column, ctx) => {
		// A definition absent from both worker-facing screens has no job unless
		// Default order still consumes it as a sort carrier. Keep the domain and
		// wire tolerant of old docs, but do not let SA/MCP author the exact hidden
		// clutter Nova's visual workspace deliberately removes.
		if (
			column.visibleInList === false &&
			column.visibleInDetail === false &&
			column.sort === undefined
		) {
			ctx.addIssue({
				code: "custom",
				message:
					"A field must appear on Results or Details. Remove the definition instead of creating an off-screen field; a field may stay off-screen only while Default order uses it.",
				path: ["visibleInList"],
			});
		}
	});
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
export const searchInputDefInputSchema = z
	.discriminatedUnion("kind", [
		simpleSearchInputArm
			.omit({ uuid: true, order: true })
			.extend({ type: saSearchInputType }),
		advancedSearchInputArm
			.omit({ uuid: true, order: true })
			.extend({ type: saSearchInputType }),
	])
	.superRefine((input, ctx) => {
		if (input.kind === "simple") {
			const modeKind = input.mode?.kind ?? DEFAULT_SEARCH_MODE_KIND[input.type];
			const coherentRangeWidget =
				(modeKind === "range") === (input.type === "date-range");
			if (!coherentRangeWidget) {
				ctx.addIssue({
					code: "custom",
					path: input.mode === undefined ? ["type"] : ["mode"],
					message:
						modeKind === "range"
							? 'Use `type: "date-range"` with range mode. A one-date field cannot collect both bounds.'
							: "A `date-range` field must use range mode. Choose a single-date field for a one-value match.",
				});
			}
		}
		if (input.default !== undefined && expressionReadsCaseData(input.default)) {
			ctx.addIssue({
				code: "custom",
				path: ["default"],
				message:
					"A search input's starting value is evaluated before any case is selected, so it cannot read case properties or relationships. Use a fixed value, `today()`, or a current-user/session value — or leave `default` out to start the input empty.",
			});
		}
		if (input.type !== "date-range" || input.default === undefined) return;
		ctx.addIssue({
			code: "custom",
			path: ["default"],
			message:
				"Leave `default` out for a date-range input. A date range requires both a start and an end, while this slot can express only one value.",
		});
	});
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
	const canonical =
		column.kind === "calculated"
			? {
					...column,
					expression: canonicalizeExpressionCaseProperties(column.expression),
				}
			: { ...column, field: canonicalCasePropertyName(column.field) };
	return { ...canonical, uuid } as Column;
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
	const canonicalDefault =
		input.default === undefined
			? {}
			: {
					default: canonicalizeExpressionCaseProperties(input.default),
				};
	const canonical =
		input.kind === "simple"
			? {
					...input,
					...canonicalDefault,
					property: canonicalCasePropertyName(input.property),
				}
			: {
					...input,
					...canonicalDefault,
					predicate: canonicalizePredicateCaseProperties(input.predicate),
				};
	return { ...canonical, uuid } as SearchInputDef;
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
// Tool-addressing UUIDs deliberately stay plain strings at this wire boundary.
// Tool bodies brand the parsed value with `asUuid(...)` before handing it to
// the blueprintHelpers atomic builders. Keeping the provider input type
// unbranded also makes that boundary's string-in / branded-domain transition
// explicit even though the shared domain `uuidSchema` is itself now
// transform-free and JSON-Schema-safe.
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
