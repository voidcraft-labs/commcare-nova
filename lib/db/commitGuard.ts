// The guarded-commit conflict primitives — the concurrent-delete guard and its
// rejection error.
//
// Extracted from `applyBlueprintChange.ts` (which imports `apps.ts`) so
// `apps.ts::commitGuardedBatch` can import them without forming an
// `apps.ts`↔`applyBlueprintChange.ts` cycle. Depends only on the doc/mutation
// vocabulary — nothing from `apps.ts`.

import { roleAllowsApp } from "@/lib/auth/projectRoles";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc } from "@/lib/domain";
import { assertNever } from "@/lib/utils/assertNever";
import { projectRoleFor } from "./projectMembership";

/**
 * Thrown by the guarded commit when, against the freshly read blueprint, a
 * mutation targets a concurrently-removed entity ({@link batchTargetsMissing})
 * or the re-run validity verdict rejects the batch. Carries the
 * person-to-person findings as its message. The MCP/chat tool's catch returns
 * it in the standard `{ error }` envelope; the auto-save PUT maps it to a 409
 * the builder recovers from by reloading.
 */
export class BlueprintCommitRejectedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BlueprintCommitRejectedError";
	}
}

/**
 * Thrown by the guarded commit when the actor is no longer authorized to write
 * the app AT ALL — not a member of its current Project (`role === null`, or a
 * role without `edit`), or, for a null-`project_id` app, not its owner.
 *
 * TERMINAL, unlike {@link BlueprintCommitRejectedError}: a conflict is
 * retryable (reload + rebuild + re-commit lands on the fresh state), but a
 * reload can't make the actor authorized — retrying re-denies. So the auto-save
 * PUT maps this to a 403 (not a 409-reload, which would re-PUT into the same
 * denial), and the chat SA's `wrapMutating` lets it PROPAGATE (fail the run)
 * rather than catching it to reload-and-continue. A concurrent Project MOVE is
 * NOT this error — the actor may be a member of the destination, so that stays
 * a retryable `BlueprintCommitRejectedError`. Defined here (not imported from
 * `appAccess.ts`) to keep the `apps.ts`↔`appAccess.ts` cycle broken.
 */
export class CommitReauthError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CommitReauthError";
	}
}

/**
 * Reject a commit whose actor is no longer authorized to write the app — the
 * pre-transaction reauth both blueprint-write paths run before touching a
 * store. Caller loads `projectId` (via `loadAppProjectId`, which lives in
 * `apps.ts` and would cycle if imported here) and passes it in.
 *
 *   - Non-null `projectId`: the actor's `auth_member` role must grant `edit`.
 *     `role === null` (not a member) is checked BEFORE `roleAllowsApp` —
 *     `projectRoleFor` returns `string | null` and a non-member's null can't
 *     index the role table. Either failure throws {@link CommitReauthError}.
 *   - Null `projectId` (a pre-tenancy app): NO-OP here — the owner check is
 *     in-transaction against the fresh doc's `owner`, where a concurrent move
 *     is also caught. This pre-txn pass only gates the membership case.
 *
 * `commitGuardedBatch` also runs this before its own transaction, so a
 * deauth'd caller is rejected identically whether they enter through the
 * cross-store saga (`applyBlueprintChange`, whose Postgres DDL runs before the
 * commit) or the direct guarded commit. One definition, both call sites.
 */
export async function reauthorizeActorForCommit(
	projectId: string | null,
	actorUserId: string,
): Promise<void> {
	if (projectId === null) return;
	const role = await projectRoleFor(actorUserId, projectId);
	if (role === null || !roleAllowsApp(role, "edit")) {
		// TERMINAL — a reload can't make the actor a member; retrying re-denies.
		throw new CommitReauthError(
			"You no longer have edit access to this app's Project.",
		);
	}
}

/**
 * Whether any mutation in `mutations` targets an entity that no longer exists
 * on `doc` (accounting for entities the batch itself adds/removes along the
 * way).
 *
 * The guarded commit re-applies a batch onto the FRESH stored doc, and the
 * reducers are TOTAL — a mutation whose target a concurrent writer deleted
 * silently NO-OPS (the reducer returns early), introduces no validator finding,
 * and the verdict passes. That is invisible data loss: the user's edit to the
 * deleted entity never lands and they get no conflict signal. Running this
 * BEFORE the verdict turns that into a {@link BlueprintCommitRejectedError}
 * (→ 409 → the builder reloads), the documented conflict path. A batch that
 * adds an entity then edits it is fine: the simulated live set tracks
 * intra-batch adds.
 *
 * The `switch` is exhaustive over the `Mutation` union — the `default` calls
 * `assertNever`, so a new kind added without a live-set rule fails the build
 * rather than silently returning `false` (the invisible-loss trap).
 */
