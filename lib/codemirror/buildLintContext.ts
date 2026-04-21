/**
 * Helper to build an `XPathLintContext` from the normalized doc store.
 *
 * The lint/autocomplete plugin takes a pre-collected snapshot of:
 *   - valid `/data/...` paths in the current form,
 *   - case property names/labels reachable from this module, and
 *   - value-producing form fields (for `#form/x` completions).
 *
 * Both the field inspector's XPath editors and the form-settings
 * connect panel need the same walk, so it's extracted here. Reads
 * exclusively from the normalized `BlueprintDocState` (Uuid-indexed
 * maps + adjacency list).
 */

import type { BlueprintDocState } from "@/lib/doc/store";
import type { Field, FieldKind, Form, Uuid } from "@/lib/domain";
import { VALUE_PRODUCING_TYPES } from "@/lib/references/provider";
import type { XPathLintContext } from "./xpath-lint";

/**
 * Walk the doc's field tree under `formUuid` and collect the three slices
 * the CodeMirror plugin reads. `undefined` if the form no longer exists
 * (caller decides what to render in that case).
 */
export function buildLintContext(
	state: BlueprintDocState,
	formUuid: Uuid,
): XPathLintContext | undefined {
	const form = state.forms[formUuid] as Form | undefined;
	if (!form) return undefined;

	// Find the module that owns this form so we can resolve its caseType.
	let moduleUuid: Uuid | undefined;
	for (const [mUuid, formUuids] of Object.entries(state.formOrder)) {
		if (formUuids.includes(formUuid)) {
			moduleUuid = mUuid as Uuid;
			break;
		}
	}
	const mod = moduleUuid ? state.modules[moduleUuid] : undefined;
	const moduleCaseType = mod?.caseType;

	// Walk fields under the form root to collect valid paths + form entries.
	const validPaths = new Set<string>();
	const formEntries: Array<{
		path: string;
		label: string;
		kind: FieldKind;
	}> = [];
	function walk(parent: Uuid, prefix: string) {
		const order = state.fieldOrder[parent] ?? [];
		for (const childUuid of order) {
			const field = state.fields[childUuid] as Field | undefined;
			if (!field) continue;
			const path = `${prefix}/${field.id}`;
			validPaths.add(path);
			// Field variants differ in label presence — safe fallback to id so
			// the autocomplete always has something readable to display.
			const withLabel = field as Field & { label?: string };
			formEntries.push({
				path: path.slice("/data/".length),
				label: withLabel.label ?? field.id,
				kind: field.kind,
			});
			if (field.kind === "group" || field.kind === "repeat") {
				walk(childUuid, path);
			}
		}
	}
	walk(formUuid, "/data");

	// Case properties: own case type + any child case types that point to
	// this module's type. The case-type record on `doc.caseTypes` is the
	// authoritative list; it's populated by the SA and we never synthesize
	// entries from per-field `case_property` values (by design).
	const caseProperties = new Map<string, { label?: string }>();
	if (moduleCaseType && state.caseTypes) {
		const ct = state.caseTypes.find((c) => c.name === moduleCaseType);
		if (ct) {
			for (const prop of ct.properties) {
				caseProperties.set(prop.name, { label: prop.label });
			}
		}
		for (const child of state.caseTypes) {
			if (child.parent_type === moduleCaseType) {
				for (const prop of child.properties) {
					if (!caseProperties.has(prop.name))
						caseProperties.set(prop.name, { label: prop.label });
				}
			}
		}
	}

	return {
		validPaths,
		caseProperties: moduleCaseType ? caseProperties : undefined,
		formEntries: formEntries.filter((e) => VALUE_PRODUCING_TYPES.has(e.kind)),
	};
}
