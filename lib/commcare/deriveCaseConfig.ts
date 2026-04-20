/**
 * Form-level case config derivation.
 *
 * A form doesn't carry its case wiring directly — it's derived from the
 * per-field `case_property` annotations. A field whose `case_property`
 * matches the module's case type becomes a primary case property; a
 * field pointing at a different case type contributes to a derived
 * child-case `OpenSubCaseAction`. Case name is always the field with
 * id `"case_name"` within each case-type group.
 *
 * The expander, compiler, formActions helper, and form validator all
 * need the same derivation, so it lives here as a single pure function
 * over the normalized doc. No wire shapes involved — the function walks
 * `doc.fieldOrder[formUuid]` and reads domain field keys (`kind`,
 * `case_property`, `id`) directly.
 */

import {
	type BlueprintDoc,
	CASE_LOADING_FORM_TYPES,
	type CasePropertyMapping,
	type CaseType,
	type FormType,
	type Uuid,
} from "@/lib/domain";
import { readFieldString } from "./fieldProps";

/** One derived child-case config (one-to-one with an HQ `OpenSubCaseAction`). */
export interface DerivedChildCase {
	case_type: string;
	case_name_field: string;
	case_properties: CasePropertyMapping[];
	relationship: "child" | "extension";
	repeat_context?: string;
}

/**
 * Form-level case wiring derived from the fields in a form. All four
 * members are optional — a survey form yields an empty object; a
 * registration form with no child cases yields `case_name_field` +
 * `case_properties` only.
 */
export interface DerivedCaseConfig {
	case_name_field?: string;
	case_properties?: CasePropertyMapping[];
	case_preload?: CasePropertyMapping[];
	child_cases?: DerivedChildCase[];
}

/**
 * Derive `DerivedCaseConfig` for a single form.
 *
 * Walks the form's field tree, splitting fields into primary (matching
 * `moduleCaseType`) and per-child-type buckets. Primary fields become
 * `case_properties` entries; the `"case_name"` field is promoted to
 * `case_name_field`. For case-loading form types (followup, close),
 * primary fields are also mirrored into `case_preload`. Each child
 * bucket produces one `DerivedChildCase`, looking up its relationship
 * from `caseTypes` (defaulting to `"child"` when absent).
 *
 * `repeat_context` on a child case is the uuid-id of the enclosing
 * repeat field, but only when every contributing field shares the
 * same ancestor repeat — otherwise the child case is ambiguous and
 * no context is emitted.
 */
export function deriveCaseConfig(
	doc: BlueprintDoc,
	formUuid: Uuid,
	moduleCaseType: string | undefined,
	formType: FormType,
): DerivedCaseConfig {
	if (formType === "survey") return {};

	const primaryProps: CasePropertyMapping[] = [];
	const primaryPreload: CasePropertyMapping[] = [];
	let case_name_field: string | undefined;

	// Child buckets: case_type → list of contributing fields (by id +
	// nearest repeat ancestor id).
	const childGroups = new Map<
		string,
		Array<{ id: string; repeatAncestor?: string }>
	>();

	const walk = (parentUuid: Uuid, repeatAncestor?: string): void => {
		for (const fieldUuid of doc.fieldOrder[parentUuid] ?? []) {
			const field = doc.fields[fieldUuid];
			if (!field) continue;

			const currentRepeat = field.kind === "repeat" ? field.id : repeatAncestor;
			const caseProperty = readFieldString(field, "case_property");

			if (caseProperty) {
				if (caseProperty === moduleCaseType) {
					// Primary case property
					if (field.id === "case_name") {
						case_name_field = field.id;
					} else {
						if (CASE_LOADING_FORM_TYPES.has(formType)) {
							primaryPreload.push({
								case_property: field.id,
								question_id: field.id,
							});
						}
						primaryProps.push({
							case_property: field.id,
							question_id: field.id,
						});
					}
				} else {
					// Child case property
					if (!childGroups.has(caseProperty)) childGroups.set(caseProperty, []);
					childGroups
						.get(caseProperty)
						?.push({ id: field.id, repeatAncestor: currentRepeat });
				}
			}

			// Recurse into container children. A container is marked by
			// having a `fieldOrder` entry keyed by its uuid (leaves don't).
			if (doc.fieldOrder[fieldUuid] !== undefined) {
				walk(fieldUuid, currentRepeat);
			}
		}
	};

	walk(formUuid);

	const result: DerivedCaseConfig = {};
	if (case_name_field) result.case_name_field = case_name_field;
	if (primaryProps.length > 0) result.case_properties = primaryProps;
	if (primaryPreload.length > 0) result.case_preload = primaryPreload;

	if (childGroups.size > 0 && doc.caseTypes) {
		result.child_cases = deriveChildCases(childGroups, doc.caseTypes);
	}

	return result;
}

/**
 * Assemble one `DerivedChildCase` per bucket in `childGroups`.
 *
 * Relationship comes from the matching entry in the doc's `caseTypes`
 * array (defaulting to `"child"` when the case type isn't declared).
 * `case_name_field` is the field with id `"case_name"` when present,
 * otherwise the first field in the bucket. Every other field becomes a
 * `case_properties` entry. `repeat_context` is emitted only when every
 * field in the bucket shares the same nearest repeat ancestor.
 */
function deriveChildCases(
	childGroups: Map<string, Array<{ id: string; repeatAncestor?: string }>>,
	caseTypes: CaseType[],
): DerivedChildCase[] {
	const derived: DerivedChildCase[] = [];

	for (const [childType, entries] of childGroups) {
		const ctDef = caseTypes.find((ct) => ct.name === childType);
		const relationship = ctDef?.relationship ?? "child";

		// Child case name defaults to the field with id `case_name` when
		// present. If absent, fall back to the first field in the bucket
		// (document order). The primary case has a matching
		// `NO_CASE_NAME_FIELD` validator rule that rejects a registration
		// form without `case_name`; child cases don't yet have an analogous
		// rule, so the fallback is what keeps the expander producing a
		// plausible `OpenSubCaseAction` when the SA emits child-case fields
		// without the canonical name id. See form-rules TODO: add
		// `CHILD_CASE_NO_NAME_FIELD` and drop this branch.
		const nameEntry = entries.find((e) => e.id === "case_name");
		const childCaseName = nameEntry?.id ?? entries[0].id;

		const childProps: CasePropertyMapping[] = entries
			.filter((e) => e.id !== childCaseName)
			.map((e) => ({ case_property: e.id, question_id: e.id }));

		const repeatAncestors = new Set(
			entries.map((e) => e.repeatAncestor).filter(Boolean),
		);
		const repeat_context =
			repeatAncestors.size === 1 ? [...repeatAncestors][0] : undefined;

		derived.push({
			case_type: childType,
			case_name_field: childCaseName,
			case_properties: childProps,
			relationship,
			...(repeat_context && { repeat_context }),
		});
	}

	return derived;
}
