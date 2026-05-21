/**
 * Connect slug capping + app-wide deduplication — the single home for
 * "what id a per-form Connect block actually puts on the wire".
 *
 * Each per-form `connect` block carries an id (`learn_module.id`,
 * `assessment.id`, `deliver_unit.id`, `task.id`). The XForm builder emits
 * that id three ways for each block: the wrapper element name, the
 * Connect-namespaced `id=` attribute, and every `<bind nodeset="/data/<id>/…">`.
 * CommCare Connect then ingests the id at opportunity-init and writes it
 * into a DB slug column. The tightest of those columns —
 * `LearnModule.slug` and `Task.slug` — is a Django `SlugField()` with no
 * `max_length`, which is Postgres `varchar(50)`; `DeliverUnit.slug` is
 * wider at `varchar(100)`. Connect's insert path goes through
 * `update_or_create(slug=block.id, …)`, which bypasses Django field
 * validation, so an over-length id reaches Postgres raw and raises
 * `value too long for type character varying(50)` → HTTP 500 at opp-init.
 * Nova generates these ids from form/module names with no length bound, so
 * a long enough name overflows.
 *
 * Capping lives at the wire-emission boundary, not in the doc: the doc
 * tracks what the SA/UI set verbatim (the SA may legitimately hand a long
 * id), and the wire layer normalizes it to Connect's column width — the
 * same split as `connectDefaults.ts`, which fills `deliver_unit` entity
 * XPath defaults at bind-emit time. But unlike those per-form defaults, a
 * slug cap needs visibility across *every* form's Connect ids: truncating
 * two distinct blocks to the same 50-char prefix would collapse them onto
 * one `(app, slug)`-keyed row and silently drop a module. So the resolver
 * takes the whole `BlueprintDoc`, walks all forms once, and disambiguates
 * collisions app-wide. The three wire consumers (XForm builder, the
 * case-references load map, and the validator's valid-path set) all read
 * the resulting map so they agree on one capped id per block.
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
 * the save and shows the reason inline, and the `validate_app` connect-id
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
 * A Connect config whose sub-config ids are resolved — the wire-final
 * output of {@link buildConnectSlugMap}.
 *
 * On the raw `ConnectConfig`, each sub-config's `id` is optional (the SA
 * may omit it). After resolution every present sub-config carries an id, so
 * the type makes `id` required (a `string`) — consumers read `<kind>.id`
 * with no fallback and no non-null assertion. The type guarantees presence
 * and string-ness only; non-emptiness (the `|| fallbackId(...)`
 * substitution) is enforced at runtime in {@link buildConnectSlugMap},
 * since `string` still admits `""`.
 */
type Resolved<T extends { id?: string }> = Omit<T, "id"> & { id: string };
export type ResolvedConnectConfig = {
	learn_module?: Resolved<ConnectLearnModule>;
	assessment?: Resolved<ConnectAssessment>;
	deliver_unit?: Resolved<ConnectDeliverUnit>;
	task?: Resolved<ConnectTask>;
};

/**
 * Per-kind, name-derived fallback id for a block that carries no explicit
 * id (undefined or empty string).
 *
 * Snake-ifies the module and form names independently, then: `learn_module`
 * / `deliver_unit` take the module slug; `assessment` / `task` take
 * `<moduleSlug>_<formSlug>`. This reproduces what the validate-time
 * derivation in `lib/doc/connectConfig.ts::deriveConnectDefaults` mints for
 * the same names. Reproducing it is load-bearing: the doc layer fills ids
 * with `??=` (nullish only), so a user who clears an id to `""` gets no
 * doc-layer default and the empty value reaches this resolver. A static
 * sentinel (`connect_learn`) here would diverge from the doc-layer default
 * and from the authoring UI's "defaults from module name" hint. `toSnakeId`
 * always returns a non-empty token (`|| "unnamed"` internally), so the
 * result is never empty even when the names are blank.
 */
function fallbackId(
	kind: keyof ResolvedConnectConfig,
	moduleName: string,
	formName: string,
): string {
	const modSlug = toSnakeId(moduleName);
	const formSlug = toSnakeId(formName);
	switch (kind) {
		case "learn_module":
		case "deliver_unit":
			return modSlug;
		case "assessment":
		case "task":
			return `${modSlug}_${formSlug}`;
	}
}

/**
 * Claim a unique, capped slug for `rawId` against every supplied scope,
 * recording the result in all of them.
 *
 * A connect slug answers to two independent uniqueness constraints, so a
 * candidate must be free in *all* `scopes` before it's claimed (then it's
 * recorded in every scope):
 *  - the app-wide per-kind scope — Connect keys `LearnModule` / `DeliverUnit`
 *    / `Task` on `(app, slug)`, so two blocks of the same kind anywhere in
 *    the app can't share a slug; and
 *  - the per-form cross-kind scope — the slug IS the XForm element name and
 *    all of a form's blocks emit as siblings in one `<data>`, so two
 *    co-located blocks (even of different kinds, e.g. learn_module +
 *    assessment) can't share a slug or the XForm gets duplicate element
 *    names + duplicate bind nodesets.
 *
 * The id is first truncated to {@link CONNECT_SLUG_MAX_LENGTH}. If that
 * prefix is free everywhere, it wins. Otherwise we append `_2`, `_3`, … —
 * re-cutting the base so the suffix stays inside the length budget — until a
 * candidate is free in every scope. Determinism comes from the caller
 * walking blocks in a fixed order (`moduleOrder` → `formOrder[mod]`, then a
 * fixed kind order within each form); the first block to claim a prefix
 * keeps it bare, later collisions take the next free suffix.
 */
