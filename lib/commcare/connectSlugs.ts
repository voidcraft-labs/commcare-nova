/**
 * Connect id validity, creation-time autofill, and the wire-emit resolver.
 *
 * Each per-form `connect` block carries an id (`learn_module.id`,
 * `assessment.id`, `deliver_unit.id`, `task.id`). The XForm builder emits
 * that id three ways for each block: the wrapper element name, the
 * Connect-namespaced `id=` attribute, and every `<bind nodeset="/data/<id>/…">`.
 * CommCare Connect then ingests the id at opportunity-init and writes it
 * into a DB slug column — the tightest, `LearnModule.slug` / `Task.slug`,
 * is a Django `SlugField()` = Postgres `varchar(50)` (`DeliverUnit.slug` is
 * wider at 100). Connect's insert bypasses field validation, so an
 * over-length id reaches Postgres raw and 500s; and the id must be a legal
 * XML element name or the form is malformed.
 *
 * So a connect id has three constraints — legal element name, ≤50 chars,
 * unique across the app — and they are all forced correct at the SOURCE,
 * never fixed up at emit. The same flat app-wide notion of "taken" (every
 * connect id on every form, regardless of kind) is used on every surface:
 *  - {@link connectIdError} is the format/length verdict, shared by the UI
 *    commit guard (`InlineField` in `LearnConfig`) and the per-commit
 *    format/length rules so they can't disagree.
 *  - {@link connectIdConflictError} is the contextual uniqueness verdict for
 *    an explicit set (rejected, never silently renamed). The UI guards
 *    (`LearnConfig`/`DeliverConfig`, via `useAppConnectIds`), the SA tools
 *    (`enforceConnectIds`), and the `CONNECT_ID_DUPLICATE` validator
 *    rule all check it against the app-wide id set.
 *  - {@link deriveConnectId} finalizes a separate creation draft with a valid,
 *    unique, name-derived id before a complete block enters the document.
 *  - {@link buildConnectSlugMap} is the emit-time assertion. It does NOT cap,
 *    dedup, narrow, or fall back; the complete stored id IS the wire slug.
 *    Cross-mode, invalid, or duplicate data throws because it could only have
 *    bypassed the final document schema and topology gate.
 */
import {
	type BlueprintDoc,
	CONNECT_ID_MAX_LENGTH,
	type ConnectAssessment,
	type ConnectDeliverUnit,
	type ConnectLearnModule,
	type ConnectTask,
	type Uuid,
} from "@/lib/domain";
import { XML_ELEMENT_NAME_REGEX } from "./constants";
import { toSnakeId } from "./identifierValidation";

/**
 * Maximum Connect slug length on the wire.
 *
 * Set to the tightest length-bound Connect column — `LearnModule.slug` /
 * `Task.slug` are bare `SlugField()` = Postgres `varchar(50)`. 50 is also
 * safely under `DeliverUnit.slug`'s `varchar(100)`, so one cap covers
 * every kind. (`Assessment` carries no slug column today; capping its id
 * uniformly keeps the wire element-name sane and future-proofs against
 * Connect adding one.)
 */
export const CONNECT_SLUG_MAX_LENGTH = CONNECT_ID_MAX_LENGTH;

/**
 * SA-facing schema description for every connect `id` field.
 *
 * The id is `.optional()` on every Connect sub-config across the agent's
 * shared authoring schemas (`configureConnect` / `configure_connect` and the
 * existing-participant refinement on `updateForm`). Without telling the SA
 * *why* it's optional, the model would either set an id on every block (and
 * risk a fail-the-call on a bad value) or omit it and wonder if the call
 * will fail. This text closes that gap: omitting is the normal, safe path
 * (the tool autofills a valid unique id via `deriveConnectId`), and the
 * exact constraints are stated for the rare case the SA pins a specific id —
 * which then runs through `connectIdError` + `connectIdConflictError` and
 * fails the call if it's malformed or duplicate. Shared across both schema
 * files so the agent-facing contract can't drift between them.
 */
