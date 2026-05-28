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
import { descendInto } from "./formActions";
import { FormPath } from "./xform/formPath";

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
	/**
	 * Resolved data-tree path per field-id in this bucket (`case_name` source +
	 * each `case_properties[].question_id`). Populated during the
	 * `deriveCaseConfig` walk, where the path is unambiguous because the walker
	 * threads `parentPath` through descent. Downstream consumers
	 * (`buildFormActions`) read paths from here directly instead of re-resolving
	 * by id — which would be ambiguous when a child-case field shares an id
	 * with a cousin (e.g. the canonical `case_name` shared between the parent
	 * and every child case). Without this map, a top-level `resolvePath(doc,
	 * formUuid, "case_name")` returns the FIRST id-match (the parent's path),
	 * not the child's in-repeat path, and the child case's create/case_name
	 * bind silently calculates from the parent's name field.
	 */
	field_paths: Map<string, FormPath>;
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
	// to its own `repeat_context`. The "no repeat ancestor" bucket pairs the
	// root-level case-type fields into one bucket per type, preserving today's
	// non-repeat-subcase semantic.
	const childGroups = new Map<
		string,
		{
			caseType: string;
			repeatAncestor: string | undefined;
			fields: Array<{ id: string; path: FormPath }>;
		}
	>();
	// The root-ancestor sentinel contains `#`, illegal in an XML element name
	// (`XML_ELEMENT_NAME_REGEX`), so a real repeat field id (always a valid
	// element name) can never collide with it. A plain-word sentinel like
	// `"__root__"` would NOT be safe: `__root__` is itself a legal field id
	// (only the `__nova_` prefix is reserved), so a repeat named `__root__`
	// would merge into the root bucket and silently lose its scope.
	const bucketKey = (caseType: string, repeatAncestor: string | undefined) =>
		`${caseType}::${repeatAncestor ?? "#root"}`;

	// The walker accumulates `parentPath` so every tracked field gets its
	// fully-resolved `FormPath` recorded alongside its id. Down-stream
	// consumers (`buildFormActions`) read paths from this map directly
	// instead of calling `resolvePath(doc, formUuid, fieldId)`, which would
	// be ambiguous for cousin-id collisions (e.g. the canonical `case_name`
	// shared between a parent case at form root and a child case inside a
	// repeat). `descendInto` adds the model-iteration `/item` step when
	// crossing into a `query_bound` repeat, matching the XForm emitter's
	// shape.
	const walk = (
		parentUuid: Uuid,
		parentPath: FormPath,
		repeatAncestor?: string,
	): void => {
		for (const fieldUuid of doc.fieldOrder[parentUuid] ?? []) {
			const field = doc.fields[fieldUuid];
			if (!field) continue;

			// A bad field id (leading digit, hyphen, etc.) makes
			// `parentPath.child` throw because FormPath enforces the XML
			// element-name regex. The doc-layer validator rejects those ids
			// separately via `CASE_PROPERTY_BAD_FORMAT` / `INVALID_FIELD_ID`,
			// so derivation skips path tracking for the bad field rather than
			// crashing — and skips its subtree too, because every descendant's
			// path would also be unresolvable. Primary-case tracking (which
			// only needs ids, not paths) still runs.
			let selfPath: FormPath | null = null;
			try {
				selfPath = parentPath.child(field.id);
			} catch {
				selfPath = null;
			}

			const currentRepeat = field.kind === "repeat" ? field.id : repeatAncestor;
			const casePropertyOn = readFieldString(field, "case_property_on");

			if (casePropertyOn) {
				if (casePropertyOn === moduleCaseType) {
					// Primary case property — id-only tracking, no path required
					// (the existing `resolvePath` consumer in `buildFormActions`
					// has the same id-based behavior; pre-existing scope.)
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
				} else if (selfPath) {
					// Child case property — bucket by (case_type, repeat_ancestor).
					// Bucketing requires a resolved path; a bad-id field can't
					// emit a valid bind anyway, so the doc is broken at a higher
					// level and the validator catches it independently.
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
					bucket.fields.push({ id: field.id, path: selfPath });
				}
			}

			// Recurse into container children — but only when we have a valid
			// `selfPath`, since descendant paths thread off it. A container
			// with a bad id has the validator firing against it; skipping its
			// subtree here keeps the derivation total without masking the
			// upstream error.
			if (selfPath && doc.fieldOrder[fieldUuid] !== undefined) {
				walk(fieldUuid, descendInto(field, selfPath), currentRepeat);
			}
		}
	};

	walk(formUuid, FormPath.root());

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
			fields: Array<{ id: string; path: FormPath }>;
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

		// Per-field path map — built from the bucket's recorded paths. Each
		// field's path is the one the walker accumulated during descent, so
		// it's scope-correct even when the field id collides with a cousin
		// elsewhere in the form (the canonical `case_name`-shared-with-parent
		// case being the bite-back-from-day-one example).
		const fieldPaths = new Map<string, FormPath>(
			bucket.fields.map((e) => [e.id, e.path]),
		);

		derived.push({
			case_type: bucket.caseType,
			...(childCaseName && { case_name_field: childCaseName }),
			case_properties: childProps,
			relationship,
			...(bucket.repeatAncestor && { repeat_context: bucket.repeatAncestor }),
			field_paths: fieldPaths,
		});
	}

	return derived;
}
