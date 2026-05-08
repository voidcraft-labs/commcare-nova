// components/builder/case-search-config/nextConfig.ts
//
// Shared seed helper used by every section in the case-search-config
// workspace. The case-search-config sections (`ClaimSection`,
// `DisplaySection`, etc.) are each handed the FULL `CaseSearchConfig`
// — a possibly-undefined slot on the module — and route their
// per-slot edits through this helper so the emitted shape always
// satisfies the schema's `dontClaimAlreadyOwned: boolean` invariant.
//
// The slot is OPTIONAL on the module schema; a module without search
// authored omits it entirely. The first edit through any section
// seeds `{ dontClaimAlreadyOwned: false }` plus the per-slot patch.
// Subsequent edits compose against the existing config — `...base`
// before `...patch` lets any sibling slot the patch doesn't touch
// flow through unchanged.

import type { CaseSearchConfig } from "@/lib/domain";

/**
 * Builds the next `CaseSearchConfig` from a possibly-undefined
 * current value plus a slot patch. Pins the schema-required
 * `dontClaimAlreadyOwned` default on first edit so the parent never
 * sees a partial config that fails strict parse, and passes through
 * the existing slot when the section already has a config.
 *
 * Patch semantics: setting a slot to `undefined` clears the slot at
 * the parent's strict-parse — the parent's persistence layer drops
 * the present-with-undefined key when it serializes, and the next
 * mount reads back a config with that slot absent. Routing every
 * write (set + clear) through this single helper keeps the emit
 * shape stable across every section in the workspace.
 */
export function nextConfig(
	current: CaseSearchConfig | undefined,
	patch: Partial<CaseSearchConfig>,
): CaseSearchConfig {
	const base: CaseSearchConfig = current ?? { dontClaimAlreadyOwned: false };
	return { ...base, ...patch };
}