export const CONNECT_ID_FIELD_DESCRIPTION =
	"Leave unset. Nova derives a valid unique id from the name. Set only " +
	`to pin one (XML-name legal, ≤${CONNECT_SLUG_MAX_LENGTH} chars, app-unique).`;

/**
 * The single definition of what makes a connect id valid.
 *
 * A connect id becomes an XML element name in the emitted form (the wrapper
 * `<id vellum:role=...>` and the Connect-namespaced `id=` attribute) and is
 * written into a Connect DB slug column (the tightest is `varchar(50)`). So
 * a valid id must be a legal XML element name AND within
 * {@link CONNECT_SLUG_MAX_LENGTH}. Returns a human-readable reason when the
 * id is invalid, or `null` when it's fine.
 *
 * Shared by both enforcement surfaces so they can never disagree: the
 * field-level commit guard (`InlineField`, wired up in `LearnConfig`) blocks
 * the save and shows the reason inline, and the validator's connect-id
 * rules wrap the same reason in a form-scoped error for the agent path
 * (`update_form`, which sets ids as a bare string and bypasses the field).
 * Callers that need to render the message themselves get the reason; the
 * server rules add the form/kind context around it.
 */
export function connectIdError(id: string): string | null {
	if (!XML_ELEMENT_NAME_REGEX.test(id)) {
		return `"${id}" can't be used as a Connect id, it becomes an XML element name in the form, so it can't contain spaces or start with a digit. Use letters, numbers, and underscores, starting with a letter or underscore.`;
	}
	if (id.length > CONNECT_SLUG_MAX_LENGTH) {
		return `"${id}" is ${id.length} characters. Connect stores ids in a column limited to ${CONNECT_SLUG_MAX_LENGTH}. Shorten it to ${CONNECT_SLUG_MAX_LENGTH} characters or fewer.`;
	}
	return null;
}

/**
 * Contextual uniqueness check for a connect id, complementing the
 * format/length {@link connectIdError}.
 *
 * Every connect id lands in a per-table `(app, slug)` key in Connect, and
 * co-located blocks emit as siblings under one `<data>` element, so connect
 * ids must be globally unique across the app. Returns a reason when `id` is
 * already taken by another block, or `null` when it's free. Kept separate
 * from `connectIdError` because uniqueness is contextual (depends on the
 * other blocks) — the field-level guard and the tools compose both checks,
 * each surfacing the right remediation ("rename" vs "fix the characters").
 *
 * `existingIds` must EXCLUDE the id of the block being edited, so a block's
 * own current value doesn't read as a conflict with itself.
 */
export function connectIdConflictError(
	id: string,
	existingIds: ReadonlySet<string>,
): string | null {
	if (existingIds.has(id)) {
		return `"${id}" is already used by another Connect block in this app. Connect ids must be unique. Choose a different id.`;
	}
	return null;
}

/**
 * Derive a valid, unique connect id from a display `name`, disambiguating
 * against `existingIds`.
 *
 * This is the "force correct at the source" autofill: before a separate
 * creation draft becomes a Connect block, it gets a value from here that is
 * stored in the doc (visible via `get_form` and in the authoring field), not
 * conjured at emit. The result is always a legal XML
 * element name (`toSnakeId`), within {@link CONNECT_SLUG_MAX_LENGTH} (the
 * base is truncated), and unique against `existingIds` (a numeric suffix is
 * appended on collision, re-cutting the base so the suffixed id still fits).
 *
 * Suffix disambiguation lives here — at the source — because it resolves an
 * *implicit* collision between auto-derived defaults (two blocks whose names
 * snake to the same slug). An *explicit* duplicate the user or SA typed is a
 * different case: that's rejected outright by {@link connectIdConflictError},
 * never silently renamed.
 */
export function deriveConnectId(
	name: string,
	existingIds: ReadonlySet<string>,
): string {
	// `toSnakeId` already guarantees legal chars + non-empty (`|| "unnamed"`).
	const base = toSnakeId(name).slice(0, CONNECT_SLUG_MAX_LENGTH);
	if (!existingIds.has(base)) return base;

	// Collision with an existing id: append `_2`, `_3`, … re-cutting the
	// base so the assembled id never exceeds the cap (guards the off-by-one
	// where a longer suffix — `_10`, `_100` — would push it back over).
	for (let n = 2; ; n++) {
		const suffix = `_${n}`;
		const candidate =
			toSnakeId(name).slice(0, CONNECT_SLUG_MAX_LENGTH - suffix.length) +
			suffix;
		if (!existingIds.has(candidate)) return candidate;
	}
}

