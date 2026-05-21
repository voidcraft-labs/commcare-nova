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
 * A Connect config whose sub-config ids are resolved — the wire-final
 * output of {@link buildConnectSlugMap}.
 *
 * On the raw `ConnectConfig`, each sub-config's `id` is optional (the SA
 * may omit it). After resolution every present sub-config carries an id, so
 * the type makes `id` required (a `string`) — consumers read `<kind>.id`
 * with no fallback and no non-null assertion. The type guarantees presence
 * and string-ness only; non-emptiness (the `|| FALLBACK_ID` substitution)
 * is enforced at runtime in {@link buildConnectSlugMap}, since `string`
 * still admits `""`.
 */
type Resolved<T extends { id?: string }> = Omit<T, "id"> & { id: string };
export type ResolvedConnectConfig = {
	learn_module?: Resolved<ConnectLearnModule>;
	assessment?: Resolved<ConnectAssessment>;
	deliver_unit?: Resolved<ConnectDeliverUnit>;
	task?: Resolved<ConnectTask>;
};

/**
 * Stable per-kind fallback id used when a block carries no explicit id.
 *
 * The wire-final id is never empty — the XForm element name, `id=` attr,
 * and bind nodesets all need a non-empty token. Centralizing the fallback
 * here (rather than repeating `|| "connect_learn"` at each consumer) keeps
 * the XForm builder, the load map, and the validator agreeing on the same
 * id for an id-less block. All four are well under the cap.
 */
const FALLBACK_ID = {
	learn_module: "connect_learn",
	assessment: "connect_assessment",
	deliver_unit: "connect_deliver",
	task: "connect_task",
} as const;

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
		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			const connect = doc.forms[formUuid]?.connect;
			if (!connect) continue;

			// Fresh per-form scope: every block in THIS form claims against it,
			// so no two of the form's blocks (regardless of kind) can land the
			// same slug — which would emit duplicate sibling element names.
			const inForm = new Set<string>();

			// Resolve each present sub-config: shallow-clone (so the capped id
			// never writes back into the doc's struct) and replace `id` with a
			// slug claimed against both its app-wide-per-kind scope and this
			// form's cross-kind scope. Absent sub-configs stay absent.
			const next: ResolvedConnectConfig = {};

			if (connect.learn_module) {
				next.learn_module = {
					...connect.learn_module,
					id: claimSlug(connect.learn_module.id || FALLBACK_ID.learn_module, [
						appWide.learn_module,
						inForm,
					]),
				};
			}
			if (connect.assessment) {
				next.assessment = {
					...connect.assessment,
					id: claimSlug(connect.assessment.id || FALLBACK_ID.assessment, [
						appWide.assessment,
						inForm,
					]),
				};
			}
			if (connect.deliver_unit) {
				next.deliver_unit = {
					...connect.deliver_unit,
					id: claimSlug(connect.deliver_unit.id || FALLBACK_ID.deliver_unit, [
						appWide.deliver_unit,
						inForm,
					]),
				};
			}
			if (connect.task) {
				next.task = {
					...connect.task,
					id: claimSlug(connect.task.id || FALLBACK_ID.task, [
						appWide.task,
						inForm,
					]),
				};
			}

			result.set(formUuid, next);
		}
	}

	return result;
}
