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
	type ConnectConfig,
	type Field,
	type Uuid,
} from "@/lib/domain";
import { deriveCaseConfig } from "./deriveCaseConfig";
import { readFieldString } from "./fieldProps";

/**
 * Locate a field by bare id under `parentUuid`, returning both the
 * entity and its resolved `/data/...` path in one traversal.
 *
 * Tree descent follows `doc.fieldOrder[parentUuid]`; a present
 * `doc.fieldOrder[childUuid]` entry is the container marker, signalling
 * a nested field set to recurse into. The returned `path` threads every
 * ancestor container segment so callers don't have to re-walk the tree
 * to compute it.
 */
function findField(
	doc: BlueprintDoc,
	parentUuid: Uuid,
	fieldId: string,
	prefix = "/data",
): { field: Field; path: string } | null {
	for (const fieldUuid of doc.fieldOrder[parentUuid] ?? []) {
		const field = doc.fields[fieldUuid];
		if (!field) continue;
		const selfPath = `${prefix}/${field.id}`;
		if (field.id === fieldId) return { field, path: selfPath };
		if (doc.fieldOrder[fieldUuid] !== undefined) {
			const found = findField(doc, fieldUuid, fieldId, selfPath);
			if (found) return found;
		}
	}
	return null;
}

/**
 * Resolve a field id to its `/data/...` path. Falls back to the bare
 * `/data/{id}` — a one-segment path is the correct emission when the
 * field lives at the form root, and validator rules are responsible
 * for rejecting id references that don't resolve to any field.
 */
function resolvePath(
	doc: BlueprintDoc,
	parentUuid: Uuid,
	fieldId: string,
): string {
	return findField(doc, parentUuid, fieldId)?.path ?? `/data/${fieldId}`;
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
			const qPath = hit?.path ?? `/data/${fieldId}`;
			updateMap[caseProp] = { question_path: qPath, update_mode: "always" };
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
		);

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
				preloadMap[resolvePath(doc, formUuid, fieldId)] = caseProp;
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
					resolvePath(doc, formUuid, form.closeCondition.field),
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

	// Child / sub-cases (auto-derived from `case_property` pointing at a
	// different case type).
	if (child_cases && child_cases.length > 0) {
		base.subcases = child_cases.map((child): OpenSubCaseAction => {
			const childProps: Record<
				string,
				{ question_path: string; update_mode: string }
			> = {};
			for (const {
				case_property: caseProp,
				question_id: fieldId,
			} of child.case_properties) {
				if (RESERVED_CASE_PROPERTIES.has(caseProp)) continue;
				childProps[caseProp] = {
					question_path: resolvePath(doc, formUuid, fieldId),
					update_mode: "always",
				};
			}

			return {
				doc_type: "OpenSubCaseAction",
				case_type: child.case_type,
				name_update: {
					question_path: resolvePath(doc, formUuid, child.case_name_field),
					update_mode: "always",
				},
				reference_id: "",
				case_properties: childProps,
				repeat_context: child.repeat_context
					? resolvePath(doc, formUuid, child.repeat_context)
					: "",
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
 */
export function buildCaseReferencesLoad(
	doc: BlueprintDoc,
	formUuid: Uuid,
	connect?: ConnectConfig,
): Record<string, string[]> {
	const load: Record<string, string[]> = {};

	const walk = (parentUuid: Uuid, parentPath: string): void => {
		for (const fieldUuid of doc.fieldOrder[parentUuid] ?? []) {
			const field = doc.fields[fieldUuid];
			if (!field) continue;
			const nodePath = `${parentPath}/${field.id}`;

			const xpathExprs = [
				readFieldString(field, "relevant"),
				readFieldString(field, "validate"),
				readFieldString(field, "calculate"),
				readFieldString(field, "default_value"),
				readFieldString(field, "required"),
			].filter((s): s is string => typeof s === "string");
			const hashtags = extractHashtags(xpathExprs);
			if (hashtags.length > 0) {
				load[nodePath] = hashtags;
			}

			// Containers: recurse into their children. `doc.fieldOrder`
			// having an entry for this uuid is the container marker.
			if (doc.fieldOrder[fieldUuid] !== undefined) {
				walk(fieldUuid, nodePath);
			}
		}
	};

	walk(formUuid, "/data");

	// Connect assessment + deliver unit carry their own XPath fields
	// keyed by the Connect wrapper ids.
	if (connect?.assessment?.user_score) {
		const assessId = connect.assessment.id || "connect_assessment";
		const h = extractHashtags([connect.assessment.user_score]);
		if (h.length > 0) load[`/data/${assessId}/assessment/user_score`] = h;
	}
	if (connect?.deliver_unit) {
		const duId = connect.deliver_unit.id || "connect_deliver";
		const idH = extractHashtags([connect.deliver_unit.entity_id]);
		if (idH.length > 0) load[`/data/${duId}/deliver/entity_id`] = idH;
		const nameH = extractHashtags([connect.deliver_unit.entity_name]);
		if (nameH.length > 0) load[`/data/${duId}/deliver/entity_name`] = nameH;
	}

	return load;
}
