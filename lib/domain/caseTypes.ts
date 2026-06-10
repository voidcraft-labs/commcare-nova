// lib/domain/caseTypes.ts
//
// Shared utilities for reasoning about CaseType records. Lives in
// lib/domain/ because the rules are part of the domain contract
// (which case types a module can write to), not UI policy.

import type { CaseProperty, CaseType } from "./blueprint";
import type { CasePropertyDataType } from "./casePropertyTypes";
import type { FieldKind } from "./fields";
import type { FormType } from "./forms";

/**
 * The case-property `data_type` a field of the given kind writes.
 *
 * **The kind→data_type mapping table is locked here** — the single
 * source every surface that relates a field kind to a property data
 * type consults: the validator's writer/declaration agreement rule
 * (`lib/commcare/validator/rules/fieldKindMatchesPropertyType.ts`)
 * and the reducer-side catalog sync
 * (`lib/doc/mutations/fields.ts::ensureCatalogProperty`). Adding a new
 * field kind whose semantic data type isn't already covered cascades
 * to this table; no other surface may hold a parallel mapping.
 *
 * Returns `undefined` for kinds that don't pin a value type:
 * `hidden` — the calculate expression's output type drives the
 * property's actual data type, which is a separate type-checker
 * concern — and the structural / media / display kinds, whose schemas
 * carry no `case_property_on` slot at all. `barcode` and `secret`
 * map to `text` because they're text-shaped at the wire layer despite
 * carrying a separate authoring kind; coercion paths (e.g. `text`
 * field → `int` property) are deliberately not expressed.
 */
export function caseDataTypeForFieldKind(
	kind: FieldKind,
): CasePropertyDataType | undefined {
	switch (kind) {
		case "text":
		case "barcode":
		case "secret":
			// Text-shaped wire type — barcodes scan as plain strings;
			// secrets serialize as `xsd:string` like text. Both write to
			// a `text` case property without coercion.
			return "text";
		case "int":
			return "int";
		case "decimal":
			return "decimal";
		case "date":
			return "date";
		case "datetime":
			return "datetime";
		case "time":
			return "time";
		case "single_select":
			return "single_select";
		case "multi_select":
			return "multi_select";
		case "geopoint":
			return "geopoint";
		case "hidden":
		case "label":
		case "group":
		case "repeat":
		case "image":
		case "audio":
		case "video":
		case "signature":
			// `hidden` skipped: see the function doc. The remaining kinds
			// carry no `case_property_on` slot in their schema and are
			// structurally unreachable; listing them keeps the switch
			// exhaustive against `FieldKind` — adding a new kind without
			// a parallel arm here breaks the build.
			return undefined;
		default: {
			// Exhaustiveness assertion — adding a new `FieldKind` without
			// a parallel arm here is a compile-time error. The runtime
			// branch defends untyped boundaries that bypass the type
			// system (e.g. a corrupted persisted document with an unknown
			// kind string): an unknown kind pins no data type, so it must
			// report `undefined` — returning the raw kind would launder it
			// into the catalog as a `data_type` outside the union.
			const _exhaustive: never = kind;
			void _exhaustive;
			return undefined;
		}
	}
}

/**
 * Returns the case type names a module can write to: its own primary
 * case type plus any child types that declare the module's type as
 * their `parent_type`. Used by both the inspect panel's case-property
 * dropdown and any other UI that needs to reason about writable
 * destinations for a field.
 *
 * A module with no configured `caseType` has nothing to write to —
 * the result is always an empty array in that case.
 */
export function getModuleCaseTypes(
	caseType: string | undefined,
	caseTypes: CaseType[],
): string[] {
	if (!caseType) return [];
	const result = [caseType];
	for (const ct of caseTypes) {
		if (ct.parent_type === caseType) result.push(ct.name);
	}
	return result;
}

/** A case type reachable for READING from a form, with the parent-index hop
 *  count that addresses it on the wire (`depth` 0 = the form's own loaded case,
 *  1 = its parent, 2 = grandparent, …). */
export interface ReachableCaseType {
	name: string;
	depth: number;
	properties: CaseProperty[];
}

