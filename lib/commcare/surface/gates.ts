// lib/commcare/surface/gates.ts
//
// The manifest's gate entries (`entries/gates.json`), read by HQ symbol.
// Server code that needs a gate's identity (the project-space check asks HQ
// about feature flags by slug) reads it here, never from the generated
// surface, so a server bundle carries the gate entries alone.

import gateEntries from "./entries/gates.json";
import { gateEntriesFileSchema, type ToggleGateEntry } from "./schema";

const GATES = gateEntriesFileSchema.parse(gateEntries);

const TOGGLE_GATES: ReadonlyMap<string, ToggleGateEntry> = new Map(
	GATES.flatMap((gate) =>
		gate.kind === "toggle"
			? gate.symbols.map((symbol) => [symbol, gate] as const)
			: [],
	),
);

/** The toggle gate entry for an HQ toggle constant (`SESSION_ENDPOINTS`). */
export function toggleGate(symbol: string): ToggleGateEntry {
	const gate = TOGGLE_GATES.get(symbol);
	if (gate === undefined) {
		throw new Error(
			`Nova's gate entries (lib/commcare/surface/entries/gates.json) have no toggle entry for the HQ flag ${symbol}. ` +
				`Check the constant's spelling in corehq/toggles/__init__.py, or add its gate entry from the surface item toggle:${symbol}.`,
		);
	}
	return gate;
}

/**
 * A feature flag HQ keys by project space alone, which HQ's feature-flag
 * filter can answer for one project space. Never serialize this object:
 * slugs and symbols stay inside the CommCare boundary.
 */
export interface DomainFeatureFlag {
	/** The toggle's constant in `corehq/toggles/__init__.py`. */
	readonly symbol: string;
	/** The slug HQ's feature-flag filter matches. */
	readonly slug: string;
	readonly namespace: "domain";
}

/**
 * A toggle's identity for HQ's feature-flag filter
 * (`api/resources/v0_5.py::UserDomainsResource`), which lists a project
 * space when the flag is on for it or for the requesting user
 * (`toggles/__init__.py::toggles_dict`). Refuses a toggle the filter cannot
 * answer for a project space: a FrozenPrivilegeToggle, whose slug the filter
 * never lists (`all_toggles_by_name_in_scope` leaves it out, so HQ answers
 * "not a valid feature flag"), and a toggle keyed by anything but the
 * project space, where a flag on for the requesting user would read as on
 * for every project space.
 */
export function domainFeatureFlag(symbol: string): DomainFeatureFlag {
	const gate = toggleGate(symbol);
	if (gate.hqToggleClass === "FrozenPrivilegeToggle") {
		throw new Error(
			`HQ's ${symbol} is a FrozenPrivilegeToggle: HQ grants it through the plan privilege ${gate.privilege}, and its feature-flag filter never lists the slug ${gate.slug}, so a project space cannot be asked about it by flag. ` +
				"The project-space check has no way to ask HQ about a plan privilege, so leave this toggle out of it.",
		);
	}
	if (gate.namespaces.length !== 1 || gate.namespaces[0] !== "domain") {
		throw new Error(
			`HQ's ${symbol} is keyed by ${JSON.stringify(gate.namespaces)}, not by project space alone. ` +
				"HQ's feature-flag filter counts a flag on for the requesting user as on for every project space, so only a flag keyed by project space alone can be checked this way.",
		);
	}
	return { symbol, slug: gate.slug, namespace: "domain" };
}
