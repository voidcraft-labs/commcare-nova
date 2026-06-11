/**
 * Connect-config doc helpers shared by the writers that land a whole
 * `ConnectConfig` on a form.
 *
 * Two jobs live here:
 *  - `normalizeConnectConfig` — strips empty sub-configs so absent data
 *    stays absent on the doc (and the XForm builder never emits an empty
 *    block).
 *  - `dedupeRestoredConnectIds` — the UI restore/seed twin of the agent
 *    path's `enforceConnectIds` (`lib/agent/tools/shared/connectIds.ts`):
 *    forces every id in a restored/seeded config unique at the source.
 *
 * Connect-id autofill itself lives at `lib/commcare/connectSlugs.ts`
 * (`deriveConnectId`); wire-emit defaults for `deliver_unit.entity_id` /
 * `entity_name` live at `lib/commcare/connectDefaults.ts` and run at
 * bind-emit time only.
 */
import { deriveConnectId } from "@/lib/commcare/connectSlugs";
import type { AppConnectId } from "@/lib/doc/hooks/useAppConnectIds";
import type { ConnectConfig, Uuid } from "@/lib/domain";

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
