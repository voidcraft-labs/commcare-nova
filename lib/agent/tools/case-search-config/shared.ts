/**
 * Shared input schemas + snapshot helper for the case-search-config SA
 * tools.
 *
 * The case-search config carries two clusters — display labels (search-
 * screen titles, button labels, search-button display predicate) and
 * the advanced cluster (niche search-side filters; today only the
 * `blacklistedOwnerIds` value expression). Each cluster has its own
 * wholesale-replace tool (`setCaseSearchDisplay` / `setCaseSearchAdvanced`);
 * this file owns the SA-boundary input shapes and the typed snapshot
 * accessor both tools read before constructing the next config.
 *
 * The `searchInputs` cross-binding lives on `caseListConfig.searchInputs`
 * (one source of truth across both screens), so the case-search-config
 * tools intentionally do NOT carry a `searchInputs` slot — the SA
 * authors search inputs through the existing case-list-config tool
 * family (`addSearchInput` / `updateSearchInput` / `removeSearchInput`
 * / `reorderSearchInputs`).
 *
 * Wholesale-with-`null`-clears semantic — every cluster field is
 * required-and-nullable on the SA boundary. The SA always supplies
 * every field of the cluster it's authoring; `null` explicitly clears
 * a slot, a non-null value sets it. Mirrors the case-list-config
 * `setCaseListFilter` pattern — required-and-nullable removes the
 * "absent vs null" ambiguity the SA would otherwise have to resolve
 * and gives zero optional fields per arm under the Anthropic 8-optional
 * compiler ceiling.
 *
 * Cross-cluster preservation runs through the cluster-pick helpers
 * (`pickAdvancedCluster` / `pickDisplayCluster`) below — each tool
 * reads the existing config via `snapshotCaseSearchConfig`, picks the
 * OTHER cluster's slots forward, and layers the input over them.
 * Both pickers and the SA-boundary input schemas derive their slot
 * sets from the same source-of-truth tuples (`DISPLAY_SLOT_NAMES` /
 * `ADVANCED_SLOT_NAMES`); two compile-time partition checks make a
 * stray schema slot or an overlapping cluster placement fail the
 * build rather than silently drop on patch.
 */

import { z } from "zod";
import type { CaseSearchConfig, Module } from "@/lib/domain";
import { predicateSchema, valueExpressionSchema } from "@/lib/domain/predicate";

// ── Cluster slot tuples — source of truth ───────────────────────────
//
// The case-search config splits cleanly into two clusters: display
// labels (search-screen titles, button labels, the search-button
// display predicate) and advanced filters (niche search-side filters,
// today only `blacklistedOwnerIds`). Each tuple is the canonical slot
// list for its cluster — both the input schemas above (display body
// keys + advanced body keys) and the cross-cluster preservation
// pickers below derive from these tuples.
//
// The `_ClusterPartitionExhaustive` and `_ClusterPartitionDisjoint`
// type-level assertions further down make the partition a compile-time
// invariant: a new schema slot that lands in NEITHER tuple stops the
// build until it gets a home, and a slot that accidentally lands in
// BOTH tuples is rejected the same way. Without these guards the
// pickers would silently drop a stray slot on every patch from the
// other cluster.
export const DISPLAY_SLOT_NAMES = [
	"searchScreenTitle",
	"searchScreenSubtitle",
	"emptyListText",
	"searchButtonLabel",
	"searchAgainButtonLabel",
	"searchButtonDisplayCondition",
] as const;

export const ADVANCED_SLOT_NAMES = ["blacklistedOwnerIds"] as const;

export type DisplaySlotName = (typeof DISPLAY_SLOT_NAMES)[number];
export type AdvancedSlotName = (typeof ADVANCED_SLOT_NAMES)[number];

// Compile-time exhaustiveness — the union of the two tuples must
// cover every key of `CaseSearchConfig`. If a new slot lands on the
// schema without a tuple home, this check fails to compile and the
// pickers below stop being trustworthy until the partition is
// updated.
type _ClusterPartitionExhaustive = [keyof CaseSearchConfig] extends [
	DisplaySlotName | AdvancedSlotName,
]
	? [DisplaySlotName | AdvancedSlotName] extends [keyof CaseSearchConfig]
		? true
		: never
	: never;
const _exhaustive: _ClusterPartitionExhaustive = true;
void _exhaustive;

// Compile-time disjointness — a slot must live in exactly one
// cluster. An overlapping name would mean both pickers strip the
// same slot and BOTH tools would lose it on patch.
type _ClusterPartitionDisjoint =
	Extract<DisplaySlotName, AdvancedSlotName> extends never ? true : never;
const _disjoint: _ClusterPartitionDisjoint = true;
void _disjoint;

