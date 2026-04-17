// Form-level case config derivation.
//
// A pure function over a duck-typed question tree. Consumers (the
// CommCare form validator, the HQ JSON expander, the CCZ compiler,
// formActions) feed the current wire-format `Question[]` tree straight
// in — the helper only reads `id`, `type`, `case_property_on`, and
// `children`, so any shape that satisfies `CaseConfigQuestion` works.
//
// Moved verbatim out of `lib/schemas/blueprint.ts` — nothing about it
// is schema-specific and keeping it there was forcing non-boundary
// code to import from the wire-format module.

import {
	CASE_LOADING_FORM_TYPES,
	type CasePropertyMapping,
	type CaseType,
	type FormType,
} from "@/lib/domain";

/**
 * Derive form-level case config from per-question case_property_on fields.
 *
 * Questions with case_property_on matching the module's case type → primary case config.
 * Questions with case_property_on pointing to a different type → child case creation.
 * Case name is always the question with id "case_name" within each case type group.
 */
export interface CaseConfigQuestion {
	id: string;
	type?: string;
	case_property_on?: string;
	children?: CaseConfigQuestion[];
}

export interface DerivedChildCase {
	case_type: string;
	case_name_field: string;
	case_properties: CasePropertyMapping[];
	relationship: "child" | "extension";
	repeat_context?: string;
}

export interface DerivedCaseConfig {
	case_name_field?: string;
	case_properties?: CasePropertyMapping[];
	case_preload?: CasePropertyMapping[];
	child_cases?: DerivedChildCase[];
}

export function deriveCaseConfig(
	questions: CaseConfigQuestion[],
	formType: FormType,
	moduleCaseType?: string,
	caseTypes?: CaseType[] | null,
): DerivedCaseConfig {
	const empty: DerivedCaseConfig = {};
	if (formType === "survey") return empty;

	const primaryProps: CasePropertyMapping[] = [];
	const primaryPreload: CasePropertyMapping[] = [];
	let case_name_field: string | undefined;

	// Child case groups: case_type → { questions with their repeat ancestor }
	const childGroups = new Map<
		string,
		Array<{ id: string; repeatAncestor?: string }>
	>();

	function walk(qs: CaseConfigQuestion[], repeatAncestor?: string) {
		for (const q of qs) {
			const currentRepeat = q.type === "repeat" ? q.id : repeatAncestor;

			if (q.case_property_on) {
				if (q.case_property_on === moduleCaseType) {
					// Primary case property
					if (q.id === "case_name") {
						case_name_field = q.id;
					} else {
						if (CASE_LOADING_FORM_TYPES.has(formType)) {
							primaryPreload.push({ case_property: q.id, question_id: q.id });
						}
						primaryProps.push({ case_property: q.id, question_id: q.id });
					}
				} else {
					// Child case property
					if (!childGroups.has(q.case_property_on))
						childGroups.set(q.case_property_on, []);
					childGroups
						.get(q.case_property_on)
						?.push({ id: q.id, repeatAncestor: currentRepeat });
				}
			}

			if (q.children) walk(q.children, currentRepeat);
		}
	}

	walk(questions);

	const result: DerivedCaseConfig = {};
	if (case_name_field) result.case_name_field = case_name_field;
	if (primaryProps.length > 0) result.case_properties = primaryProps;
	if (primaryPreload.length > 0) result.case_preload = primaryPreload;

	// Derive child cases
	if (childGroups.size > 0 && caseTypes) {
		const derived: DerivedChildCase[] = [];

		for (const [childType, entries] of childGroups) {
			const ctDef = caseTypes.find((ct) => ct.name === childType);
			const relationship = ctDef?.relationship ?? "child";

			// Find case_name question for this child type
			const nameEntry = entries.find((e) => e.id === "case_name");
			const childCaseName = nameEntry?.id ?? entries[0].id;

			// Properties: all entries except the case name
			const childProps: CasePropertyMapping[] = entries
				.filter((e) => e.id !== childCaseName)
				.map((e) => ({ case_property: e.id, question_id: e.id }));

			// Repeat context: if all entries share the same repeat ancestor, use it
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

		result.child_cases = derived;
	}

	return result;
}
