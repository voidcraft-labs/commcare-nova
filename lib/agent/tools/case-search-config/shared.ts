/**
 * Shared input schemas + snapshot helper for the case-search-config
 * SA tools. The config carries two clusters — display labels and the
 * advanced cluster (today: `excludedOwnerIds`); each has its own
 * wholesale-replace tool (`setCaseSearchDisplay` /
 * `setCaseSearchAdvanced`).
 *
 * Wholesale-with-`null`-clears: every cluster field is required-and-
 * nullable on the SA boundary; `null` clears, non-null sets. Mirrors
 * `setCaseListFilter`. Removes the absent-vs-null ambiguity and keeps
 * the per-tool optional count at zero (well under the tool-schema
 * 8-optional ceiling).
 *
 * Cross-cluster preservation runs through `pickAdvancedCluster` /
 * `pickDisplayCluster`: each tool harvests the OTHER cluster's slots
 * via `snapshotCaseSearchConfig` and layers the input over them.
 * Both pickers and the SA-boundary schemas key off the same slot
 * tuples (`DISPLAY_SLOT_NAMES` / `ADVANCED_SLOT_NAMES`); two compile-
 * time partition checks make a stray schema slot or overlapping
 * cluster placement fail the build rather than silently drop on patch.
 *
 * The advanced cluster's `excludedOwnerIds` slot translates at suite-
 * XML emission to CCHQ's wire token `commcare_blacklisted_owner_ids`
 * (lifted from `CASE_SEARCH_BLACKLISTED_OWNER_ID_KEY`). Authoring
 * vocabulary stays Nova-side; the wire token is CCHQ-controlled.
 *
 * `searchInputs` lives on `caseListConfig.searchInputs` (one source
 * across both screens), so case-search-config tools intentionally do
 * NOT carry a `searchInputs` slot — the SA edits search inputs
 * through the existing case-list-config tool family.
 */

import { z } from "zod";
import type { CaseSearchConfig, Module } from "@/lib/domain";
import { predicateSchema, valueExpressionSchema } from "@/lib/domain/predicate";

// ── Cluster slot tuples — source of truth ───────────────────────────

export const DISPLAY_SLOT_NAMES = [
	"searchScreenTitle",
	"searchScreenSubtitle",
	"searchButtonLabel",
	"searchButtonDisplayCondition",
] as const;

export const ADVANCED_SLOT_NAMES = ["excludedOwnerIds"] as const;

export type DisplaySlotName = (typeof DISPLAY_SLOT_NAMES)[number];
export type AdvancedSlotName = (typeof ADVANCED_SLOT_NAMES)[number];

// Partition exhaustiveness — every `CaseSearchConfig` key must land
// in exactly one tuple, so a new schema slot without a home fails to
// compile.
type _ClusterPartitionExhaustive = [keyof CaseSearchConfig] extends [
	DisplaySlotName | AdvancedSlotName,
]
	? [DisplaySlotName | AdvancedSlotName] extends [keyof CaseSearchConfig]
		? true
		: never
	: never;
const _exhaustive: _ClusterPartitionExhaustive = true;
void _exhaustive;

// Partition disjointness — a slot must live in exactly one cluster
// so neither picker strips it.
type _ClusterPartitionDisjoint =
	Extract<DisplaySlotName, AdvancedSlotName> extends never ? true : never;
const _disjoint: _ClusterPartitionDisjoint = true;
void _disjoint;

// ── Cross-cluster preservation pickers ──────────────────────────────
//
// Each tool replaces its own cluster and preserves the other byte-
// identically. The pickers harvest only non-undefined slots so cleared
// slots stay TRULY absent — downstream consumers check `key in config`,
// and an explicit `undefined` would flip that check to `true` and
// persist a slot the user cleared.

/**
 * Pick the advanced cluster off an existing config. Used by
 * `setCaseSearchDisplay` to preserve advanced slots while it
 * rebuilds the display cluster.
 */
export function pickAdvancedCluster(
	config: CaseSearchConfig | undefined,
): Partial<Pick<CaseSearchConfig, AdvancedSlotName>> {
	return pickClusterSlots(config, ADVANCED_SLOT_NAMES);
}