function claimSlug(rawId: string, scopes: ReadonlyArray<Set<string>>): string {
	const isFree = (candidate: string): boolean =>
		scopes.every((scope) => !scope.has(candidate));
	const claim = (candidate: string): string => {
		for (const scope of scopes) scope.add(candidate);
		return candidate;
	};

	const base = rawId.slice(0, CONNECT_SLUG_MAX_LENGTH);
	if (isFree(base)) return claim(base);

	// Collision: try `<prefix>_2`, `<prefix>_3`, … The base is re-cut to
	// leave room for the suffix so the assembled slug never exceeds the
	// cap — guarding the off-by-one where appending a longer suffix
	// (`_10`, `_100`) would push the result back over the limit.
	for (let n = 2; ; n++) {
		const suffix = `_${n}`;
		const candidate =
			rawId.slice(0, CONNECT_SLUG_MAX_LENGTH - suffix.length) + suffix;
		if (isFree(candidate)) return claim(candidate);
	}
}

/**
 * Resolve the wire-final, capped, app-deduped Connect ids for every form
 * in the doc.
 *
 * Returns one entry per form whose `connect` is actually wire-emitted — a
 * `ConnectConfig` clone with each present sub-config's `id` replaced by
 * its capped/deduped slug. Forms with no `connect`, and every form when
 * the app is not in Connect mode (`connectType` null), produce no entry,
 * so callers can treat `map.get(formUuid) === undefined` as "no Connect
 * block to emit" — the same shape they already handle.
 *
 * Deduplication enforces two constraints at once (see {@link claimSlug}):
 * slugs are unique per-kind app-wide (the `(app, slug)` DB key), AND unique
 * across all kinds within a single form (the XForm sibling-element-name
 * constraint). So a `learn_module` and an `assessment` on *different* forms
 * may share a slug, but the same two kinds *co-located on one form* are
 * forced apart.
 *
 * Pure: never mutates the input doc.
 */
export function buildConnectSlugMap(
	doc: BlueprintDoc,
): ReadonlyMap<Uuid, ResolvedConnectConfig> {
	const result = new Map<Uuid, ResolvedConnectConfig>();

	// Connect blocks are only embedded in the export when the app-level
	// `connectType` is set; off-mode the per-form stash is stripped by the
	// expander, so there are no slugs to resolve.
	if (!doc.connectType) return result;

	// One claimed-slug set per kind, shared across all forms — enforces the
	// app-wide `(app, slug)` uniqueness Connect's DB tables require. The
	// per-form cross-kind set is allocated fresh inside the form loop below.
	const appWide = {
		learn_module: new Set<string>(),
		assessment: new Set<string>(),
		deliver_unit: new Set<string>(),
		task: new Set<string>(),
	};

	// Walk in a fixed order so slug assignment (and thus collision
	// disambiguation) is deterministic: the same doc always yields the same
	// slugs. Within each form, kinds are claimed in a fixed order
	// (learn_module → assessment → deliver_unit → task) so the per-form
	// cross-kind tie-break is stable too.
	for (const moduleUuid of doc.moduleOrder) {
		// Names feed the id-less fallback (mirrors the doc-layer derivation).
		// Read once per form rather than per kind.
		const moduleName = doc.modules[moduleUuid]?.name ?? "";

		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			const connect = doc.forms[formUuid]?.connect;
			if (!connect) continue;
			const formName = doc.forms[formUuid].name;

			// Fresh per-form scope: every block in THIS form claims against it,
			// so no two of the form's blocks (regardless of kind) can land the
			// same slug — which would emit duplicate sibling element names.
			const inForm = new Set<string>();

			// Resolve each present sub-config: shallow-clone (so the capped id
			// never writes back into the doc's struct) and replace `id` with a
			// slug claimed against both its app-wide-per-kind scope and this
			// form's cross-kind scope. An undefined or empty id falls back to
			// the name-derived default. Absent sub-configs stay absent.
			const next: ResolvedConnectConfig = {};

			if (connect.learn_module) {
				next.learn_module = {
					...connect.learn_module,
					id: claimSlug(
						connect.learn_module.id ||
							fallbackId("learn_module", moduleName, formName),
						[appWide.learn_module, inForm],
					),
				};
			}
			if (connect.assessment) {
				next.assessment = {
					...connect.assessment,
					id: claimSlug(
						connect.assessment.id ||
							fallbackId("assessment", moduleName, formName),
						[appWide.assessment, inForm],
					),
				};
			}
			if (connect.deliver_unit) {
				next.deliver_unit = {
					...connect.deliver_unit,
					id: claimSlug(
						connect.deliver_unit.id ||
							fallbackId("deliver_unit", moduleName, formName),
						[appWide.deliver_unit, inForm],
					),
				};
			}
			if (connect.task) {
				next.task = {
					...connect.task,
					id: claimSlug(
						connect.task.id || fallbackId("task", moduleName, formName),
						[appWide.task, inForm],
					),
				};
			}

			result.set(formUuid, next);
		}
	}

	return result;
}