export function batchTargetsMissing(
	doc: BlueprintDoc,
	mutations: Mutation[],
): boolean {
	const modules = new Set(Object.keys(doc.modules));
	const forms = new Set(Object.keys(doc.forms));
	const fields = new Set(Object.keys(doc.fields));
	// Case-type names present on the doc, plus the ones an earlier
	// `declareCaseType` / `setCaseTypes` in the same batch brings into being —
	// the catalog kinds resolve against this simulated live set the same way
	// the entity kinds resolve against `modules` / `forms` / `fields`.
	const caseTypeNames = new Set((doc.caseTypes ?? []).map((ct) => ct.name));
	// Sub-entity live sets at ITEM granularity, mirroring the entity sets: a
	// column / search-input / option the batch edits, moves, or removes must
	// still exist — a concurrent DELETE of the same item makes the reducer
	// silently no-op instead of surfacing the conflict, the exact invisible
	// data loss this guard closes. Option uuids are already present: the fresh
	// doc was hydrated (backfilled) before this runs. Column / search-input
	// uuids are schema-required.
	const columns = new Set<string>();
	const searchInputs = new Set<string>();
	// Modules whose `caseListConfig` is present. `setCaseListMeta` EDITS an
	// existing config's metadata (`filter` / `icon` / `audioLabel`); a config a
	// peer concurrently cleared is a missing target, not one to resurrect (the
	// reducer no-ops on it — see `mutations/modules.ts`). Tracking config
	// presence (seeded here from the fresh doc, advanced by intra-batch births /
	// clears below) turns a `setCaseListMeta` on a cleared config into a
	// conflict rather than a silent lost filter.
	const modulesWithConfig = new Set<string>();
	for (const mod of Object.values(doc.modules)) {
		const config = mod.caseListConfig;
		if (!config) continue;
		modulesWithConfig.add(mod.uuid);
		for (const col of config.columns) columns.add(col.uuid);
		for (const input of config.searchInputs) searchInputs.add(input.uuid);
	}
	const options = new Set<string>();
	for (const field of Object.values(doc.fields)) {
		if (!("options" in field) || !Array.isArray(field.options)) continue;
		for (const opt of field.options) {
			if (opt.uuid !== undefined) options.add(opt.uuid);
		}
	}
	// A field's parent is a form or a group/repeat field — either may hold it.
	const container = (uuid: string) => forms.has(uuid) || fields.has(uuid);
	for (const m of mutations) {
		switch (m.kind) {
			case "addModule":
				modules.add(m.module.uuid);
				// A module can be born WITH a case-list config (the scaffold's
				// case-list viewer) — seed config presence so a same-batch
				// `setCaseListMeta` on it resolves.
				if (m.module.caseListConfig !== undefined) {
					modulesWithConfig.add(m.module.uuid);
				}
				break;
			case "removeModule":
				if (!modules.has(m.uuid)) return true;
				modules.delete(m.uuid);
				modulesWithConfig.delete(m.uuid);
				break;
			case "updateModule":
				if (!modules.has(m.uuid)) return true;
				// The wholesale config birth / clear (the presence transition the
				// diff emits outside the generic patch): a non-null `caseListConfig`
				// births it, an explicit `null` clears it — track both so a
				// same-batch `setCaseListMeta` sees the post-patch presence.
				if ("caseListConfig" in m.patch) {
					if (m.patch.caseListConfig == null) modulesWithConfig.delete(m.uuid);
					else modulesWithConfig.add(m.uuid);
				}
				break;
			case "moveModule":
			case "renameModule":
			case "setModuleMedia":
				if (!modules.has(m.uuid)) return true;
				break;
			case "addForm":
				if (!modules.has(m.moduleUuid)) return true;
				forms.add(m.form.uuid);
				break;
			case "removeForm":
				if (!forms.has(m.uuid)) return true;
				forms.delete(m.uuid);
				break;
			case "moveForm":
				if (!forms.has(m.uuid) || !modules.has(m.toModuleUuid)) return true;
				break;
			case "renameForm":
			case "updateForm":
			case "setFormMedia":
				if (!forms.has(m.uuid)) return true;
				break;
			case "addField":
				if (!container(m.parentUuid)) return true;
				fields.add(m.field.uuid);
				break;
			case "removeField":
				if (!fields.has(m.uuid)) return true;
				fields.delete(m.uuid);
				break;
			case "moveField":
				if (!fields.has(m.uuid) || !container(m.toParentUuid)) return true;
				break;
			case "renameField":
			case "duplicateField":
			case "updateField":
			case "convertField":
				if (!fields.has(m.uuid)) return true;
				break;
			case "setFieldMedia":
				if (!fields.has(m.fieldUuid)) return true;
				break;
			// ── Granular case-type catalog ─────────────────────────────
			case "declareCaseType":
				caseTypeNames.add(m.caseType);
				break;
			case "setCaseTypes":
				// Wholesale replace (event-log replay only; the live diff never
				// emits it) — re-seed the simulated catalog names.
				caseTypeNames.clear();
				for (const ct of m.caseTypes ?? []) caseTypeNames.add(ct.name);
				break;
			case "retireCaseType":
				if (!caseTypeNames.has(m.caseType)) return true;
				caseTypeNames.delete(m.caseType);
				break;
			case "addCaseProperty":
			case "removeCaseProperty":
			case "setCaseProperty":
			case "setCaseTypeMeta":
				// A catalog edit against a type a concurrent writer retired (and
				// not re-declared earlier in this batch) is a conflict, not a
				// silent no-op.
				if (!caseTypeNames.has(m.caseType)) return true;
				break;
			// ── Granular case-list collections (module-owned) ──────────
			// Add checks the parent module and seeds the new item; update / move
			// / remove check the ITEM's own uuid (a concurrently-removed target is
			// a conflict, not a silent no-op). `setCaseListMeta` is module-scoped.
			case "addColumn":
				if (!modules.has(m.moduleUuid)) return true;
				// The first column births a config-less module's config (the
				// legitimate config-birth path); seed presence so a same-batch
				// `setCaseListMeta` on it resolves.
				modulesWithConfig.add(m.moduleUuid);
				columns.add(m.column.uuid);
				break;
			case "removeColumn":
				if (!columns.has(m.uuid)) return true;
				columns.delete(m.uuid);
				break;
			case "updateColumn":
			case "moveColumn":
			case "moveColumnInList":
			case "moveColumnInDetail":
				if (!columns.has(m.uuid)) return true;
				break;
			case "addSearchInput":
				if (!modules.has(m.moduleUuid)) return true;
				// The first search input births a config-less module's config;
				// seed presence so a same-batch `setCaseListMeta` resolves.
				modulesWithConfig.add(m.moduleUuid);
				searchInputs.add(m.searchInput.uuid);
				break;
			case "removeSearchInput":
				if (!searchInputs.has(m.uuid)) return true;
				searchInputs.delete(m.uuid);
				break;
			case "updateSearchInput":
			case "moveSearchInput":
				if (!searchInputs.has(m.uuid)) return true;
				break;
			case "setCaseListMeta":
				// Editing an existing config's metadata: the module AND its config
				// must still be present. A peer who cleared the whole case-list
				// config (`updateModule{caseListConfig:null}`) is a concurrent
				// removal — reject it as a conflict so the filter/icon edit reloads
				// (409) rather than resurrecting the removed case list empty.
				if (!modules.has(m.uuid) || !modulesWithConfig.has(m.uuid)) {
					return true;
				}
				break;
			case "setCaseSearchMarker":
				// The semantic reducer may intentionally no-op on fresh peer state,
				// but a removed owning module is still a real missing target.
				if (!modules.has(m.uuid)) return true;
				break;
			// ── Granular select options (field-owned) ──────────────────
			case "addOption":
				if (!fields.has(m.fieldUuid)) return true;
				if (m.option.uuid !== undefined) options.add(m.option.uuid);
				break;
			case "removeOption":
				if (!options.has(m.uuid)) return true;
				options.delete(m.uuid);
				break;
			case "updateOption":
			case "moveOption":
				if (!options.has(m.uuid)) return true;
				break;
			// ── App-level scalars — no entity target, always safe ──────
			case "setAppName":
			case "setConnectType":
			case "setAppLogo":
				break;
			default:
				assertNever(m, "batchTargetsMissing");
		}
	}
	return false;
}
