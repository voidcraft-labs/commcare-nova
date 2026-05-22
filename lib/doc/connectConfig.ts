/**
 * CommCare Connect configuration auto-derivation.
 *
 * Populates sensible defaults for Connect config based on form content
 * (field count drives `time_estimate`; a hidden-kind field named like
 * `*score*` or `*assessment*` drives `assessment.user_score`). Called
 * from `validateAndFix` before the structural validator runs so every
 * defaulted field is present when rules fire.
 *
 * Operates directly on `BlueprintDoc` — no wire-format round-trip.
 *
 * Scope: this module owns Layer 2 (validate-time) defaults. Wire-emit
 * defaults for fields like `deliver_unit.entity_id` /
 * `deliver_unit.entity_name` live alongside the bind emitter in
 * `lib/commcare/xform/builder.ts`.
 */
import { deriveConnectId } from "@/lib/commcare/connectSlugs";
import type { AppConnectId } from "@/lib/doc/hooks/useAppConnectIds";
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
 * Called from the agent's mutation builders in `lib/agent/blueprintHelpers.ts`
 * (`addFormMutations` / `updateFormMutations` / `setScaffoldMutations`) when
 * a connect block lands on a form.
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

/**
 * Collect every connect id currently set across the whole doc, all four
 * kinds. Feeds `deriveConnectId`'s uniqueness disambiguation so an
 * autofilled id never collides with an id already in use elsewhere — the
 * "unique by construction" guarantee. Only set (non-empty) ids count; an
 * id-less block contributes nothing (it has no id to clash with yet).
 */
function collectConnectIds(doc: BlueprintDoc): Set<string> {
	const ids = new Set<string>();
	for (const formUuid of Object.keys(doc.forms)) {
		const c = doc.forms[formUuid as Uuid]?.connect;
		if (!c) continue;
		for (const id of [
			c.learn_module?.id,
			c.assessment?.id,
			c.deliver_unit?.id,
			c.task?.id,
		]) {
			if (id) ids.add(id);
		}
	}
	return ids;
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

	// Names feed `deriveConnectId`: learn_module / deliver_unit derive from
	// the module name; assessment / task from `<module> <form>` (snake-ified
	// inside the helper). Passing raw names — the helper owns the slugging.
	const moduleNameRaw = moduleName ?? "module";
	const pairNameRaw = `${moduleNameRaw} ${form.name}`;

	// Every connect id already set anywhere in the app. `deriveConnectId`
	// disambiguates against this so an autofilled id is unique by
	// construction. We add each id we mint as we go, so two id-less blocks
	// on this same form (cross-kind) can't derive the same slug either.
	const existingIds = collectConnectIds(doc);

	// Clone so we never mutate the input doc's connect struct. Sub-configs
	// are shallow-cloned below as they're touched.
	const next: ConnectConfig = { ...form.connect };

	if (connectType === "learn") {
		if (next.learn_module) {
			const lm = { ...next.learn_module };
			if (lm.id === undefined) {
				lm.id = deriveConnectId(moduleNameRaw, existingIds);
				existingIds.add(lm.id);
			}
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
			if (as.id === undefined) {
				as.id = deriveConnectId(pairNameRaw, existingIds);
				existingIds.add(as.id);
			}
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
			if (du.id === undefined) {
				du.id = deriveConnectId(moduleNameRaw, existingIds);
				existingIds.add(du.id);
			}
			du.name ||= form.name;
			// `entity_id` / `entity_name` are wire-emit defaults — see
			// `lib/commcare/xform/builder.ts`. Layer 2 doesn't fill them
			// because doing so would persist a wire-format choice into
			// the doc; the doc tracks what the user/agent set, the
			// emitter handles the rest.
			next.deliver_unit = du;
		}
		if (next.task) {
			const t = { ...next.task };
			if (t.id === undefined) {
				t.id = deriveConnectId(pairNameRaw, existingIds);
				existingIds.add(t.id);
			}
			next.task = t;
		}
	}

	return next;
}

/**
 * Context for {@link dedupeRestoredConnectIds}: locates the form whose
 * Connect config is being written and supplies the app-wide id scope plus
 * the names autofill derives from when a block carries no id.
 */
