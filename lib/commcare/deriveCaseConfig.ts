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
	/**
	 * Wire-format splice-target XPath for the enclosing repeat (e.g.
	 * `/data/group_a/kids`, or `/data/X/item` for `query_bound`), already
	 * resolved during the derivation walk. Consumed by the XForm emitter
	 * verbatim — no second resolution. `undefined` for child cases authored
	 * outside any repeat (splice at the data root).
	 *
	 * NOT the bare repeat field id — that lives on `repeat_ancestor_id` and
	 * is the right value for human-readable validator messages.
	 */
	repeat_context?: string;
	/**
	 * The enclosing repeat field's id (e.g. `kids`), kept alongside
	 * `repeat_context` so validator messages can name the repeat the way
	 * the author authored it. Always set when `repeat_context` is set, and
	 * vice versa; the two travel in lockstep.
	 */
	repeat_ancestor_id?: string;
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
 * Child buckets key on `(case_type, repeat_ancestor_path)`: two cousin
 * repeats authoring fields for the same child case type produce TWO
 * independent `DerivedChildCase` entries — one per repeat — each with
 * its own `repeat_context`. `repeat_context` on the emitted entry is
 * the repeat's full XPath (with the `/item` step appended for
 * `query_bound`), not a bare field id, so cousins sharing an id stay
 * distinguishable downstream.
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
			/** The repeat field's id, for human-readable validator messages. */
			repeatAncestor: string | undefined;
			/**
			 * The repeat's resolved splice-target path — already including the
			 * `/item` step for `query_bound` repeats. The wire-emission
			 * `repeat_context` on `OpenSubCaseAction` is `path.toXPath()`.
			 * Recording the PATH (not the id) per bucket is what
			 * distinguishes two cousin repeats sharing the same id: their
			 * paths differ (`/data/group_a/kids` vs `/data/group_b/kids`),
			 * so they bucket independently.
			 */
			repeatAncestorPath: FormPath | undefined;
			fields: Array<{ id: string; path: FormPath }>;
		}
	>();
	// Bucket key is anchored on the repeat's RESOLVED PATH, not its bare id.
	// CommCare allows cousins to share a field id — two repeats named e.g.
	// `kids` in different groups are legal. Keying by id alone would collapse
	// both into one bucket; their fields would compete in `field_paths` (last
	// write wins) while `repeat_context` resolved separately would still
	// reference one cousin — a split-scope wire shape neither cousin matches.
	// Resolved paths are globally unique even when ids are not.
	const bucketKey = (
		caseType: string,
		repeatAncestorPath: FormPath | undefined,
	) => `${caseType}::${repeatAncestorPath?.toXPath() ?? "#root"}`;

	// The walker threads two things through descent: `parentPath` (so every
	// tracked field gets its fully-resolved `FormPath` recorded) and
	// `repeatAncestorPath` (the splice target for any child-case bucket the
	// walk produces underneath it). Down-stream consumers (`buildFormActions`)
	// read paths directly instead of re-resolving by id — which would be
	// ambiguous when a field id collides with a cousin (the canonical
	// `case_name` shared between the parent and every child case being the
	// bite-back-from-day-one example; cousin repeats sharing an id being a
	// second class of collision). `descendInto` adds the model-iteration
	// `/item` step when crossing into a `query_bound` repeat, matching the
	// XForm emitter's shape.
	const walk = (
		parentUuid: Uuid,
		parentPath: FormPath,
		repeatAncestor: string | undefined,
		repeatAncestorPath: FormPath | undefined,
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

			// `descendInto` produces this field's path for its subtree: for
			// repeats, `/data/<X>` (user_controlled / count_bound) or
			// `/data/<X>/item` (query_bound); for any other container, the
			// identity pass-through. Computed once and reused for both the
			// repeat-splice-target tracking AND the recursive `parentPath`
			// argument below — those two values are always equal when this
			// field is a container, so a single computation makes the
			// equality structural rather than relying on the reader to
			// re-derive it.
			const containerPath = selfPath ? descendInto(field, selfPath) : null;
			const currentRepeat = field.kind === "repeat" ? field.id : repeatAncestor;
			const currentRepeatPath =
				field.kind === "repeat" && containerPath
					? containerPath
					: repeatAncestorPath;
			const casePropertyOn = readFieldString(field, "case_property_on", doc);

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
					// Child case property — bucket by (case_type, repeat_path).
					// Bucketing requires a resolved path; a bad-id field can't
					// emit a valid bind anyway, so the doc is broken at a higher
					// level and the validator catches it independently.
					const key = bucketKey(casePropertyOn, currentRepeatPath);
					let bucket = childGroups.get(key);
					if (!bucket) {
						bucket = {
							caseType: casePropertyOn,
							repeatAncestor: currentRepeat,
							repeatAncestorPath: currentRepeatPath,
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
			if (containerPath && doc.fieldOrder[fieldUuid] !== undefined) {
				walk(fieldUuid, containerPath, currentRepeat, currentRepeatPath);
			}
		}
	};

	walk(formUuid, FormPath.root(), undefined, undefined);

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
			repeatAncestorPath: FormPath | undefined;
			fields: Array<{ id: string; path: FormPath }>;
		}
	>,
	caseTypes: CaseType[],
): DerivedChildCase[] {
	const derived: DerivedChildCase[] = [];

	for (const bucket of childGroups.values()) {
		const ctDef = caseTypes.find((ct) => ct.name === bucket.caseType);
		const relationship = ctDef?.relationship ?? "child";

		// Child case name source: the field id'd `case_name` in this bucket.
		// `undefined` when absent — the validator rule `childCaseNoNameField`
		// reports against this bucket so the author sees an actionable error
		// rather than a silently re-purposed unrelated field.
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

		// Two repeat slots travel together on each emitted child case:
		// `repeat_context` (wire-format splice-target XPath, drives emission
		// in `buildFormActions` + `addCaseBlocks`) and `repeat_ancestor_id`
		// (bare field id, drives human-readable validator messages so the
		// author sees the repeat the way they authored it, not as wire XPath).
		// Both source from the same bucket — they're set or unset in lockstep.
		const repeatContext = bucket.repeatAncestorPath?.toXPath();
		const repeatAncestorId = bucket.repeatAncestor;

		derived.push({
			case_type: bucket.caseType,
			...(childCaseName && { case_name_field: childCaseName }),
			case_properties: childProps,
			relationship,
			...(repeatContext && { repeat_context: repeatContext }),
			...(repeatAncestorId && { repeat_ancestor_id: repeatAncestorId }),
			field_paths: fieldPaths,
		});
	}

	return derived;
}
