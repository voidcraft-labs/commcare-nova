/**
 * CommCare Connect configuration auto-derivation.
 *
 * Populates sensible defaults for Connect config based on form content.
 * Called after all questions are built (in validateAndFix) so it has
 * access to the full question tree.
 */
import type {
	BlueprintForm,
	ConnectConfig,
	ConnectType,
	Question,
} from "../schemas/blueprint";
import { toSnakeId } from "./commcare/validate";

/** Count questions recursively (excluding structural containers). */
function countQuestions(questions: Question[]): number {
	let count = 0;
	for (const q of questions) {
		if (q.type !== "group" && q.type !== "repeat") count++;
		if (q.children) count += countQuestions(q.children);
	}
	return count;
}

/**
 * Find a hidden question likely to be an assessment score.
 * Looks for hidden questions with a calculate expression whose id
 * contains 'score' or 'assessment'.
 */
function findScoreQuestion(questions: Question[]): Question | undefined {
	for (const q of questions) {
		if (q.type === "hidden" && q.calculate && /score|assessment/i.test(q.id)) {
			return q;
		}
		if (q.children) {
			const found = findScoreQuestion(q.children);
			if (found) return found;
		}
	}
	return undefined;
}

/**
 * Auto-populate Connect config defaults from the form's content.
 *
 * @param connectType The app-level connect type ('learn' or 'deliver')
 * @param form The form to populate defaults for (must have `connect` present)
 *
 * Only fills in sub-configs that are missing — existing values are
 * never overwritten. This allows the SA or UI to set explicit values
 * that survive re-derivation.
 */
/**
 * Strip empty Connect sub-configs so absent data stays absent.
 *
 * Sub-configs that exist but contain only empty/default-sentinel values
 * are removed — preventing the XForm builder from emitting empty blocks.
 * Called from MutableBlueprint.updateForm() on every connect mutation.
 */
export function normalizeConnectConfig(
	config: ConnectConfig,
): ConnectConfig | undefined {
	const out = { ...config };

	if (out.task && !out.task.name.trim() && !out.task.description.trim()) {
		delete out.task;
	}

	// Config with no sub-configs at all → remove entirely
	if (!out.learn_module && !out.assessment && !out.deliver_unit && !out.task) {
		return undefined;
	}

	return out;
}

export function deriveConnectDefaults(
	connectType: ConnectType,
	form: BlueprintForm,
	moduleName?: string,
): void {
	if (!form.connect) return;

	const modSlug = toSnakeId(moduleName ?? "module");
	const formSlug = toSnakeId(form.name);

	if (connectType === "learn") {
		// Fill defaults only for sub-configs that are present — learn_module and assessment are independent
		if (form.connect.learn_module) {
			form.connect.learn_module.id ??= modSlug;
			form.connect.learn_module.name ||= form.name;
			form.connect.learn_module.description ||= form.name;
			form.connect.learn_module.time_estimate ??= Math.max(
				1,
				Math.ceil(countQuestions(form.questions || []) / 3),
			);
		}
		if (form.connect.assessment) {
			form.connect.assessment.id ??= `${modSlug}_${formSlug}`;
			if (!form.connect.assessment.user_score) {
				const scoreQ = findScoreQuestion(form.questions || []);
				form.connect.assessment.user_score = scoreQ?.calculate ?? "100";
			}
		}
	}

	if (connectType === "deliver") {
		if (form.connect.deliver_unit) {
			form.connect.deliver_unit.id ??= modSlug;
			form.connect.deliver_unit.name ||= form.name;
			form.connect.deliver_unit.entity_id ||=
				"concat(#user/username, '-', today())";
			form.connect.deliver_unit.entity_name ||= "#user/username";
		}
		if (form.connect.task) {
			form.connect.task.id ??= `${modSlug}_${formSlug}`;
		}
	}
}
