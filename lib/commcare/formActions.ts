/**
 * HQ `FormActions` + `case_references_data.load` assembly.
 *
 * These are the two pieces of CommCare wire output that translate the
 * derived case config (primary open/update/close/preload + child cases)
 * into the exact shapes the HQ import JSON expects. Every `question_path`
 * value is a `/data/...` path resolved through the doc's field tree so
 * nested groups / repeats produce the correct dotted address.
 *
 * `buildCaseReferencesLoad` is the complement: it scans every field's
 * XPath expressions for `#case/` / `#user/` hashtags and maps the
 * field's full `/data/...` path to the list of hashtag references used
 * at that path. CommCare's Vellum editor consumes this map to resolve
 * shorthand references back to their case sources at build time.
 */

import type { FormActions, OpenSubCaseAction } from "@/lib/commcare";
import {
	alwaysCondition,
	emptyFormActions,
	extractHashtags,
	ifCondition,
	MEDIA_FIELD_KINDS,
	neverCondition,
	RESERVED_CASE_PROPERTIES,
} from "@/lib/commcare";
import {
	type BlueprintDoc,
	CASE_LOADING_FORM_TYPES,
	type Field,
	type Uuid,
} from "@/lib/domain";
import {
	effectiveAssessmentUserScore,
	effectiveDeliverEntities,
} from "./connectDefaults";
import type { ResolvedConnectConfig } from "./connectSlugs";
import { deriveCaseConfig } from "./deriveCaseConfig";
import { readFieldString } from "./fieldProps";
import { FormPath } from "./xform/formPath";

/**
 * Given a container field and its OWN path, return the path its children
 * live under. For a `query_bound` (Vellum "model iteration") repeat that's
 * one `<item>` step deeper (`<X>/<item>`); for every other field it's the
 * field's own path. Mirrors `Vellum/src/modeliteration.js::
 * modelRepeatMugOptions.getPathName` (appends `/item` when
 * `dataSource.idsQuery` is set) and the bind-emission shape in
 * `xform/builder.ts::buildContainer`.
 *
 * The single authority for the `/item` descent decision — every walk over
 * the field tree that needs a child's path (`findField`,
 * `buildCaseReferencesLoad`, the subcase splice-target resolution in
 * `buildFormActions`) routes through here. A walk that forgot the `/item`
 * step would silently emit `/data/<X>/<field>` where the data element is
 * `/data/<X>/item/<field>` — a dangling reference no oracle catches at the
 * HQ-JSON layer. Centralizing the decision makes that drift unrepresentable.
 */
export function descendInto(field: Field, ownPath: FormPath): FormPath {
	return field.kind === "repeat" && field.repeat_mode === "query_bound"
		? ownPath.queryBoundIteration()
		: ownPath;
}

/**
 * Locate a field by bare id under `parentUuid`, returning both the
 * entity and its resolved `FormPath` in one traversal.
 *
 * Tree descent follows `doc.fieldOrder[parentUuid]`; a present
 * `doc.fieldOrder[childUuid]` entry is the container marker, signalling
 * a nested field set to recurse into. The returned `path` threads every
 * ancestor container segment so callers don't have to re-walk the tree
 * to compute it.
 *
 * Descent into a `query_bound` repeat adds the `/item` step via
 * `descendInto`. The matched field's OWN path never gets `/item` (the
 * repeat IS the matched field; `/item` is what lives INSIDE it).
 */
function findField(
	doc: BlueprintDoc,
	parentUuid: Uuid,
	fieldId: string,
	prefix: FormPath = FormPath.root(),
): { field: Field; path: FormPath } | null {
	for (const fieldUuid of doc.fieldOrder[parentUuid] ?? []) {
		const field = doc.fields[fieldUuid];
		if (!field) continue;
		const selfPath = prefix.child(field.id);
		if (field.id === fieldId) return { field, path: selfPath };
		if (doc.fieldOrder[fieldUuid] !== undefined) {
			const found = findField(
				doc,
				fieldUuid,
				fieldId,
				descendInto(field, selfPath),
			);
			if (found) return found;
		}
	}
	return null;
}

