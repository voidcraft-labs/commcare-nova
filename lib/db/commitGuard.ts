// The guarded-commit conflict primitives — the concurrent-delete guard and its
// rejection error.
//
// Extracted from `applyBlueprintChange.ts` (which imports `apps.ts`) so
// `apps.ts::commitGuardedBatch` can import them without forming an
// `apps.ts`↔`applyBlueprintChange.ts` cycle. Depends only on the doc/mutation
// vocabulary — nothing from `apps.ts`.

import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc } from "@/lib/domain";
import { assertNever } from "@/lib/utils/assertNever";

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
 * The chat run lost its exact app-holder capability before a guarded write or
 * terminal transition committed. This is terminal for that run: reloading and
 * retrying the same tool would spend more tokens under an authority that can
 * never land, and any cleanup must leave the replacement holder untouched.
 */
export class RunHolderLostError extends Error {
	constructor(readonly outcome: "superseded" | "released" = "superseded") {
		super(
			outcome === "superseded"
				? "A newer request took over this app. Refresh to get the latest state, then try again."
				: "This chat run was released. Refresh to get the latest state, then try again.",
		);
		this.name = "RunHolderLostError";
	}
}

/**
 * The app changed Project after the caller captured its authoritative scope.
 * This is retryable for request/auto-save clients after an authoritative reload,
 * but terminal for an already-running SA turn: continuing would charge work
 * whose every write is guaranteed to reject against the stale tenant scope.
 */
