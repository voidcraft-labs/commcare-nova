/**
 * The per-form reference projection: the question paths, the readable case
 * types and the worker information one form's references resolve against.
 *
 * Prose chips, the sidebar's reference labels (through
 * `components/builder/BuilderReferenceProvider.tsx`) and an expression
 * editor's `reference` all read this one walk. It reads exclusively from the
 * normalized `BlueprintDoc` and cannot validate or save an expression; the
 * slot's own editor context (`expressionEditorContext.ts`) does that.
 */

import type { BlueprintDoc } from "@/lib/domain";
import {
	asUuid,
	type Field,
	type FieldKind,
	type Form,
	type FormType,
	isContainer,
	type ProseTemplate,
	projectProseTemplate,
	type ReachableCaseTypeIndex,
	reachableCaseTypes,
	toReachableIndex,
	type UserProperty,
	type Uuid,
} from "@/lib/domain";
import { VALUE_PRODUCING_TYPES } from "@/lib/references/provider";

/** What one form's references resolve against. */
export interface FormReferenceContext {
	/** Uuid of the form this context describes. Identifies the context's
	 *  scope so caches keyed on it (e.g. `ReferenceProvider`'s form-entry
	 *  cache) rebuild when the active form changes — navigation swaps the
	 *  context without mutating the doc, so an identity key is the only
	 *  signal that the cached form is no longer the current one. */
	formUuid: string;
	/** Valid `/data/...` paths reachable in the current form. Used by
	 *  data-path autocomplete. */
	validPaths: Set<string>;
	/** The case types this form can READ — its own loaded case (depth 0) plus
	 *  its ancestor chain — each mapped to its `depth` and property metadata.
	 *  Keyed by case-type name so a `#<type>/<prop>` ref resolves to exactly one
	 *  type. `undefined` when the module has no case type (survey-only).
	 *  Child case types are intentionally absent: a child case is created
	 *  fresh and never loaded, so its properties are unreadable at runtime. */
	reachableCaseTypes: ReachableCaseTypeIndex | undefined;
	/** Value-producing fields in the current form, mapped to their XPath path
	 *  + human label. Used by #form/x autocomplete (label as `detail`).
	 *  `kind` is the domain `FieldKind` union so downstream consumers
	 *  (reference provider, chip rendering) can index `fieldRegistry`
	 *  without a widening cast. */
	formEntries: ReadonlyArray<{
		uuid: Uuid;
		path: string;
		label: string;
		kind: FieldKind;
	}>;
	/** Custom worker information available to identity-aware #user surfaces. */
	userProperties?: ReadonlyArray<Pick<UserProperty, "uuid" | "slug" | "label">>;
	/**
	 * The owning form's type. Drives surfaces that change behavior with
	 * form-creates-case semantics — most notably case-ref autocomplete on
	 * registration forms, where the own case type surfaces only `case_id`
	 * and ancestor types are dropped entirely. `caseRefAcceptMap` owns that
	 * rule so the editor's affordances agree with the checker's refusals.
	 */
	formType: FormType;
	/**
	 * Where the expression runs. `"form"` (the default) is a field's slot,
	 * evaluated inside the open form instance. `"session"` is an after-submit
	 * link's condition or carried value, which CommCare evaluates after the
	 * form has closed: form paths and `#form/` references have nothing to
	 * read, so autocomplete withholds both. An expression editor's context
	 * sets it from the slot's profile.
	 */
	scope?: "form" | "session";
}

/**
 * The case types a form can READ — its owning module's case type plus that
 * type's ancestor chain (walked through `parent_type`) — or `undefined`
 * when the module has no case type. The case-type record on `doc.caseTypes`
 * is the authoritative property list; it's populated by the SA and we never
 * synthesize entries from field write destinations (by design). Child types
 * are deliberately NOT included — a child case is created fresh and never
 * loaded, so reading its properties is unresolvable at runtime.
 *
 * One derivation for every slot of a form, so a form's field slots and its
 * after-submit slots can never disagree about which case types exist.
 */
export function formReachableCaseTypes(
	state: BlueprintDoc,
	formUuid: Uuid,
): ReachableCaseTypeIndex | undefined {
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
 * Walk the doc's field tree under `formUuid` and collect what the form's
 * references read. `undefined` if the form no longer exists (the caller
 * decides what to render in that case).
 */
export function buildFormReferenceContext(
	state: BlueprintDoc,
	formUuid: Uuid,
): FormReferenceContext | undefined {
	const form = state.forms[formUuid] as Form | undefined;
	if (!form) return undefined;

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
