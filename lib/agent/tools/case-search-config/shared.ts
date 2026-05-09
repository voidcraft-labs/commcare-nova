/**
 * Shared input schemas + snapshot helper for the case-search-config SA
 * tools.
 *
 * The case-search config carries two clusters — claim flow (claim
 * condition / blacklisted owner ids) and display labels (search-
 * screen titles, button labels, search-button display predicate).
 * Each cluster has its own wholesale-replace tool
 * (`setCaseSearchClaim` / `setCaseSearchDisplay`); this file owns the
 * SA-boundary input shapes and the typed snapshot accessor both tools
 * read before constructing the next config.
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
 * Cross-cluster preservation lives in each tool's `execute` body — the
 * tool reads the existing config via `snapshotCaseSearchConfig`, strips
 * its own cluster keys, and rebuilds with the input.
 */

import { z } from "zod";
import type { CaseSearchConfig, Module } from "@/lib/domain";
import { predicateSchema, valueExpressionSchema } from "@/lib/domain/predicate";

// ── Input schemas — claim cluster ───────────────────────────────────

/**
 * SA boundary shape for `setCaseSearchClaim`. Required-and-nullable
 * mirrors `setCaseListFilter` — `null` clears the slot, a non-null
 * value sets it.
 *
 * `moduleIndex` omitted from the named export so callers can wrap it
 * (`setCaseSearchClaim` adds the slot back in its tool input schema).
 */
export const setCaseSearchClaimBodySchema = z
	.object({
		claimCondition: predicateSchema
			.nullable()
			.describe(
				"Predicate AST gating the claim, or `null` to clear. When set, the runtime claims a case from search results only when this predicate evaluates true against the selected case. Pass `null` to remove an existing condition (the runtime claims unconditionally on selection).",
			),
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
