/**
 * Form action builder for CommCare HQ import format.
 *
 * Builds the HQ FormActions object (case open/update/close, preloads, subcases)
 * and case_references_data.load map from blueprint form definitions.
 * Extracted from hqJsonExpander.ts to isolate case/action logic.
 */

import type { CaseType, ConnectConfig } from "@/lib/domain";
import type { BlueprintForm, Question } from "../doc/legacyTypes";
import type { FormActions, OpenSubCaseAction } from "./commcare";
import {
	alwaysCondition,
	emptyFormActions,
	extractHashtags,
	ifCondition,
	MEDIA_FIELD_KINDS,
	neverCondition,
	RESERVED_CASE_PROPERTIES,
} from "./commcare";
import { deriveCaseConfig } from "./deriveCaseConfig";

/**
 * Resolve a question ID to its full /data/... path (including parent groups/repeats).
 * Questions inside groups need paths like /data/group_id/question_id.
 */
function resolveFieldPath(
	questions: Question[],
	questionId: string,
	prefix = "/data",
): string | null {
	for (const q of questions) {
		if (q.id === questionId) return `${prefix}/${q.id}`;
		if ((q.type === "group" || q.type === "repeat") && q.children) {
			const found = resolveFieldPath(
				q.children,
				questionId,
				`${prefix}/${q.id}`,
			);
			if (found) return found;
		}
	}
	return null;
}

/**
 * Build the HQ FormActions object for a form.
 *
 * Maps blueprint case config (case_properties, case_preload, close_condition,
 * child_cases) to HQ's action format with question_path references.
 * Silently filters reserved property names and media questions.
 * All question paths are resolved through the group/repeat hierarchy.
 */