// ── Cross-cluster preservation pickers ──────────────────────────────
//
// Each tool replaces its own cluster wholesale and preserves the
// other cluster byte-identically. The pickers below do the
// preservation half — `setCaseSearchDisplay` calls
// `pickAdvancedCluster(existing)` to harvest the slots it MUST keep,
// then layers the input's display values on top; `setCaseSearchAdvanced`
// is symmetric.
//
// Output shape: every preserved slot becomes a real key on the
// returned object; missing or cleared slots are TRULY absent (not
// `undefined`). Consumers downstream check slot presence via the
// `key in config` operator — emitting an explicit `undefined` would
// flip those checks to `true` and persist a slot the user cleared.

/**
 * Pick the advanced cluster off an existing config — every slot in
 * `ADVANCED_SLOT_NAMES`, with truly absent keys for missing or
 * cleared values. Used by `setCaseSearchDisplay` to preserve the
 * advanced cluster while it rebuilds the display cluster around the
 * SA's input.
 */
export function pickAdvancedCluster(
	config: CaseSearchConfig | undefined,
): CaseSearchConfig {
	return pickClusterSlots(config, ADVANCED_SLOT_NAMES);
}

/**
 * Pick the display cluster off an existing config — every slot in
 * `DISPLAY_SLOT_NAMES`, with truly absent keys for missing or cleared
 * values. Used by `setCaseSearchAdvanced` to preserve the display
 * cluster while it rebuilds the advanced cluster around the SA's
 * input.
 */
export function pickDisplayCluster(
	config: CaseSearchConfig | undefined,
): CaseSearchConfig {
	return pickClusterSlots(config, DISPLAY_SLOT_NAMES);
}

/**
 * Internal — copy the named slots from `config` into a fresh object,
 * skipping slots that are absent or carry an `undefined` value. The
 * skip is what keeps cleared slots truly absent on the returned
 * object instead of leaking through as `key: undefined`.
 */
function pickClusterSlots<K extends keyof CaseSearchConfig>(
	config: CaseSearchConfig | undefined,
	slots: readonly K[],
): CaseSearchConfig {
	const out: { [P in K]?: CaseSearchConfig[P] } = {};
	if (config === undefined) return out;
	for (const slot of slots) {
		const value = config[slot];
		if (value !== undefined) {
			out[slot] = value;
		}
	}
	return out;
}

// ── Input schemas — advanced cluster ────────────────────────────────

/**
 * SA boundary shape for `setCaseSearchAdvanced`. Required-and-nullable
 * mirrors `setCaseListFilter` — `null` clears the slot, a non-null
 * value sets it. Today the cluster carries one slot.
 *
 * `moduleIndex` omitted from the named export so callers can wrap it
 * (`setCaseSearchAdvanced` adds the slot back in its tool input
 * schema).
 */
export const setCaseSearchAdvancedBodySchema = z
	.object({
		blacklistedOwnerIds: valueExpressionSchema
			.nullable()
			.describe(
				"ValueExpression evaluating to a space-separated list of owner ids whose cases are excluded from the search-results scope, or `null` to clear. Rare in practice; pass `null` unless the author has a known set of owner ids to hide.",
			),
	})
	.strict();

// ── Input schemas — display cluster ─────────────────────────────────

/**
 * SA boundary shape for `setCaseSearchDisplay`. Six required-and-
 * nullable fields cover the search-screen labels and the search-button
 * display predicate. `null` clears any slot; a non-null value sets it.
 *
 * Six required-and-nullable fields = zero optional fields per arm,
 * well under the Anthropic 8-optional compiler ceiling.
 */
export const setCaseSearchDisplayBodySchema = z
	.object({
		searchScreenTitle: z
			.string()
			.nullable()
			.describe(
				"Plain-text title shown above the search inputs, or `null` to clear. The runtime falls back to a generic title when absent.",
			),
		searchScreenSubtitle: z
			.string()
			.nullable()
			.describe(
				"Subtitle rendered through a markdown formatter, or `null` to clear. Use this for short instructional copy under the title; markdown is supported.",
			),
		emptyListText: z
			.string()
			.nullable()
			.describe(
				"Text shown when the search returns no matches, or `null` to clear. Defaults to a generic empty-state message when absent.",
			),
		searchButtonLabel: z
			.string()
			.nullable()
			.describe(
				"Label on the primary search submit button, or `null` to clear. Defaults to a generic 'Search' label when absent.",
			),
		searchAgainButtonLabel: z
			.string()
			.nullable()
			.describe(
				"Label on the search-again button shown after a search runs, or `null` to clear. Defaults to a generic 'Search again' label when absent.",
			),
		searchButtonDisplayCondition: predicateSchema
			.nullable()
			.describe(
				"Predicate AST gating whether the search button is shown, or `null` to clear. Use this to hide the button once the form has executed once. When absent, the button is always shown.",
			),
	})
	.strict();

// ── Snapshot helper ─────────────────────────────────────────────────

/**
 * Pick the existing `caseSearchConfig` off the supplied module entity.
 * Returns `undefined` when the module has none — the tools handle the
 * empty-config rebuild themselves over the `existing ?? {}` pattern.
 *
 * Mirrors `snapshotCaseListConfig` shape.
 */
export function snapshotCaseSearchConfig(
	mod: Module,
): CaseSearchConfig | undefined {
	return mod.caseSearchConfig;
}