/**
 * Resolve a field id to its `FormPath`. Falls back to the bare
 * `/data/{id}` — a one-segment path is the correct emission when the
 * field lives at the form root, and validator rules are responsible
 * for rejecting id references that don't resolve to any field.
 */
function resolvePath(
	doc: BlueprintDoc,
	parentUuid: Uuid,
	fieldId: string,
): FormPath {
	return (
		findField(doc, parentUuid, fieldId)?.path ?? FormPath.root().child(fieldId)
	);
}

/**
 * Build HQ's `FormActions` object for `formUuid`.
 *
 * Maps the derived case config (`case_properties`, `case_preload`,
 * `close_condition`, `child_cases`) to HQ's `open_case` / `update_case` /
 * `case_preload` / `close_case` / `subcases` action shapes, filtering
 * reserved property names and media field kinds on the update path
 * (HQ rejects both). Every field path is resolved through the form's
 * group/repeat hierarchy so the emitted `question_path` matches the
 * XForm's nested instance nodes.
 */
export function buildFormActions(
	doc: BlueprintDoc,
	formUuid: Uuid,
	moduleCaseType: string,
): FormActions {
	const base = emptyFormActions();
	const form = doc.forms[formUuid];

	if (form.type === "survey" || !moduleCaseType) {
		return base;
	}

	const { case_name_field, case_properties, case_preload, child_cases } =
		deriveCaseConfig(doc, formUuid, moduleCaseType, form.type);

	// Build a safe update map: skip reserved property names (HQ rejects
	// them on update) and skip media kinds (CommCare doesn't let binary
	// blobs ride the case-property channel). Each entry routes through
	// `findField` once — the returned record carries both the kind
	// (for the media filter) and the resolved path.
	const buildSafeUpdateMap = (
		caseProperties?: Array<{ case_property: string; question_id: string }>,
	): Record<string, { question_path: string; update_mode: string }> => {
		const updateMap: Record<
			string,
			{ question_path: string; update_mode: string }
		> = {};
		if (!caseProperties) return updateMap;
		for (const {
			case_property: caseProp,
			question_id: fieldId,
		} of caseProperties) {
			if (RESERVED_CASE_PROPERTIES.has(caseProp)) continue;
			const hit = findField(doc, formUuid, fieldId);
			if (hit && MEDIA_FIELD_KINDS.has(hit.field.kind)) continue;
			const qPath = hit?.path ?? FormPath.root().child(fieldId);
			updateMap[caseProp] = {
				question_path: qPath.toXPath(),
				update_mode: "always",
			};
		}
		return updateMap;
	};

	if (form.type === "registration") {
		// Open case + name update. The derived `case_name_field` is the
		// sole authoritative source — the validator's `NO_CASE_NAME_FIELD`
		// rule already rejects registration forms without one, so reaching
		// the emitter without a derived name means an upstream invariant
		// broke. Throw loudly rather than synthesizing a `/data/name` path
		// that doesn't exist in the XForm.
		base.open_case.condition = alwaysCondition();
		if (!case_name_field) {
			throw new Error(
				`Registration form '${form.id}' reached the expander without a case-name field — validator should have caught this.`,
			);
		}
		base.open_case.name_update.question_path = resolvePath(
			doc,
			formUuid,
			case_name_field,
		).toXPath();

		const updateMap = buildSafeUpdateMap(case_properties);
		if (Object.keys(updateMap).length > 0) {
			base.update_case.condition = alwaysCondition();
			base.update_case.update = updateMap;
		}
	}

	if (CASE_LOADING_FORM_TYPES.has(form.type)) {
		const updateMap = buildSafeUpdateMap(case_properties);
		if (Object.keys(updateMap).length > 0) {
			base.update_case.condition = alwaysCondition();
			base.update_case.update = updateMap;
		}

		// Preload case data — also filter reserved words since HQ rejects
		// them in preload maps too.
		if (case_preload && case_preload.length > 0) {
			const preloadMap: Record<string, string> = {};
			for (const {
				question_id: fieldId,
				case_property: caseProp,
			} of case_preload) {
				if (RESERVED_CASE_PROPERTIES.has(caseProp)) continue;
				preloadMap[resolvePath(doc, formUuid, fieldId).toXPath()] = caseProp;
			}
			if (Object.keys(preloadMap).length > 0) {
				base.case_preload.condition = alwaysCondition();
				base.case_preload.preload = preloadMap;
			}
		}
	}

	// Close-case action (close forms only — form.type IS the signal).
	if (form.type === "close") {
		if (form.closeCondition?.field && form.closeCondition?.answer) {
			base.close_case = {
				doc_type: "FormAction",
				condition: ifCondition(
					resolvePath(doc, formUuid, form.closeCondition.field).toXPath(),
					form.closeCondition.answer,
					form.closeCondition.operator ?? "=",
				),
			};
		} else {
			// Unconditional close (default for close forms).
			base.close_case = {
				doc_type: "FormAction",
				condition: alwaysCondition(),
			};
		}
	}

	// Child / sub-cases (auto-derived from `case_property_on` pointing at a
	// different case type).
	if (child_cases && child_cases.length > 0) {
		base.subcases = child_cases.map((child): OpenSubCaseAction => {
			// The child-case bucket must carry a `case_name`-id'd field — the
			// validator rule `childCaseNoNameField` rejects a bucket without one,
			// so reaching the expander with an unset `case_name_field` means an
			// upstream invariant broke. Throw loudly (mirroring the primary case's
			// guard above) rather than letting `resolvePath("")` fall through to
			// `FormPath.root().child("")` and surface an opaque XML-name error.
			if (!child.case_name_field) {
				throw new Error(
					`Form '${form.id}' derives a child case of type '${child.case_type}' with no case-name field — validator should have caught this.`,
				);
			}

			// Child case property paths come from `field_paths` — the per-bucket
			// path map deriveCaseConfig recorded during its walk. Resolving by id
			// from the form root would be ambiguous when a child-case field
			// shares an id with a cousin (the canonical `case_name`-shared-with-
			// parent example: top-level `resolvePath("case_name")` returns the
			// parent's `/data/case_name`, NOT the child's in-repeat path, and
			// the child case's create binds silently calculate from the parent's
			// name field).
			const childProps: Record<
				string,
				{ question_path: string; update_mode: string }
			> = {};
			for (const {
				case_property: caseProp,
				question_id: fieldId,
			} of child.case_properties) {
				if (RESERVED_CASE_PROPERTIES.has(caseProp)) continue;
				const path = child.field_paths.get(fieldId);
				childProps[caseProp] = {
					question_path: (path ?? FormPath.root().child(fieldId)).toXPath(),
					update_mode: "always",
				};
			}

			// Subcase wrapper splice target. `child.repeat_context` is the
			// resolved XPath string already (deriveCaseConfig records the
			// repeat's path during its walk, including the `/item` step for
			// `query_bound`). Pass through verbatim — no second resolution,
			// no cousin-id ambiguity.
			const repeatContextStr = child.repeat_context ?? "";

			// Child case name source — pulled from the bucket's `field_paths`
			// map (scope-correct) rather than re-resolved by id from the form
			// root (cousin-ambiguous; would return the parent case's
			// `/data/case_name` for every child whose name field is also
			// `case_name`).
			const caseNamePath = child.field_paths.get(child.case_name_field);
			if (!caseNamePath) {
				throw new Error(
					`Form '${form.id}' derives child case '${child.case_type}' with a case-name field '${child.case_name_field}' that has no recorded path — deriveCaseConfig and buildFormActions are out of sync.`,
				);
			}
			return {
				doc_type: "OpenSubCaseAction",
				case_type: child.case_type,
				name_update: {
					question_path: caseNamePath.toXPath(),
					update_mode: "always",
				},
				reference_id: "",
				case_properties: childProps,
				repeat_context: repeatContextStr,
				relationship: child.relationship,
				close_condition: neverCondition(),
				condition: alwaysCondition(),
			};
		});
	}

	return base;
}