/**
 * Pick the display cluster off an existing config. Used by
 * `setCaseSearchAdvanced` to preserve display slots while it
 * rebuilds the advanced cluster.
 */
export function pickDisplayCluster(
	config: CaseSearchConfig | undefined,
): Partial<Pick<CaseSearchConfig, DisplaySlotName>> {
	return pickClusterSlots(config, DISPLAY_SLOT_NAMES);
}

/**
 * Copy the named non-undefined slots from `config`. Skipping
 * undefined values is what keeps cleared slots truly absent rather
 * than leaking through as `key: undefined`.
 */
function pickClusterSlots<K extends keyof CaseSearchConfig>(
	config: CaseSearchConfig | undefined,
	slots: readonly K[],
): Partial<Pick<CaseSearchConfig, K>> {
	const out: Partial<Pick<CaseSearchConfig, K>> = {};
	if (config === undefined) return out;
	for (const slot of slots) {
		const value = config[slot];
		if (value !== undefined) {
			out[slot] = value;
		}
	}
	return out;
}

// ── Patch-projection helper for SA-input layering ───────────────────

/**
 * The SA-boundary input shape — every slot required-and-nullable.
 * `NonNullable<CaseSearchConfig[P]>` strips the schema's `optional()`
 * `undefined` so an `undefined` input can't smuggle past the
 * `value !== null` filter and break `pickClusterSlots`'s "cleared
 * slots are truly absent" contract. The SA-boundary schemas use
 * `.nullable()`, so this tightened shape matches what callers pass.
 */
export type ClusterPatchInput<K extends keyof CaseSearchConfig> = {
	readonly [P in K]: NonNullable<CaseSearchConfig[P]> | null;
};

/**
 * Project an SA-input batch into a cluster-shaped patch. Iterates
 * `slots` so the slot list lives in one place; `null` inputs skip
 * the write so the returned keys reflect only what the SA set.
 */
export function applyClusterPatch<K extends keyof CaseSearchConfig>(
	input: ClusterPatchInput<K>,
	slots: readonly K[],
): Partial<Pick<CaseSearchConfig, K>> {
	const out: Partial<Pick<CaseSearchConfig, K>> = {};
	for (const slot of slots) {
		const value = input[slot];
		if (value !== null) {
			out[slot] = value;
		}
	}
	return out;
}

/**
 * Surface the slot names the SA actually set — every slot in
 * `slots` whose input is non-null. Iterating the same tuple keeps
 * this projection's emit set in lockstep with `applyClusterPatch`'s
 * by construction.
 */
export function slotsSetByInput<K extends keyof CaseSearchConfig>(
	input: ClusterPatchInput<K>,
	slots: readonly K[],
): readonly K[] {
	return slots.filter((slot) => input[slot] !== null);
}

// ── Input schemas — advanced cluster ────────────────────────────────

/**
 * SA boundary shape for `setCaseSearchAdvanced`. `moduleIndex` is
 * omitted from this body schema so `setCaseSearchAdvanced` can wrap
 * it back in its full tool input schema.
 */
export const setCaseSearchAdvancedBodySchema = z
	.object({
		excludedOwnerIds: valueExpressionSchema
			.nullable()
			.describe(
				"ValueExpression evaluating to a space-separated list of owner ids whose cases are excluded from the search-results scope, or `null` to clear. Rare in practice; pass `null` unless the author has a known set of owner ids to hide.",
			),
	})
	.strict();

// ── Input schemas — display cluster ─────────────────────────────────

/**
 * SA boundary shape for `setCaseSearchDisplay`. Four fields cover
 * the search-screen labels and the search-button display predicate.
 * Required-and-nullable on every slot means zero optional fields,
 * well under the tool-schema 8-optional ceiling.
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
		searchButtonLabel: z
			.string()
			.nullable()
			.describe(
				"Label on the primary search submit button, or `null` to clear. Defaults to a generic 'Search' label when absent.",
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
 * Pick the existing `caseSearchConfig` off a module. Returns
 * `undefined` when absent; the tools handle the rebuild over
 * `existing ?? {}`.
 */
export function snapshotCaseSearchConfig(
	mod: Module,
): CaseSearchConfig | undefined {
	return mod.caseSearchConfig;
}
