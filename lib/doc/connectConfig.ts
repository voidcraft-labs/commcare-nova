/**
 * CommCare Connect configuration auto-derivation.
 *
 * Populates sensible defaults for Connect config based on form content
 * (question count drives `time_estimate`; a hidden-kind field named like
 * `*score*` or `*assessment*` drives `assessment.user_score`). Called
 * from `validateAndFix` before the structural validator runs so every
 * defaulted field is present when rules fire.
 *
 * Operates directly on `BlueprintDoc` — no wire-format round-trip.
 */
import { toSnakeId } from "@/lib/commcare";
import type {
	BlueprintDoc,
	ConnectConfig,
	ConnectType,
	HiddenField,
	Uuid,
} from "@/lib/domain";
import { isContainer } from "@/lib/domain";

/**
 * Count every non-container field under `parentUuid` recursively.
 *
 * Connect's `time_estimate` default divides this count by three; containers
 * (group/repeat) are skipped because they don't represent a prompt on
 * their own. Safe against dangling uuids in `fieldOrder`.
 */
function countInputFields(doc: BlueprintDoc, parentUuid: Uuid): number {
	let total = 0;
	const stack: Uuid[] = [...(doc.fieldOrder[parentUuid] ?? [])];
	while (stack.length > 0) {
		const uuid = stack.pop() as Uuid;
		const field = doc.fields[uuid];
		if (!field) continue;
		if (!isContainer(field)) total++;
		if (isContainer(field)) {
			for (const c of doc.fieldOrder[uuid] ?? []) stack.push(c);
		}
	}
	return total;
}

/**
 * Find a hidden field likely to be an assessment score — a hidden field
 * with a non-empty `calculate` whose semantic id matches /score|assessment/.
 * Used as the default `assessment.user_score` expression when the caller
 * didn't supply one.
 */
function findScoreField(
	doc: BlueprintDoc,
	parentUuid: Uuid,
): HiddenField | undefined {
	const stack: Uuid[] = [...(doc.fieldOrder[parentUuid] ?? [])];
	while (stack.length > 0) {
		const uuid = stack.pop() as Uuid;
		const field = doc.fields[uuid];
		if (!field) continue;
		if (
			field.kind === "hidden" &&
			field.calculate &&
			/score|assessment/i.test(field.id)
		) {
			return field;
		}
		if (isContainer(field)) {
			for (const c of doc.fieldOrder[uuid] ?? []) stack.push(c);
		}
	}
	return undefined;
}

/**
 * Strip empty Connect sub-configs so absent data stays absent.
 *
 * Sub-configs that exist but contain only empty/default-sentinel values
 * are removed — preventing the XForm builder from emitting empty blocks.
 * Called from the doc store's `updateForm` mutation on every connect edit.
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

/** Inputs for `deriveConnectDefaults`. Options-object signature so the
 *  call site reads as named arguments — every field is non-positional
 *  and `moduleName` stays clearly optional. */
export interface DeriveConnectDefaultsInput {
	connectType: ConnectType;
	doc: BlueprintDoc;
	formUuid: Uuid;
	moduleName?: string;
}

/**
 * Build a defaulted Connect config for a form, given the app-level
 * `connectType` + the form's current config + surrounding context (form
 * name, module name, field tree). Returns the new `ConnectConfig` value
 * (or `undefined` if the form has no Connect block at all). Pure — does
 * not mutate the doc.
 *
 * Only fills sub-configs that are already present; empty/missing keys
 * are never auto-created. The UI or SA decides *whether* a sub-config
 * exists; this helper only fills in scalar defaults when the sub-config
 * is present and the scalar is empty.
 */
export function deriveConnectDefaults({
	connectType,
	doc,
	formUuid,
	moduleName,
}: DeriveConnectDefaultsInput): ConnectConfig | undefined {
	const form = doc.forms[formUuid];
	if (!form?.connect) return form?.connect ?? undefined;

	const modSlug = toSnakeId(moduleName ?? "module");
	const formSlug = toSnakeId(form.name);

	// Clone so we never mutate the input doc's connect struct. Sub-configs
	// are shallow-cloned below as they're touched — each `??=` / `||=`
	// operates on the clone.
	const next: ConnectConfig = { ...form.connect };

	if (connectType === "learn") {
		if (next.learn_module) {
			const lm = { ...next.learn_module };
			lm.id ??= modSlug;
			lm.name ||= form.name;
			lm.description ||= form.name;
			lm.time_estimate ??= Math.max(
				1,
				Math.ceil(countInputFields(doc, formUuid) / 3),
			);
			next.learn_module = lm;
		}
		if (next.assessment) {
			const as = { ...next.assessment };
			as.id ??= `${modSlug}_${formSlug}`;
			if (!as.user_score) {
				const scoreField = findScoreField(doc, formUuid);
				as.user_score = scoreField?.calculate ?? "100";
			}
			next.assessment = as;
		}
	}

	if (connectType === "deliver") {
		if (next.deliver_unit) {
			const du = { ...next.deliver_unit };
			du.id ??= modSlug;
			du.name ||= form.name;
			du.entity_id ||= "concat(#user/username, '-', today())";
			du.entity_name ||= "#user/username";
			next.deliver_unit = du;
		}
		if (next.task) {
			const t = { ...next.task };
			t.id ??= `${modSlug}_${formSlug}`;
			next.task = t;
		}
	}

	return next;
}