export function buildFormActions(
	form: BlueprintForm,
	moduleCaseType: string,
	caseTypes?: CaseType[] | null,
): FormActions {
	const base = emptyFormActions();

	if (form.type === "survey" || !moduleCaseType) {
		return base;
	}

	// Derive case config on-demand from per-question fields
	const { case_name_field, case_properties, case_preload, child_cases } =
		deriveCaseConfig(
			form.questions || [],
			form.type,
			moduleCaseType,
			caseTypes,
		);

	// Build a safe update map, filtering out reserved property names and media questions
	function buildSafeUpdateMap(
		caseProperties:
			| Array<{ case_property: string; question_id: string }>
			| undefined,
	): Record<string, { question_path: string; update_mode: string }> {
		const updateMap: Record<
			string,
			{ question_path: string; update_mode: string }
		> = {};
		if (!caseProperties) return updateMap;
		// Build a lookup of question id -> type for media filtering
		function getQuestionType(
			questions: Question[],
			id: string,
		): string | undefined {
			for (const q of questions) {
				if (q.id === id) return q.type;
				if ((q.type === "group" || q.type === "repeat") && q.children) {
					const t = getQuestionType(q.children, id);
					if (t) return t;
				}
			}
			return undefined;
		}
		for (const {
			case_property: caseProp,
			question_id: questionId,
		} of caseProperties) {
			if (RESERVED_CASE_PROPERTIES.has(caseProp)) continue; // skip reserved words
			const qType = getQuestionType(form.questions || [], questionId);
			if (qType && MEDIA_FIELD_KINDS.has(qType)) continue; // skip media/binary questions
			const qPath =
				resolveFieldPath(form.questions || [], questionId) ||
				`/data/${questionId}`;
			updateMap[caseProp] = { question_path: qPath, update_mode: "always" };
		}
		return updateMap;
	}

	if (form.type === "registration") {
		// Open case
		base.open_case.condition = alwaysCondition();
		const nameFieldId = case_name_field || form.questions[0]?.id || "name";
		base.open_case.name_update.question_path =
			resolveFieldPath(form.questions || [], nameFieldId) ||
			`/data/${nameFieldId}`;

		// Update case properties (filtered)
		const updateMap = buildSafeUpdateMap(case_properties);
		if (Object.keys(updateMap).length > 0) {
			base.update_case.condition = alwaysCondition();
			base.update_case.update = updateMap;
		}
	}

	if (form.type === "followup" || form.type === "close") {
		// Update case (filtered)
		const updateMap = buildSafeUpdateMap(case_properties);
		if (Object.keys(updateMap).length > 0) {
			base.update_case.condition = alwaysCondition();
			base.update_case.update = updateMap;
		}

		// Preload case data — filter reserved words (HQ rejects them in preloads too)
		if (case_preload && case_preload.length > 0) {
			const preloadMap: Record<string, string> = {};
			for (const {
				question_id: questionId,
				case_property: caseProp,
			} of case_preload) {
				if (RESERVED_CASE_PROPERTIES.has(caseProp)) continue; // HQ rejects reserved words in preloads
				const qPath =
					resolveFieldPath(form.questions || [], questionId) ||
					`/data/${questionId}`;
				preloadMap[qPath] = caseProp;
			}
			if (Object.keys(preloadMap).length > 0) {
				base.case_preload.condition = alwaysCondition();
				base.case_preload.preload = preloadMap;
			}
		}
	}

	// Close case action (close forms only — type IS the signal)
	if (form.type === "close") {
		if (form.close_condition?.question && form.close_condition?.answer) {
			// Conditional close — operator defaults to "=" (exact match),
			// "selected" for multi-select questions
			base.close_case = {
				doc_type: "FormAction",
				condition: ifCondition(
					resolveFieldPath(
						form.questions || [],
						form.close_condition.question,
					) || `/data/${form.close_condition.question}`,
					form.close_condition.answer,
					form.close_condition.operator ?? "=",
				),
			};
		} else {
			// Unconditional close (default for close forms)
			base.close_case = {
				doc_type: "FormAction",
				condition: alwaysCondition(),
			};
		}
	}

	// Child cases / subcases (auto-derived from case_property_on annotations)
	if (child_cases && child_cases.length > 0) {
		base.subcases = child_cases.map((child): OpenSubCaseAction => {
			const childProps: Record<
				string,
				{ question_path: string; update_mode: string }
			> = {};
			for (const {
				case_property: caseProp,
				question_id: questionId,
			} of child.case_properties) {
				if (RESERVED_CASE_PROPERTIES.has(caseProp)) continue;
				const qPath =
					resolveFieldPath(form.questions || [], questionId) ||
					`/data/${questionId}`;
				childProps[caseProp] = { question_path: qPath, update_mode: "always" };
			}

			const nameFieldPath =
				resolveFieldPath(form.questions || [], child.case_name_field) ||
				`/data/${child.case_name_field}`;

			return {
				doc_type: "OpenSubCaseAction",
				case_type: child.case_type,
				name_update: { question_path: nameFieldPath, update_mode: "always" },
				reference_id: "",
				case_properties: childProps,
				repeat_context: child.repeat_context
					? resolveFieldPath(form.questions || [], child.repeat_context) ||
						`/data/${child.repeat_context}`
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
 * Build the case_references_data.load map for a form.
 *
 * Scans all questions for #case/ and #user/ references in XPath expressions
 * (calculate, relevant, validation, default_value) and maps each question's
 * full path to the array of hashtag references it uses. CommCare's Vellum
 * editor uses this to resolve hashtag shorthand at build time.
 */
export function buildCaseReferencesLoad(
	questions: Question[],
	connect?: ConnectConfig,
	parentPath = "/data",
): Record<string, string[]> {
	const load: Record<string, string[]> = {};
	for (const q of questions) {
		const nodePath = `${parentPath}/${q.id}`;
		const xpathExprs = [
			q.relevant,
			q.validation,
			q.calculate,
			q.default_value,
			q.required,
		].filter(Boolean) as string[];
		const hashtags = extractHashtags(xpathExprs);
		if (hashtags.length > 0) {
			load[nodePath] = hashtags;
		}
		if ((q.type === "group" || q.type === "repeat") && q.children) {
			Object.assign(
				load,
				buildCaseReferencesLoad(q.children, undefined, nodePath),
			);
		}
	}

	// Extract hashtag references from Connect XPath fields
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
