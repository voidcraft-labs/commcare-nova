/**
 * Shared helpers for the case-list-config SA tools.
 *
 * All five tools (`setCaseListColumns`, `setCaseListFilter`,
 * `setCaseListSort`, `setCalculatedColumns`, `setCaseListSearchInputs`)
 * share three concerns:
 *
 *   1. Resolve a positional `moduleIndex` to the module's uuid +
 *      entity. Index out of range / module missing collapses to one
 *      error envelope so each tool body stays focused on its slot.
 *   2. Build the `caseListConfig` patch — every tool replaces ONE
 *      slot of the config (columns / sort / filter / calculated /
 *      search inputs) and preserves the remaining slots verbatim.
 *      The base-config fallback (`{ columns: [], sort: [], ... }`)
 *      handles the first-time-setting case where the module has no
 *      config yet.
 *   3. Drive the mutation through `updateModuleMutations` and the
 *      shared `applyToDoc` + `ctx.recordMutations` flow that every
 *      mutating SA tool routes through. The `applyBlueprintChange`
 *      cross-store saga sits behind `recordMutations` on the MCP
 *      surface; the chat surface remains fire-and-forget per the
 *      `lib/agent/CLAUDE.md` contract.
 *
 * Centralizing this lets each tool body stay at the level of "what
 * slot of `caseListConfig` am I replacing" without re-implementing
 * the resolve / patch / persist scaffolding.
 */

import type { CaseListConfig, Module } from "@/lib/domain";

/**
 * Fallback `caseListConfig` snapshot used when a module has no
 * config yet. Every slot is initialized to its empty equivalent —
 * `filter` and `detailColumns` stay absent because the schema treats
 * "no filter" / "long detail mirrors short detail" as the absent-
 * key shape, and writing a literal `undefined` would round-trip as
 * an explicit "clear" signal at the reducer's `Object.assign`.
 *
 * Exposed as a builder rather than a frozen constant so each tool
 * call gets its own array literals — if a tool body mutated the
 * arrays in place (it shouldn't, but defense in depth), the next
 * call wouldn't observe leaked state.
 */
export function emptyCaseListConfig(): CaseListConfig {
	return {
		columns: [],
		sort: [],
		calculatedColumns: [],
		searchInputs: [],
	};
}

/**
 * Pick the existing `caseListConfig` snapshot off the supplied
 * module entity, falling back to an empty config when the module
 * has none. Read by every case-list-config tool before applying
 * its slot-specific replacement so the surrounding slots survive
 * the patch.
 *
 * The base-config fallback distinguishes two cases the SA can't
 * tell apart from the input shape alone:
 *
 *   - The module has no `caseListConfig` (legacy app, not yet
 *     migrated; or a fresh case-carrying module before any case-
 *     list authoring). Apply tools to it and the fallback fills
 *     the unset slots with empty arrays.
 *   - The module has a config and the SA is replacing one slot.
 *     The existing snapshot supplies the unmentioned slots.
 *
 * Either way, the returned object is structurally consistent with
 * `caseListConfigSchema` — every required array slot is present,
 * and `filter` / `detailColumns` are absent unless the existing
 * config carries them.
 */
export function baseCaseListConfig(mod: Module): CaseListConfig {
	return mod.caseListConfig ?? emptyCaseListConfig();
}