/**
 * The wire-facing projection retains optional sub-config kinds because a form
 * participates in one or both kinds for its app mode. Every present block is
 * already complete; there is no resolved-vs-stored identity type.
 */
export type ResolvedConnectConfig = {
	learn_module?: ConnectLearnModule;
	assessment?: ConnectAssessment;
	deliver_unit?: ConnectDeliverUnit;
	task?: ConnectTask;
};

/**
 * Resolve the Connect ids for every form into the wire-final shape.
 *
 * A typed pass-through: it asserts each present sub-config's id is set (the
 * source-correctness invariant) and narrows the type — it does not cap,
 * dedup, or fall back. Returns one entry per form whose `connect` is
 * actually wire-emitted; forms with no `connect`, and every form when the
 * app is not in Connect mode (`connectType` null), produce no entry, so
 * callers treat `map.get(formUuid) === undefined` as "nothing to emit".
 *
 * Pure: never mutates the input doc.
 */
export function buildConnectSlugMap(
	doc: BlueprintDoc,
): ReadonlyMap<Uuid, ResolvedConnectConfig> {
	const result = new Map<Uuid, ResolvedConnectConfig>();

	// Accumulate every emitted id → its `<form> <kind>` site so the resolver
	// fails loud on a duplicate. Two distinct blocks sharing an id would
	// collide on Connect's `(app, slug)` key and produce duplicate XForm
	// element names; the source guards + validator should catch it first, so
	// reaching here is an invariant violation.
	const idToSite = new Map<string, string>();
	const claim = (id: string, formName: string, kindLabel: string): void => {
		const reason = connectIdError(id);
		if (reason !== null) {
			throw new Error(
				`Connect block "${formName}" ${kindLabel} reached emission with an invalid final id: ${reason}`,
			);
		}
		const site = `"${formName}" ${kindLabel}`;
		const priorSite = idToSite.get(id);
		if (priorSite) {
			throw new Error(
				`Two Connect blocks share the id "${id}": ${priorSite} and ${site}. Connect ids must be unique across the app (they key the per-kind DB slug and the XForm element name). This should be rejected at the source (the field / tool guards + the CONNECT_ID_DUPLICATE validator rule); reaching emission with a duplicate means a doc skipped that enforcement.`,
			);
		}
		idToSite.set(id, site);
	};

	for (const moduleUuid of doc.moduleOrder) {
		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			const form = doc.forms[formUuid];
			const connect = form?.connect;
			if (!connect) continue;

			if (doc.connectType === null) {
				throw new Error(
					`Form "${form.name}" has Connect configuration while the app has no Connect mode.`,
				);
			}
			const isLearnConfig =
				"learn_module" in connect || "assessment" in connect;
			if ((doc.connectType === "learn") !== isLearnConfig) {
				throw new Error(
					`Form "${form.name}" has Connect configuration for the wrong app mode.`,
				);
			}

			// No transform: the complete stored id is the wire id.
			const next: ResolvedConnectConfig = {};
			if ("learn_module" in connect && connect.learn_module) {
				next.learn_module = connect.learn_module;
				claim(next.learn_module.id, form.name, "learn-module");
			}
			if ("assessment" in connect && connect.assessment) {
				next.assessment = connect.assessment;
				claim(next.assessment.id, form.name, "assessment");
			}
			if ("deliver_unit" in connect && connect.deliver_unit) {
				next.deliver_unit = connect.deliver_unit;
				claim(next.deliver_unit.id, form.name, "deliver-unit");
			}
			if ("task" in connect && connect.task) {
				next.task = connect.task;
				claim(next.task.id, form.name, "task");
			}

			result.set(formUuid, next);
		}
	}

	return result;
}