/**
 * Build `case_references_data.load` for `formUuid`.
 *
 * Walks every field under the form, extracts `#case/` / `#user/`
 * hashtag references from its XPath-valued properties (`relevant`,
 * `validate`, `calculate`, `default_value`, `required`), and emits a
 * map from the field's full `/data/...` path to the list of hashtags
 * it references. Also scans the Connect assessment / deliver-unit
 * XPath fields and emits their own entries keyed by the Connect
 * wrapper paths.
 *
 * `connect` is the resolved config from `buildConnectSlugMap` (a typed
 * pass-through; ids are valid by construction at the source). The XForm
 * builder emits its binds against those same ids, so the load-map keys here
 * line up with the bind nodesets.
 */
export function buildCaseReferencesLoad(
	doc: BlueprintDoc,
	formUuid: Uuid,
	connect?: ResolvedConnectConfig,
): Record<string, string[]> {
	const load: Record<string, string[]> = {};

	const walk = (parentUuid: Uuid, parentPath: FormPath): void => {
		for (const fieldUuid of doc.fieldOrder[parentUuid] ?? []) {
			const field = doc.fields[fieldUuid];
			if (!field) continue;
			const nodePath = parentPath.child(field.id);

			const xpathExprs = [
				readFieldString(field, "relevant"),
				readFieldString(field, "validate"),
				readFieldString(field, "calculate"),
				readFieldString(field, "default_value"),
				readFieldString(field, "required"),
			].filter((s): s is string => typeof s === "string");
			const hashtags = extractHashtags(xpathExprs);
			if (hashtags.length > 0) {
				load[nodePath.toXPath()] = hashtags;
			}

			// Containers: recurse into their children. `doc.fieldOrder`
			// having an entry for this uuid is the container marker.
			// `descendInto` adds the model-iteration `<item>` step for
			// `query_bound` so descendant paths match the XForm emitter +
			// `findField`.
			if (doc.fieldOrder[fieldUuid] !== undefined) {
				walk(fieldUuid, descendInto(field, nodePath));
			}
		}
	};

	walk(formUuid, FormPath.root());

	// Connect assessment + deliver unit carry their own XPath fields
	// keyed by the Connect wrapper ids.
	if (connect?.assessment) {
		const assessId = connect.assessment.id;
		// `effectiveAssessmentUserScore` is the single source of truth for
		// the wire-fallback policy — the bind emitter calls the same helper,
		// so the load map's hashtag set always matches what the runtime will
		// evaluate from that bind. (The default is a hashtag-free literal,
		// so an unset user_score contributes no load entry.)
		const h = extractHashtags([
			effectiveAssessmentUserScore(connect.assessment),
		]);
		if (h.length > 0) {
			load[
				FormPath.root()
					.child(assessId)
					.child("assessment")
					.child("user_score")
					.toXPath()
			] = h;
		}
	}
	if (connect?.deliver_unit) {
		const duId = connect.deliver_unit.id;
		// `effectiveDeliverEntities` is the single source of truth for
		// the wire-fallback policy. The bind emitter calls the same
		// helper, so the load map's hashtag set always matches what the
		// runtime will evaluate from those binds.
		const { entityId, entityName } = effectiveDeliverEntities(
			connect.deliver_unit,
		);
		const deliverPath = FormPath.root().child(duId).child("deliver");
		const idH = extractHashtags([entityId]);
		if (idH.length > 0) {
			load[deliverPath.child("entity_id").toXPath()] = idH;
		}
		const nameH = extractHashtags([entityName]);
		if (nameH.length > 0) {
			load[deliverPath.child("entity_name").toXPath()] = nameH;
		}
	}

	return load;
}
