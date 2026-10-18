/**
 * Helper to build an `XPathLintContext` from the normalized doc store.
 *
 * The lint/autocomplete plugin takes a pre-collected snapshot of:
 *   - valid `/data/...` paths in the current form,
 *   - the case types readable from this form (own + ancestors) with their
 *     property metadata, and
 *   - value-producing form fields (for `#form/x` completions).
 *
 * Both the field inspector's XPath editors and the form-settings
 * connect panel need the same walk, so it's extracted here. Reads
 * exclusively from the normalized `BlueprintDocState` (Uuid-indexed
 * maps + adjacency list).
 *
 * The actual expression slot determines form or after-submit scope;
 * after-submit slots expose case data without form-answer completions.
 */

import { lookupTypeIndex } from "@/lib/doc/commitVerdicts";
import { parseFormExpressionForSlot } from "@/lib/doc/expressionText";
import { lookupExpressionDefinitions } from "@/lib/doc/lookupExpressionContext";
import type { LookupValidationContext } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc } from "@/lib/domain";
import {
	asUuid,
	type Field,
	type FieldKind,
	type Form,
	isContainer,
	type ProseTemplate,
	projectProseTemplate,
	type ReachableCaseTypeIndex,
	reachableCaseTypes,
	toReachableIndex,
	type Uuid,
} from "@/lib/domain";
import { slotContext } from "@/lib/domain/expression/context";
import type { FormStructure } from "@/lib/domain/expression/formStructure";
import type { ExpressionSlotRef } from "@/lib/domain/expression/types";
import { VALUE_PRODUCING_TYPES } from "@/lib/references/provider";
import type { XPathLintContext, XPathReferenceContext } from "./xpath-lint";

/**
 * The case types a form can READ — its owning module's case type plus that
 * type's ancestor chain (walked through `parent_type`) — or `undefined`
 * when the module has no case type. The case-type record on `doc.caseTypes`
 * is the authoritative property list; it's populated by the SA and we never
 * synthesize entries from field write destinations (by design). Child types
 * are deliberately NOT included — a child case is created fresh and never
 * loaded, so reading its properties is unresolvable at runtime.
 *
 * One derivation for both lint contexts, so a form's field slots and its
 * after-submit slots can never disagree about which case types exist.
 */
export function formReachableCaseTypes(
	state: BlueprintDoc,
	formUuid: Uuid,
): ReachableCaseTypeIndex | undefined {
	// Find the module that owns this form so we can resolve its caseType.
	let moduleUuid: Uuid | undefined;
	for (const [mUuid, formUuids] of Object.entries(state.formOrder)) {
		if (formUuids.includes(formUuid)) {
			moduleUuid = asUuid(mUuid);
			break;
		}
	}
	const mod = moduleUuid ? state.modules[moduleUuid] : undefined;
	const moduleCaseType = mod?.caseType;
	return moduleCaseType
		? toReachableIndex(
				reachableCaseTypes(moduleCaseType, state.caseTypes ?? []),
				state,
			)
		: undefined;
}

/**
 * Walk the doc's field tree under `formUuid` and collect the three slices
 * the CodeMirror plugin reads. `undefined` if the form no longer exists
 * (caller decides what to render in that case).
 */
export function buildLintContext(
	state: BlueprintDoc,
	formUuid: Uuid,
): XPathReferenceContext | undefined {
	const form = state.forms[formUuid] as Form | undefined;
	if (!form) return undefined;

	// Walk fields under the form root to collect valid paths + form entries.
	const validPaths = new Set<string>();
	const formEntries: Array<{
		uuid: Uuid;
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
			const withLabel = field as Field & { label?: ProseTemplate };
			formEntries.push({
				uuid: field.uuid,
				path: path.slice("/data/".length),
				label: withLabel.label
					? projectProseTemplate(withLabel.label, state).text
					: field.id,
				kind: field.kind,
			});
			if (isContainer(field)) {
				walk(childUuid, path);
			}
		}
	}
	walk(formUuid, "/data");

	return {
		formUuid,
		validPaths,
		reachableCaseTypes: formReachableCaseTypes(state, formUuid),
		formEntries: formEntries.filter((e) => VALUE_PRODUCING_TYPES.has(e.kind)),
		userProperties: Object.values(state.userProperties ?? {}),
		formType: form.type,
	};
}

/** Derive editing semantics from the actual owner and slot, never a form default. */
export function buildExpressionLintContext(
	doc: BlueprintDoc,
	slot: ExpressionSlotRef,
	lookupContext: LookupValidationContext,
	options: { readonly form?: FormStructure } = {},
): XPathLintContext | undefined {
	const context = slotContext(
		doc,
		slot,
		lookupTypeIndex(lookupContext),
		options,
	);
	const form = context?.form;
	if (context === undefined || form === undefined) return undefined;
	const references = buildLintContext(doc, form.formUuid);
	if (references === undefined) return undefined;
	const lookup = lookupExpressionDefinitions(lookupContext);
	return {
		...references,
		...(context.profile.formAnswers
			? {}
			: { validPaths: new Set<string>(), formEntries: [] }),
		...(context.profile.caseData ? {} : { reachableCaseTypes: undefined }),
		scope: context.profile.scope === "session" ? "session" : "form",
		expressionContext: context,
		parse: (source) =>
			parseFormExpressionForSlot(doc, slot, source, lookup, options),
	};
}