export interface RestoredConnectIdContext {
	/** The form being written. Its own ids are excluded from the "taken"
	 *  scope — the write replaces this form's blocks wholesale, so an id it
	 *  already carries must not read as a conflict with itself. */
	formUuid: Uuid;
	/** Every Connect id currently set across the app (the `useAppConnectIds`
	 *  subscription's output). The base "taken" scope is this minus the ids
	 *  owned by `formUuid`. */
	appConnectIds: readonly AppConnectId[];
	/** Owning module name — the autofill source for an id-less learn_module /
	 *  deliver_unit (those kinds derive from the module name). */
	moduleName: string;
	/** This form's name — combined with `moduleName` as the autofill source
	 *  for an id-less assessment / task. */
	formName: string;
}

/**
 * Force every Connect id in a config unique-at-the-source before a UI
 * restore or seed path writes it.
 *
 * The Connect toggles write a whole `ConnectConfig` at once: re-enabling
 * Connect from a stash, restoring a sub-block from its last-seen ref, or
 * seeding a fresh pair of blocks. Format and length were already valid when
 * the config was stashed (and are simply absent on a fresh seed) and can't
 * drift, so the only thing re-checked here is UNIQUENESS — while a block was
 * toggled off, another form may have claimed its id.
 *
 * Each present sub-config is processed in the fixed kind order the wire
 * emitter uses (learn_module, assessment, deliver_unit, task):
 *  - a present id that's still unique is KEPT verbatim (no work lost);
 *  - a present id that now collides is re-derived FROM ITSELF, so `deriveConnectId`
 *    appends a numeric suffix ("intro" → "intro_2") rather than replacing the
 *    user's chosen slug wholesale — preserve intent as closely as uniqueness
 *    allows;
 *  - an absent id (a fresh seed) is derived from the entity name, exactly as
 *    creation-time autofill does (`moduleName` for learn_module / deliver_unit,
 *    `<module> <form>` for assessment / task).
 *
 * A collision is always IMPLICIT here (uniqueness drifted underneath the
 * user, or two seeded blocks snake to the same base) — never an explicit
 * duplicate someone typed — so it's disambiguated, not rejected. The
 * explicit-duplicate rejection lives on the field commit guard and the SA
 * tools. This is the UI twin of the agent path's `enforceConnectIds`: same
 * "force ids unique at the source" goal, but a toggle can't fail a tool
 * call, so it re-derives.
 *
 * Heal-on-touch: the base scope excludes ALL of this form's ids (the write
 * replaces them), so if this form already carried a block whose id duplicated
 * another form's, touching one sub-toggle re-derives that block too — a
 * pre-existing collision on the same form is silently healed. That state
 * shouldn't reach a user (creation guards + the migration + the emit
 * invariant all prevent it), but the heal is deliberate, not an accident.
 *
 * Pure: returns a new config; never mutates the input.
 */
export function dedupeRestoredConnectIds(
	config: ConnectConfig,
	ctx: RestoredConnectIdContext,
): ConnectConfig {
	// Base scope: every Connect id owned by ANOTHER form. This form's own
	// blocks are excluded wholesale — see the heal-on-touch note above.
	const taken = new Set<string>();
	for (const entry of ctx.appConnectIds) {
		if (entry.formUuid === ctx.formUuid) continue;
		taken.add(entry.id);
	}

	const out: ConnectConfig = { ...config };
	const pairName = `${ctx.moduleName} ${ctx.formName}`;

	// Keep a still-unique id; otherwise derive a fresh unique one, seeded
	// from the existing id when present (minimal change) or the entity name
	// when absent (autofill). Each committed id joins `taken` so two blocks
	// in the same config can't land on the same slug.
	const handle = <T extends { id?: string }>(
		sub: T | undefined,
		entityName: string,
		assign: (next: T) => void,
	): void => {
		if (!sub) return;
		if (sub.id !== undefined && !taken.has(sub.id)) {
			taken.add(sub.id);
			assign(sub);
			return;
		}
		const id = deriveConnectId(sub.id ?? entityName, taken);
		taken.add(id);
		assign({ ...sub, id });
	};

	handle(out.learn_module, ctx.moduleName, (n) => {
		out.learn_module = n;
	});
	handle(out.assessment, pairName, (n) => {
		out.assessment = n;
	});
	handle(out.deliver_unit, ctx.moduleName, (n) => {
		out.deliver_unit = n;
	});
	handle(out.task, pairName, (n) => {
		out.task = n;
	});

	return out;
}