/**
 * The case types a form can READ via a hashtag reference: its own case type
 * (`depth` 0, the single case loaded at form entry) plus its ancestor chain
 * walked through `parent_type` (`depth` 1, 2, …). This is the dual of
 * `getModuleCaseTypes` — that one is write destinations (own + children); this
 * one is readable sources (own + ancestors). They differ because a form loads
 * exactly one case and can only reach UP the case index to ancestors at
 * runtime; a child case is created fresh and never loaded, so it is a write
 * target but not a readable source.
 *
 * `depth` is the load-bearing output: the wire emitter turns `#<type>/<prop>`
 * into the same `…/index/parent × depth …/<prop>` walk that `#case/parent…/`
 * already produces. Ordered own-first; cycle-guarded against malformed
 * `parent_type` chains. An undeclared own type still appears at depth 0 (with
 * no properties) so its namespace is recognized even before properties exist.
 */
export function reachableCaseTypes(
	caseType: string | undefined,
	caseTypes: CaseType[],
): ReachableCaseType[] {
	if (!caseType) return [];
	const byName = new Map(caseTypes.map((ct) => [ct.name, ct]));
	const result: ReachableCaseType[] = [];
	const seen = new Set<string>();
	let current: string | undefined = caseType;
	let depth = 0;
	while (current && !seen.has(current)) {
		seen.add(current);
		const ct = byName.get(current);
		result.push({ name: current, depth, properties: ct?.properties ?? [] });
		current = ct?.parent_type;
		depth++;
	}
	return result;
}

/**
 * A form's readable case-type index: case-type name → its parent-index `depth`
 * (0 = the form's own loaded case) and the addressable property metadata for
 * that type. Built once from `reachableCaseTypes` by the lint-context builder
 * and the deep validator; consumed by the validator accept-set helper, the
 * reference provider, and the XPath autocomplete. Carrying the label here lets
 * the autocomplete show a human-readable `detail` without a second lookup.
 */
export type ReachableCaseTypeIndex = Map<
	string,
	{ depth: number; properties: Map<string, { label?: string }> }
>;

/** Turn the ordered `reachableCaseTypes` list into the name-keyed index the
 *  lint context and validator both read. Seeds `case_id` as an implicit
 *  property of every type: it's a system property of every case (the loaded
 *  case's id), addressable as `#<type>/case_id`, so resolve / validate /
 *  autocomplete all see it uniformly even though the case-type record never
 *  declares it. A declared `case_id` (rare) keeps its own label. */
export function toReachableIndex(
	reachable: ReachableCaseType[],
): ReachableCaseTypeIndex {
	const index: ReachableCaseTypeIndex = new Map();
	for (const t of reachable) {
		const properties = new Map(
			t.properties.map((p) => [p.name, { label: p.label }]),
		);
		if (!properties.has("case_id"))
			properties.set("case_id", { label: "case id" });
		index.set(t.name, { depth: t.depth, properties });
	}
	return index;
}

/**
 * The accept structure for a form's readable case references: each addressable
 * case-type name → the set of property names allowed on it. This is the single
 * home of the form-type-narrowing rule, so the validator, the inline linter,
 * and the autocomplete can never disagree on which `#<type>/<prop>` refs are
 * live (the "offer it, then reject it" bug that splitting the rule would cause).
 *
 * The accept set narrows by the form's case behavior:
 *   - `registration` creates its own case, so that case doesn't exist at
 *     form-init — only the form-allocated `case_id` resolves, and ancestor
 *     reads aren't permitted on a create form (the same policy the
 *     `CASE_HASHTAG_ON_CREATE_FORM` rule enforces). Just the own type's
 *     `case_id`.
 *   - `survey` loads no case at all (its suite entry declares no `case_id`
 *     datum), so every `#<type>/<prop>` would resolve against an empty
 *     `session/data/case_id` — always-empty, silently. A survey accepts NO
 *     case refs, even when it sits in a module that has a case type.
 *   - `followup` / `close` load the case, so each reachable type exposes its
 *     full property set.
 *
 * An empty index (a form whose module has no case type) yields an empty map
 * regardless of form type.
 */
export function caseRefAcceptMap(
	index: ReachableCaseTypeIndex,
	formType: FormType,
): Map<string, Set<string>> {
	const accept = new Map<string, Set<string>>();
	if (index.size === 0 || formType === "survey") return accept;
	if (formType === "registration") {
		for (const [name, { depth }] of index) {
			if (depth === 0) {
				accept.set(name, new Set(["case_id"]));
				break;
			}
		}
		return accept;
	}
	for (const [name, { properties }] of index) {
		accept.set(name, new Set(properties.keys()));
	}
	return accept;
}
