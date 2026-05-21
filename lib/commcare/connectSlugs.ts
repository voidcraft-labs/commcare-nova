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
 * may omit it). After resolution every present sub-config carries a
 * non-empty, capped id, so the type makes `id` required. Consumers that
 * read `connect.<kind>.id` off a resolved config get a `string` with no
 * fallback and no non-null assertion — the resolution guarantee lives in
 * the type, not in a comment.
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
 * Claim a unique, capped slug for `rawId` against the ids already taken
 * for this kind, recording the result in `taken`.
 *
 * First the id is truncated to {@link CONNECT_SLUG_MAX_LENGTH}. If that
 * prefix is free, it wins. Otherwise we append `_2`, `_3`, … — re-cutting
 * the base so the suffix stays inside the length budget — until we find a
 * free slug. Determinism comes from the caller walking blocks in a fixed
 * order (`moduleOrder` → `formOrder[mod]`); the first block to claim a
 * prefix keeps it bare, later collisions take the next free suffix.
 */
function claimSlug(rawId: string, taken: Set<string>): string {
	const base = rawId.slice(0, CONNECT_SLUG_MAX_LENGTH);
	if (!taken.has(base)) {
		taken.add(base);
		return base;
	}

	// Collision: try `<prefix>_2`, `<prefix>_3`, … The base is re-cut to
	// leave room for the suffix so the assembled slug never exceeds the
	// cap — guarding the off-by-one where appending a longer suffix
	// (`_10`, `_100`) would push the result back over the limit.
	for (let n = 2; ; n++) {
		const suffix = `_${n}`;
		const candidate =
			rawId.slice(0, CONNECT_SLUG_MAX_LENGTH - suffix.length) + suffix;
		if (!taken.has(candidate)) {
			taken.add(candidate);
			return candidate;
		}
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
 * Deduplication is per-kind: `learn_module` slugs are unique among
 * themselves, `deliver_unit` slugs among themselves, etc. Cross-kind
 * collisions are left intact because each kind lands in its own DB table
 * and its own XForm data wrapper — a `learn_module` and a `deliver_unit`
 * sharing a slug is harmless.
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

	// One claimed-slug set per kind. Shared across all forms so the cap is
	// app-wide, not per-form — the dedup invariant that keeps two truncated
	// blocks from colliding onto one `(app, slug)` row.
	const taken = {
		learn_module: new Set<string>(),
		assessment: new Set<string>(),
		deliver_unit: new Set<string>(),
		task: new Set<string>(),
	};

	// Walk in a fixed order so slug assignment (and thus collision
	// disambiguation) is deterministic: the same doc always yields the same
	// slugs, which `update_or_create` requires to avoid orphaning rows.
	for (const moduleUuid of doc.moduleOrder) {
		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			const connect = doc.forms[formUuid]?.connect;
			if (!connect) continue;

			// Resolve each present sub-config: shallow-clone (so the capped id
			// never writes back into the doc's struct) and replace `id` with
			// its claimed slug. Absent sub-configs stay absent.
			const next: ResolvedConnectConfig = {};

			if (connect.learn_module) {
				next.learn_module = {
					...connect.learn_module,
					id: claimSlug(
						connect.learn_module.id || FALLBACK_ID.learn_module,
						taken.learn_module,
					),
				};
			}
			if (connect.assessment) {
				next.assessment = {
					...connect.assessment,
					id: claimSlug(
						connect.assessment.id || FALLBACK_ID.assessment,
						taken.assessment,
					),
				};
			}
			if (connect.deliver_unit) {
				next.deliver_unit = {
					...connect.deliver_unit,
					id: claimSlug(
						connect.deliver_unit.id || FALLBACK_ID.deliver_unit,
						taken.deliver_unit,
					),
				};
			}
			if (connect.task) {
				next.task = {
					...connect.task,
					id: claimSlug(connect.task.id || FALLBACK_ID.task, taken.task),
				};
			}

			result.set(formUuid, next);
		}
	}

	return result;
}