export class AppProjectChangedError extends Error {
	constructor() {
		super(
			"This app moved to a different Project while you were editing. Reload to get the latest state.",
		);
		this.name = "AppProjectChangedError";
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
 * rather than catching it to reload-and-continue. A concurrent Project move is
 * the separate {@link AppProjectChangedError}: a request client can reload its
 * authoritative scope, while an already-running SA turn must stop. Defined here
 * (not imported from `appAccess.ts`) to keep the
 * `apps.ts`↔`appAccess.ts` cycle broken.
 */
export class CommitReauthError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CommitReauthError";
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
	// presence (seeded here from the fresh doc, advanced by semantic / collection
	// births and explicit clears below) turns a `setCaseListMeta` on a cleared
	// config into a conflict rather than a silent lost filter.
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
	// The three flat user collections, tracked at the same item granularity:
	// an update or remove against an entity a peer concurrently removed is a
	// conflict, because the reducer would silently no-op on it.
	const userProperties = new Set(Object.keys(doc.userProperties ?? {}));
	const userTypes = new Set(Object.keys(doc.userTypes ?? {}));
	const personas = new Set(Object.keys(doc.personas ?? {}));
	// Case operations are form-owned; their writes and links have logical
	// identity inside one operation. Track all three levels so the authoritative
	// writer rejects the reducer's otherwise-silent no-op both for concurrent
	// deletes and for colliding same-key adds.
	const caseOperationsByForm = new Map<string, Set<string>>();
	const caseOperationWrites = new Map<string, Set<string>>();
	const caseOperationLinks = new Map<string, Set<string>>();
	const caseOperationOrders = new Map<
		string,
		{ readonly uuid: string; order: string | undefined }
	>();
	// Rank intent describes the batch's committed end state. Defer the check
	// until every same-batch add/remove/move has advanced the projection; an
	// autosave may carry several absolute order-key changes, and validating an
	// intermediate rank would reject its own later mutations as a fake peer
	// conflict. Only the final rank-bearing move for an identity survives.
	const caseOperationMoveExpectations = new Map<
		string,
		{ readonly formUuid: string; readonly uuid: string; readonly index: number }
	>();
	const caseOperationKey = (formUuid: string, operationUuid: string) =>
		`${formUuid}\0${operationUuid}`;
	const seedCaseOperation = (
		formUuid: string,
		operation: NonNullable<
			BlueprintDoc["forms"][string]["caseOperations"]
		>[number],
	): void => {
		const operationUuids = caseOperationsByForm.get(formUuid) ?? new Set();
		operationUuids.add(operation.uuid);
		caseOperationsByForm.set(formUuid, operationUuids);
		const key = caseOperationKey(formUuid, operation.uuid);
		caseOperationWrites.set(
			key,
			new Set((operation.writes ?? []).map((write) => write.property)),
		);
		caseOperationLinks.set(
			key,
			new Set((operation.links ?? []).map((link) => link.identifier)),
		);
		caseOperationMoveExpectations.delete(key);
		caseOperationOrders.set(key, {
			uuid: operation.uuid,
			order: operation.order,
		});
	};
	const removeSeededCaseOperation = (
		formUuid: string,
		operationUuid: string,
	): void => {
		caseOperationsByForm.get(formUuid)?.delete(operationUuid);
		const key = caseOperationKey(formUuid, operationUuid);
		caseOperationWrites.delete(key);
		caseOperationLinks.delete(key);
		caseOperationOrders.delete(key);
		caseOperationMoveExpectations.delete(key);
	};
	const movedCaseOperationRank = (
		formUuid: string,
		operationUuid: string,
		order: string | undefined,
	): number => {
		const entries = [...(caseOperationsByForm.get(formUuid) ?? [])]
			.map((uuid) => {
				const existing = caseOperationOrders.get(
					caseOperationKey(formUuid, uuid),
				);
				return {
					uuid,
					order: uuid === operationUuid ? order : existing?.order,
				};
			})
			.sort((left, right) => {
				if (left.order !== undefined && right.order !== undefined) {
					if (left.order < right.order) return -1;
					if (left.order > right.order) return 1;
					return left.uuid.localeCompare(right.uuid);
				}
				if (left.order !== undefined) return -1;
				if (right.order !== undefined) return 1;
				return left.uuid.localeCompare(right.uuid);
			});
		return entries.findIndex((entry) => entry.uuid === operationUuid);
	};
	for (const form of Object.values(doc.forms)) {
		caseOperationsByForm.set(form.uuid, new Set());
		for (const operation of form.caseOperations ?? []) {
			seedCaseOperation(form.uuid, operation);
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
				// A historical/direct whole-config birth or the live diff's explicit
				// clear: non-null births it, `null` clears it. Track both so the
				// guard remains compatible with replayed events and same-batch edits.
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
				caseOperationsByForm.set(m.form.uuid, new Set());
				for (const operation of m.form.caseOperations ?? []) {
					seedCaseOperation(m.form.uuid, operation);
				}
				break;
			case "removeForm":
				if (!forms.has(m.uuid)) return true;
				forms.delete(m.uuid);
				for (const operationUuid of caseOperationsByForm.get(m.uuid) ?? []) {
					removeSeededCaseOperation(m.uuid, operationUuid);
				}
				caseOperationsByForm.delete(m.uuid);
				break;
			case "moveForm":
				if (!forms.has(m.uuid) || !modules.has(m.toModuleUuid)) return true;
				break;
			case "renameForm":
			case "setFormMedia":
				if (!forms.has(m.uuid)) return true;
				break;
			case "updateForm": {
				if (!forms.has(m.uuid)) return true;
				const operationUuids =
					caseOperationsByForm.get(m.uuid) ?? new Set<string>();
				caseOperationsByForm.set(m.uuid, operationUuids);
				const semantic = m.caseOperationPatch;
				if (semantic !== undefined) {
					if (!operationUuids.has(semantic.uuid)) return true;
					const key = caseOperationKey(m.uuid, semantic.uuid);
					const writes = caseOperationWrites.get(key) ?? new Set<string>();
					const links = caseOperationLinks.get(key) ?? new Set<string>();
					caseOperationWrites.set(key, writes);
					caseOperationLinks.set(key, links);
					switch (semantic.operation) {
						case "update":
							break;
						case "add-write":
							if (writes.has(semantic.value.property)) return true;
							writes.add(semantic.value.property);
							break;
						case "update-write":
							if (!writes.has(semantic.property)) return true;
							break;
						case "remove-write":
							if (!writes.has(semantic.property)) return true;
							writes.delete(semantic.property);
							break;
						case "add-link":
							if (links.has(semantic.value.identifier)) return true;
							links.add(semantic.value.identifier);
							break;
						case "update-link":
							if (!links.has(semantic.identifier)) return true;
							break;
						case "remove-link":
							if (!links.has(semantic.identifier)) return true;
							links.delete(semantic.identifier);
							break;
						case "move":
							if (semantic.index !== undefined) {
								if (semantic.order === null) return true;
								caseOperationMoveExpectations.set(key, {
									formUuid: m.uuid,
									uuid: semantic.uuid,
									index: semantic.index,
								});
							} else {
								caseOperationMoveExpectations.delete(key);
							}
							caseOperationOrders.set(key, {
								uuid: semantic.uuid,
								order: semantic.order ?? undefined,
							});
							break;
					}
					break;
				}

				// An event authored by the immediate-parent grammar has no granular
				// extension. Simulate its exact full-operation reducer semantics so a
				// later mutation in the same batch sees births, removals, and replaced
				// write/link collections.
				const change = m.caseOperationChange;
				if (change === undefined) break;
				switch (change.operation) {
					case "add":
						if (operationUuids.has(change.value.uuid)) return true;
						seedCaseOperation(m.uuid, change.value);
						break;
					case "update":
						if (!operationUuids.has(change.uuid)) return true;
						seedCaseOperation(m.uuid, change.value);
						break;
					case "remove":
						if (!operationUuids.has(change.uuid)) return true;
						removeSeededCaseOperation(m.uuid, change.uuid);
						break;
					case "move":
						if (!operationUuids.has(change.uuid)) return true;
						caseOperationMoveExpectations.delete(
							caseOperationKey(m.uuid, change.uuid),
						);
						caseOperationOrders.set(caseOperationKey(m.uuid, change.uuid), {
							uuid: change.uuid,
							order: change.order,
						});
						break;
				}
				break;
			}
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
			// ── User properties, user types, personas ──────────────────
			case "addUserProperty":
				userProperties.add(m.property.uuid);
				break;
			case "removeUserProperty":
				if (!userProperties.has(m.uuid)) return true;
				userProperties.delete(m.uuid);
				break;
			case "updateUserProperty":
				if (!userProperties.has(m.uuid)) return true;
				break;
			case "addUserType":
				userTypes.add(m.userType.uuid);
				break;
			case "removeUserType":
				if (!userTypes.has(m.uuid)) return true;
				userTypes.delete(m.uuid);
				break;
			case "updateUserType":
				if (!userTypes.has(m.uuid)) return true;
				break;
			case "addPersona":
				personas.add(m.persona.uuid);
				break;
			case "removePersona":
				if (!personas.has(m.uuid)) return true;
				personas.delete(m.uuid);
				break;
			case "updatePersona":
				if (!personas.has(m.uuid)) return true;
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
	for (const expectation of caseOperationMoveExpectations.values()) {
		const order = caseOperationOrders.get(
			caseOperationKey(expectation.formUuid, expectation.uuid),
		)?.order;
		if (
			movedCaseOperationRank(expectation.formUuid, expectation.uuid, order) !==
			expectation.index
		) {
			return true;
		}
	}
	return false;
}
