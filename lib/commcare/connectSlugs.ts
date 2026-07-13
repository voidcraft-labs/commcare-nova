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
 *  - {@link deriveConnectId} is the creation-time autofill: an id-less block
 *    gets a valid, unique, name-derived id STORED in the doc.
 *  - {@link buildConnectSlugMap} is the emit-time resolver — a typed
 *    pass-through that asserts each block's id is present + valid and that no
 *    two blocks collide, then narrows the type. It does NOT cap, dedup, or
 *    fall back; the stored id IS the wire slug. It throws (fail-loud) if a
 *    missing, invalid, or duplicate id reaches it, and processes only blocks
 *    matching the doc's `connectType` (so a stray cross-mode block neither
 *    ships nor trips the invariant). The validator reads `form.connect`
 *    directly rather than through this resolver, because it must report an
 *    id-less block as a finding (`CONNECT_ID_MISSING`) instead of throwing.
 */
import type {
	BlueprintDoc,
	ConnectAssessment,
	ConnectDeliverUnit,
	ConnectLearnModule,
	ConnectTask,
	Uuid,
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
export const CONNECT_SLUG_MAX_LENGTH = 50;

/**
 * SA-facing schema description for every connect `id` field.
 *
 * The id is `.optional()` on every connect sub-config across the agent's
 * tool schemas (`updateForm` and the atomic creation
 * tools `createForm` / `createModule`). Without telling the SA
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
	"Leave unset — Nova derives a valid unique id from the name. Set only " +
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
		return `"${id}" can't be used as a Connect id — it becomes an XML element name in the form, so it can't contain spaces or start with a digit. Use letters, numbers, and underscores, starting with a letter or underscore.`;
	}
	if (id.length > CONNECT_SLUG_MAX_LENGTH) {
		return `"${id}" is ${id.length} characters — Connect stores ids in a column limited to ${CONNECT_SLUG_MAX_LENGTH}. Shorten it to ${CONNECT_SLUG_MAX_LENGTH} characters or fewer.`;
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
		return `"${id}" is already used by another Connect block in this app. Connect ids must be unique — choose a different id.`;
	}
	return null;
}

/**
 * Derive a valid, unique connect id from a display `name`, disambiguating
 * against `existingIds`.
 *
 * This is the "force correct at the source" autofill: the instant a connect
 * block is created or enabled without an explicit id, it gets a value from
 * here that is STORED in the doc (visible via `get_form` and in the
 * authoring field), not conjured at emit. The result is always a legal XML
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
 * A Connect config whose sub-config ids are resolved — the output of
 * {@link buildConnectSlugMap}.
 *
 * On the raw `ConnectConfig`, each sub-config's `id` is optional (the
 * authoring schema admits an unset id). Resolution narrows `id` from
 * `string | undefined` to a required `string`, so the three wire consumers
 * (XForm builder, case-references load map, validator valid-path set) read
 * `<kind>.id` with no fallback and no non-null assertion.
 */
type Resolved<T extends { id?: string }> = Omit<T, "id"> & { id: string };
export type ResolvedConnectConfig = {
	learn_module?: Resolved<ConnectLearnModule>;
	assessment?: Resolved<ConnectAssessment>;
	deliver_unit?: Resolved<ConnectDeliverUnit>;
	task?: Resolved<ConnectTask>;
};

/**
 * Narrow one sub-config's id from `string | undefined` to a valid `string`
 * — the emit invariant: emit a valid id or throw.
 *
 * The resolver does NOT transform ids — no cap, no dedup, no sanitize, no
 * fallback. Every connect id is forced valid (legal element name + ≤50 +
 * unique) at the SOURCE: `deriveConnectId` autofills an omitted id on every
 * block-writing path (the SA tools via `enforceConnectIds`, the UI
 * seed/restore via `dedupeRestoredConnectIds`), and `connectIdError` +
 * `connectIdConflictError` reject bad explicit input at the UI commit guard
 * and the SA tools. So a block reaching emission with a missing OR invalid
 * id (over-length / bad characters) is an invariant violation — an entry
 * point skipped that enforcement. We throw loud rather than papering over
 * it: silently capping or sanitizing here would corrupt the wire (a
 * different id than the doc records). The throw is a tripwire BEHIND the
 * validator, not a user surface: every export entry point runs the
 * zero-tolerance boundary gate first, whose `CONNECT_ID_MISSING` /
 * format/length/duplicate rules report the same states as actionable
 * findings — so in practice this never fires.
 */
function narrowId<T extends { id?: string }>(
	sub: T,
	kind: string,
): Resolved<T> {
	if (!sub.id) {
		throw new Error(
			`A Connect ${kind} block reached emission with no id. Every connect id is supposed to be filled and validated at the source (creation autofill + the field / tool guards). Reaching here with a blank id means an entry point skipped that enforcement — look at where this block was created or last edited.`,
		);
	}
	const reason = connectIdError(sub.id);
	if (reason) {
		throw new Error(
			`A Connect ${kind} block reached emission with an invalid id: ${reason} The resolver does not fix ids — they're enforced valid at the source (creation autofill + the field / tool guards). An invalid id here means a doc skipped that enforcement; find the entry point that wrote it.`,
		);
	}
	return { ...sub, id: sub.id };
}

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

	// Connect blocks are only resolved when the app-level `connectType` is
	// set — this early return is the gate. Off-mode there's no live connect
	// config to emit, so callers get an empty map.
	if (!doc.connectType) return result;
	const isLearn = doc.connectType === "learn";

	// Accumulate every emitted id → its `<form> <kind>` site so the resolver
	// fails loud on a duplicate. Two distinct blocks sharing an id would
	// collide on Connect's `(app, slug)` key and produce duplicate XForm
	// element names; the source guards + validator should catch it first, so
	// reaching here is an invariant violation.
	const idToSite = new Map<string, string>();
	const claim = (id: string, formName: string, kindLabel: string): void => {
		const site = `"${formName}" ${kindLabel}`;
		const priorSite = idToSite.get(id);
		if (priorSite) {
			throw new Error(
				`Two Connect blocks share the id "${id}" — ${priorSite} and ${site}. Connect ids must be unique across the app (they key the per-kind DB slug and the XForm element name). This should be rejected at the source (the field / tool guards + the CONNECT_ID_DUPLICATE validator rule); reaching emission with a duplicate means a doc skipped that enforcement.`,
			);
		}
		idToSite.set(id, site);
	};

	for (const moduleUuid of doc.moduleOrder) {
		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			const form = doc.forms[formUuid];
			const connect = form?.connect;
			if (!connect) continue;

			// Narrow each sub-config's id; absent sub-configs stay absent. Only
			// the kinds matching the app's mode are processed — the schema isn't
			// mode-discriminated, so a learn app can carry a stray `deliver_unit`
			// block (and vice versa). The defaulter only fills the matching
			// mode's blocks; the resolver agrees by emitting only those, so a
			// cross-mode (possibly id-less) block neither ships nor trips the
			// invariant. No transform — the stored id is the wire id.
			const next: ResolvedConnectConfig = {};
			if (isLearn && connect.learn_module) {
				next.learn_module = narrowId(connect.learn_module, "learn-module");
				claim(next.learn_module.id, form.name, "learn-module");
			}
			if (isLearn && connect.assessment) {
				next.assessment = narrowId(connect.assessment, "assessment");
				claim(next.assessment.id, form.name, "assessment");
			}
			if (!isLearn && connect.deliver_unit) {
				next.deliver_unit = narrowId(connect.deliver_unit, "deliver-unit");
				claim(next.deliver_unit.id, form.name, "deliver-unit");
			}
			if (!isLearn && connect.task) {
				next.task = narrowId(connect.task, "task");
				claim(next.task.id, form.name, "task");
			}

			// Only record an entry when there's actually something to emit. A
			// form whose `connect` holds only a cross-mode stray matches no
			// live-kind arm above, leaving `next` empty — recording `{}` would
			// break the contract that `map.get(formUuid) === undefined` means
			// "nothing to emit" (a truthy `{}` would mislead a consumer that
			// branches on the entry's presence).
			if (Object.keys(next).length > 0) result.set(formUuid, next);
		}
	}

	return result;
}
