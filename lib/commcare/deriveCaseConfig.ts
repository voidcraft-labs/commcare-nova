/**
 * Form-level case config derivation.
 *
 * A form doesn't carry its case wiring directly — it's derived from the
 * per-field `case_property_on` annotations. A field whose `case_property_on`
 * matches the module's case type becomes a primary case property; a
 * field pointing at a different case type contributes to a derived
 * child-case `OpenSubCaseAction`. Case name is always the field with
 * id `"case_name"` within each case-type group.
 *
 * The expander, compiler, formActions helper, and form validator all
 * need the same derivation, so it lives here as a single pure function
 * over the normalized doc. No wire shapes involved — the function walks
 * `doc.fieldOrder[formUuid]` and reads domain field keys (`kind`,
 * `case_property_on`, `id`) directly.
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
	/**
	 * The field id whose value names the child case (`case_name`). `undefined`
	 * when the bucket has no such field — an authoring error the validator rule
	 * `childCaseNoNameField` rejects, so by the time a valid doc reaches the
	 * expander this is always set. Optional (not an empty-string sentinel) so the
	 * absence is unambiguous at the type level and matches `DerivedCaseConfig
	 * .case_name_field`'s shape.
	 */
	case_name_field?: string;
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

	// Child buckets: keyed by `(case_type, repeat_ancestor)` so two repeats
	// each authoring fields for the same child case type produce TWO distinct
	// subcase actions rather than collapsing into one ambiguous bucket. This
	// mirrors CCHQ's wire model — `Form.actions.subcases: SchemaListProperty(
	// OpenSubCaseAction)` — where each subcase action is independently scoped
	// to its own `repeat_context`. The empty-string sentinel for "no repeat
	// ancestor" pairs the root-level case-type fields into one bucket per
	// type, preserving today's non-repeat-subcase semantic.
	const childGroups = new Map<
		string,
		{
			caseType: string;
			repeatAncestor: string | undefined;
			fields: Array<{ id: string }>;
		}
	>();
	const bucketKey = (caseType: string, repeatAncestor: string | undefined) =>
		`${caseType}::${repeatAncestor ?? "__root__"}`;

	const walk = (parentUuid: Uuid, repeatAncestor?: string): void => {
		for (const fieldUuid of doc.fieldOrder[parentUuid] ?? []) {
			const field = doc.fields[fieldUuid];
			if (!field) continue;

			const currentRepeat = field.kind === "repeat" ? field.id : repeatAncestor;
			const casePropertyOn = readFieldString(field, "case_property_on");

			if (casePropertyOn) {
				if (casePropertyOn === moduleCaseType) {
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
					// Child case property — bucket by (case_type, repeat_ancestor).
					const key = bucketKey(casePropertyOn, currentRepeat);
					let bucket = childGroups.get(key);
					if (!bucket) {
						bucket = {
							caseType: casePropertyOn,
							repeatAncestor: currentRepeat,
							fields: [],
						};
						childGroups.set(key, bucket);
					}
					bucket.fields.push({ id: field.id });
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
 * `case_name_field` is the field with id `"case_name"` in the bucket; when
 * absent it stays empty, which the validator rule `childCaseNoNameField`
 * surfaces against the user (it points at the offending bucket directly).
 * Every other field becomes a `case_properties` entry.
 */
function deriveChildCases(
	childGroups: Map<
		string,
		{
			caseType: string;
			repeatAncestor: string | undefined;
			fields: Array<{ id: string }>;
		}
	>,
	caseTypes: CaseType[],
): DerivedChildCase[] {
	const derived: DerivedChildCase[] = [];

	for (const bucket of childGroups.values()) {
		const ctDef = caseTypes.find((ct) => ct.name === bucket.caseType);
		const relationship = ctDef?.relationship ?? "child";

		// Child case name is the field id'd `case_name` in this bucket. When
		// absent it stays `undefined` — the validator rule `childCaseNoNameField`
		// reports against this bucket directly. The old silent fallback (use the
		// first field in the bucket as the name source) is gone; a missing
		// `case_name` is now a real authoring error the user sees rather than a
		// silent re-purpose of an unrelated field.
		const childCaseName = bucket.fields.find((e) => e.id === "case_name")?.id;

		const childProps: CasePropertyMapping[] = bucket.fields
			.filter((e) => e.id !== childCaseName)
			.map((e) => ({ case_property: e.id, question_id: e.id }));

		derived.push({
			case_type: bucket.caseType,
			...(childCaseName && { case_name_field: childCaseName }),
			case_properties: childProps,
			relationship,
			...(bucket.repeatAncestor && { repeat_context: bucket.repeatAncestor }),
		});
	}

	return derived;
}
