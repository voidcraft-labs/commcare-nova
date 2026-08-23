import { produce } from "immer";
import { deepEqual } from "@/lib/doc/deepEqual";
import { mutationIdentityAdmissionIssue } from "@/lib/doc/mutationIdentityAdmission";
import { mutationSequenceAdmissionIssue } from "@/lib/doc/mutationSequenceAdmission";
import { applyMutations } from "@/lib/doc/mutations";
import type { Mutation } from "@/lib/doc/types";
import {
	type BlueprintDoc,
	collectTranslationUnits,
	effectiveAppLocalization,
	fieldKindDeclaresKey,
	getConvertibleTypes,
	isContainer,
	languageTag,
	type TranslationEntry,
	translationValueIntegrityIssue,
} from "@/lib/domain";
import { assertNever } from "@/lib/utils/assertNever";

/**
 * Whether any mutation in `mutations` targets an entity that no longer exists
 * on `doc` (accounting for entities the batch itself adds/removes along the
 * way).
 *
 * This is document-aware admission, not reducer behavior. It runs before every
 * candidate reduction so a missing or wrong-scope target cannot become a
 * successful unchanged document. A batch that adds an entity then edits it is
 * valid because the simulated live set tracks same-batch births.
 *
 * The `switch` is exhaustive over the `Mutation` union — the `default` calls
 * `assertNever`, so a new kind added without a live-set rule fails the build
 * rather than silently returning `false` (the invisible-loss trap).
 */
export function mutationTargetsInvalid(
	doc: BlueprintDoc,
	mutations: readonly Mutation[],
): boolean {
	if (mutationIdentityAdmissionIssue(doc, mutations) !== undefined) return true;
	if (mutationSequenceAdmissionIssue(doc, mutations) !== undefined) return true;
	const modules = new Set(Object.keys(doc.modules));
	const moduleParents = new Map<string, string | null>();
	const moduleChildren = new Map<string, Set<string>>();
	for (const module of Object.values(doc.modules)) {
		const parent = module.parentModuleUuid ?? null;
		moduleParents.set(module.uuid, parent);
		moduleChildren.set(module.uuid, new Set());
	}
	for (const [uuid, parent] of moduleParents) {
		if (parent !== null) moduleChildren.get(parent)?.add(uuid);
	}
	const forms = new Set(Object.keys(doc.forms));
	const fields = new Set(Object.keys(doc.fields));
	const formOwners = new Map<string, string>();
	for (const [moduleUuid, order] of Object.entries(doc.formOrder)) {
		for (const formUuid of order) formOwners.set(formUuid, moduleUuid);
	}
	const fieldOwners = new Map<string, string>();
	const fieldChildren = new Map<string, Set<string>>();
	for (const [parentUuid, order] of Object.entries(doc.fieldOrder)) {
		fieldChildren.set(parentUuid, new Set(order));
		for (const fieldUuid of order) fieldOwners.set(fieldUuid, parentUuid);
	}
	const fieldKinds = new Map<string, BlueprintDoc["fields"][string]["kind"]>(
		Object.values(doc.fields).map((field) => [field.uuid, field.kind]),
	);
	const fieldIds = new Map<string, string>(
		Object.values(doc.fields).map((field) => [field.uuid, field.id]),
	);
	const containerFields = new Set<string>(
		Object.values(doc.fields)
			.filter((field) => isContainer(field))
			.map((field) => field.uuid),
	);
	const caseProperties = new Map(
		(doc.caseTypes ?? []).map((caseType) => [
			caseType.name,
			new Set(caseType.properties.map((property) => property.name)),
		]),
	);
	const organizationLevelParents = new Map<string, string | undefined>(
		Object.values(doc.organizationLevels ?? {}).map((level) => [
			level.uuid,
			level.parentLevelUuid,
		]),
	);
	// Sub-entity live sets at ITEM granularity, mirroring the entity sets: a
	// column / search-input / option the batch edits, moves, or removes must
	// still exist — a concurrent DELETE of the same item makes the reducer
	// silently no-op instead of surfacing the conflict, the exact invisible
	// data loss this guard closes. Option, column, and search-input uuids are
	// schema-required in the canonical fresh document.
	const columnOwners = new Map<string, string>();
	const searchInputOwners = new Map<string, string>();
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
		for (const col of config.columns) columnOwners.set(col.uuid, mod.uuid);
		for (const input of config.searchInputs) {
			searchInputOwners.set(input.uuid, mod.uuid);
		}
	}
	const optionOwners = new Map<string, string>();
	const inlineOptionFields = new Set<string>();
	for (const field of Object.values(doc.fields)) {
		if (!("optionsSource" in field) || field.optionsSource.kind !== "inline") {
			continue;
		}
		inlineOptionFields.add(field.uuid);
		for (const opt of field.optionsSource.options) {
			optionOwners.set(opt.uuid, field.uuid);
		}
	}
	// The three flat user collections, tracked at the same item granularity:
	// an update or remove against an entity a peer concurrently removed is a
	// conflict, because the reducer would silently no-op on it.
	const userProperties = new Set(Object.keys(doc.userProperties ?? {}));
	const userTypes = new Set(Object.keys(doc.userTypes ?? {}));
	const personas = new Set(Object.keys(doc.personas ?? {}));
	const organizationLevels = new Set(Object.keys(doc.organizationLevels ?? {}));
	const locationProperties = new Set(Object.keys(doc.locationProperties ?? {}));
	const automations = new Map<string, "case-update" | "conditional-alert">();
	const automationScheduleKinds = new Map<string, "immediate" | "timed">();
	const automationItemOwners = new Map<
		string,
		{ automationUuid: string; collection: string }
	>();
	const seedAutomation = (
		automation: NonNullable<BlueprintDoc["automations"]>[string],
	): void => {
		automations.set(automation.uuid, automation.kind);
		for (const criterion of automation.criteria) {
			automationItemOwners.set(criterion.uuid, {
				automationUuid: automation.uuid,
				collection: "criterion",
			});
		}
		for (const criterion of automation.setupOnlyCriteria) {
			automationItemOwners.set(criterion.uuid, {
				automationUuid: automation.uuid,
				collection: "setup-only-criterion",
			});
		}
		if (automation.kind === "case-update") {
			for (const update of automation.updates) {
				automationItemOwners.set(update.uuid, {
					automationUuid: automation.uuid,
					collection: "update",
				});
			}
			return;
		}
		automationScheduleKinds.set(automation.uuid, automation.schedule.kind);
		for (const recipient of automation.recipients) {
			automationItemOwners.set(recipient.uuid, {
				automationUuid: automation.uuid,
				collection: "recipient",
			});
		}
		for (const event of automation.schedule.events) {
			automationItemOwners.set(event.uuid, {
				automationUuid: automation.uuid,
				collection: `${automation.schedule.kind}-event`,
			});
		}
		for (const filter of automation.userDataFilters) {
			automationItemOwners.set(filter.uuid, {
				automationUuid: automation.uuid,
				collection: "user-data-filter",
			});
		}
	};
	for (const automation of Object.values(doc.automations ?? {})) {
		seedAutomation(automation);
	}
	const userTypeValues = new Map(
		Object.values(doc.userTypes ?? {}).map((userType) => [
			userType.uuid,
			new Set(Object.keys(userType.values ?? {})),
		]),
	);
	const personaValues = new Map(
		Object.values(doc.personas ?? {}).map((persona) => [
			persona.uuid,
			new Set(Object.keys(persona.values ?? {})),
		]),
	);
	const personaUserTypes = new Map(
		Object.values(doc.personas ?? {})
			.filter((persona) => persona.userTypeUuid !== undefined)
			.map((persona) => [persona.uuid, persona.userTypeUuid as string]),
	);
	// Case operations are form-owned; their writes and links have logical
	// identity inside one operation. Track all three levels so the authoritative
	// writer rejects the reducer's otherwise-silent no-op both for concurrent
	// deletes and for colliding same-key adds.
	const caseOperationsByForm = new Map<string, Set<string>>();
	const caseOperationWrites = new Map<string, Set<string>>();
	const caseOperationLinks = new Map<string, Set<string>>();
	/**
	 * Operations BORN in this batch. A same-key write/link add against one of
	 * them is the author's own sequence, never a peer's — nobody else has seen
	 * the operation, so there is nothing it can collide with.
	 *
	 * The batch is the author's command log, not a minimal diff: creating an
	 * operation that already carries a link and then configuring that link
	 * records both commands. The reducers are idempotent on the logical key (a
	 * second `add-link` / `add-write` for a key that already exists returns
	 * without touching the draft), so the batch replays to exactly the right
	 * document — and rejecting it as a conflict fails a save that has none.
	 */
	const caseOperationsBornInBatch = new Set<string>();
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
	};
	const removeSeededCaseOperation = (
		formUuid: string,
		operationUuid: string,
	): void => {
		caseOperationsByForm.get(formUuid)?.delete(operationUuid);
		const key = caseOperationKey(formUuid, operationUuid);
		caseOperationWrites.delete(key);
		caseOperationLinks.delete(key);
		caseOperationsBornInBatch.delete(key);
	};
	for (const form of Object.values(doc.forms)) {
		caseOperationsByForm.set(form.uuid, new Set());
		for (const operation of form.caseOperations ?? []) {
			seedCaseOperation(form.uuid, operation);
		}
	}
	// After-submit links are form-owned entities addressed by uuid. A link a
	// peer removed (or a duplicate uuid on add) is a conflict, not a silent
	// reducer no-op.
	const formLinkOwners = new Map<string, string>();
	for (const form of Object.values(doc.forms)) {
		for (const link of form.formLinks ?? []) {
			formLinkOwners.set(link.uuid, form.uuid);
		}
	}
	function removeFieldTree(fieldUuid: string): void {
		for (const childUuid of fieldChildren.get(fieldUuid) ?? []) {
			removeFieldTree(childUuid);
		}
		fieldChildren.get(fieldOwners.get(fieldUuid) ?? "")?.delete(fieldUuid);
		fieldChildren.delete(fieldUuid);
		fieldOwners.delete(fieldUuid);
		fields.delete(fieldUuid);
		fieldKinds.delete(fieldUuid);
		fieldIds.delete(fieldUuid);
		containerFields.delete(fieldUuid);
		inlineOptionFields.delete(fieldUuid);
		for (const [optionUuid, owner] of optionOwners) {
			if (owner === fieldUuid) optionOwners.delete(optionUuid);
		}
	}
	const removeFormTree = (formUuid: string): void => {
		for (const fieldUuid of fieldChildren.get(formUuid) ?? []) {
			removeFieldTree(fieldUuid);
		}
		fieldChildren.delete(formUuid);
		formOwners.delete(formUuid);
		forms.delete(formUuid);
		for (const operationUuid of caseOperationsByForm.get(formUuid) ?? []) {
			removeSeededCaseOperation(formUuid, operationUuid);
		}
		caseOperationsByForm.delete(formUuid);
		for (const [linkUuid, owner] of formLinkOwners) {
			if (owner === formUuid) formLinkOwners.delete(linkUuid);
		}
	};
	const removeModuleTree = (moduleUuid: string): void => {
		for (const [formUuid, owner] of formOwners) {
			if (owner === moduleUuid) removeFormTree(formUuid);
		}
		modules.delete(moduleUuid);
		moduleParents.delete(moduleUuid);
		moduleChildren.delete(moduleUuid);
		modulesWithConfig.delete(moduleUuid);
		for (const [columnUuid, owner] of columnOwners) {
			if (owner === moduleUuid) columnOwners.delete(columnUuid);
		}
		for (const [inputUuid, owner] of searchInputOwners) {
			if (owner === moduleUuid) searchInputOwners.delete(inputUuid);
		}
	};
	// A field's parent is a form or a group/repeat field — either may hold it.
	const container = (uuid: string) =>
		forms.has(uuid) || containerFields.has(uuid);
	const containingForm = (uuid: string): string | undefined => {
		let current: string | undefined = uuid;
		const seen = new Set<string>();
		while (current !== undefined && !seen.has(current)) {
			if (forms.has(current)) return current;
			seen.add(current);
			current = fieldOwners.get(current);
		}
		return undefined;
	};
	const initialLocalization = effectiveAppLocalization(doc.localization);
	let sourceLanguage = initialLocalization.sourceLanguage;
	let defaultLanguage = initialLocalization.defaultLanguage;
	const languages = new Set(initialLocalization.languageOrder);
	const translations = new Map<string, Map<string, TranslationEntry>>(
		Object.entries(initialLocalization.translations).map(
			([language, entries]) => [language, new Map(Object.entries(entries))],
		),
	);
	let translationUnits = new Map(
		collectTranslationUnits(doc).map((unit) => [unit.id, unit]),
	);
	const admittedPrefix: Mutation[] = [];
	let translationUnitsDirty = false;
	const refreshTranslationUnits = (): void => {
		if (!translationUnitsDirty) return;
		const projected = produce(doc, (draft) => {
			applyMutations(draft, admittedPrefix);
		});
		translationUnits = new Map(
			collectTranslationUnits(projected).map((unit) => [unit.id, unit]),
		);
		translationUnitsDirty = false;
	};
	for (const m of mutations) {
		switch (m.kind) {
			case "addModule":
				{
					const parent = m.module.parentModuleUuid ?? null;
					if (
						parent === m.module.uuid ||
						(parent !== null &&
							(!modules.has(parent) || moduleParents.get(parent) !== null))
					) {
						return true;
					}
					modules.add(m.module.uuid);
					moduleParents.set(m.module.uuid, parent);
					moduleChildren.set(m.module.uuid, new Set());
					if (parent !== null) moduleChildren.get(parent)?.add(m.module.uuid);
					// A module can be born WITH a case-list config (the scaffold's
					// case-list viewer) — seed config presence so a same-batch
					// `setCaseListMeta` on it resolves.
					if (m.module.caseListConfig !== undefined) {
						modulesWithConfig.add(m.module.uuid);
						for (const column of m.module.caseListConfig.columns) {
							columnOwners.set(column.uuid, m.module.uuid);
						}
						for (const input of m.module.caseListConfig.searchInputs) {
							searchInputOwners.set(input.uuid, m.module.uuid);
						}
					}
				}
				break;
			case "removeModule":
				if (!modules.has(m.uuid)) return true;
				if ((moduleChildren.get(m.uuid)?.size ?? 0) > 0) return true;
				{
					const parent = moduleParents.get(m.uuid);
					if (parent !== undefined && parent !== null) {
						moduleChildren.get(parent)?.delete(m.uuid);
					}
				}
				removeModuleTree(m.uuid);
				break;
			case "updateModule":
				if (!modules.has(m.uuid)) return true;
				// Canonical update payloads own only structural teardown here:
				// `caseListConfig:null` clears the config and all of its members.
				// Config birth is the distinct `ensureCaseListConfig` command below.
				if ("caseListConfig" in m.patch) {
					for (const [columnUuid, owner] of columnOwners) {
						if (owner === m.uuid) columnOwners.delete(columnUuid);
					}
					for (const [inputUuid, owner] of searchInputOwners) {
						if (owner === m.uuid) searchInputOwners.delete(inputUuid);
					}
					modulesWithConfig.delete(m.uuid);
				}
				if (m.ensureCaseListConfig === true) {
					modulesWithConfig.add(m.uuid);
				}
				break;
			case "moveModule": {
				if (!modules.has(m.uuid)) return true;
				const currentParent = moduleParents.get(m.uuid);
				if (currentParent === undefined) return true;
				const destinationParent = Object.hasOwn(m, "parentModuleUuid")
					? (m.parentModuleUuid ?? null)
					: currentParent;
				if (
					destinationParent === m.uuid ||
					(destinationParent !== null &&
						(!modules.has(destinationParent) ||
							moduleParents.get(destinationParent) !== null)) ||
					(destinationParent !== null &&
						(moduleChildren.get(m.uuid)?.size ?? 0) > 0)
				) {
					return true;
				}
				if (currentParent !== null) {
					moduleChildren.get(currentParent)?.delete(m.uuid);
				}
				if (destinationParent !== null) {
					moduleChildren.get(destinationParent)?.add(m.uuid);
				}
				moduleParents.set(m.uuid, destinationParent);
				break;
			}
			case "renameModule":
			case "setModuleMedia":
				if (!modules.has(m.uuid)) return true;
				break;
			case "addForm":
				if (!modules.has(m.moduleUuid)) return true;
				forms.add(m.form.uuid);
				formOwners.set(m.form.uuid, m.moduleUuid);
				fieldChildren.set(m.form.uuid, new Set());
				caseOperationsByForm.set(m.form.uuid, new Set());
				for (const operation of m.form.caseOperations ?? []) {
					seedCaseOperation(m.form.uuid, operation);
				}
				for (const link of m.form.formLinks ?? []) {
					formLinkOwners.set(link.uuid, m.form.uuid);
				}
				break;
			case "removeForm":
				if (!forms.has(m.uuid)) return true;
				removeFormTree(m.uuid);
				break;
			// ── After-submit links (form-owned) ────────────────────────
			case "addFormLink":
				if (!forms.has(m.formUuid)) return true;
				// A second add of the same uuid is a conflict, never a no-op: the
				// reducer would drop it silently.
				if (formLinkOwners.has(m.link.uuid)) return true;
				formLinkOwners.set(m.link.uuid, m.formUuid);
				break;
			case "updateFormLink":
				if (formLinkOwners.get(m.uuid) !== m.formUuid) return true;
				break;
			case "moveFormLink":
				if (formLinkOwners.get(m.uuid) !== m.formUuid) return true;
				if (m.after === m.uuid) return true;
				break;
			case "removeFormLink":
				if (formLinkOwners.get(m.uuid) !== m.formUuid) return true;
				formLinkOwners.delete(m.uuid);
				break;
			case "moveForm":
				if (!forms.has(m.uuid) || !modules.has(m.toModuleUuid)) return true;
				formOwners.set(m.uuid, m.toModuleUuid);
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
					const born = caseOperationsBornInBatch.has(key);
					switch (semantic.operation) {
						case "update":
							break;
						case "add-write":
							if (writes.has(semantic.value.property) && !born) return true;
							if (
								semantic.after !== undefined &&
								semantic.after !== null &&
								!writes.has(semantic.after)
							) {
								return true;
							}
							writes.add(semantic.value.property);
							break;
						case "update-write":
							if (!writes.has(semantic.property)) return true;
							break;
						case "remove-write":
							if (!writes.has(semantic.property)) return true;
							writes.delete(semantic.property);
							break;
						case "move-write":
							if (
								!writes.has(semantic.property) ||
								(semantic.after !== null &&
									(semantic.after === semantic.property ||
										!writes.has(semantic.after)))
							) {
								return true;
							}
							break;
						case "add-link":
							if (links.has(semantic.value.identifier) && !born) return true;
							if (
								semantic.after !== undefined &&
								semantic.after !== null &&
								!links.has(semantic.after)
							) {
								return true;
							}
							links.add(semantic.value.identifier);
							break;
						case "update-link":
							if (!links.has(semantic.identifier)) return true;
							break;
						case "remove-link":
							if (!links.has(semantic.identifier)) return true;
							links.delete(semantic.identifier);
							break;
						case "move-link":
							if (
								!links.has(semantic.identifier) ||
								(semantic.after !== null &&
									(semantic.after === semantic.identifier ||
										!links.has(semantic.after)))
							) {
								return true;
							}
							break;
						case "move":
							if (
								semantic.after !== null &&
								(semantic.after === semantic.uuid ||
									!operationUuids.has(semantic.after))
							) {
								return true;
							}
							break;
					}
					break;
				}

				// Adds and removals are the only whole-operation events. Simulate
				// their membership effect for later edits in this same batch.
				const change = m.caseOperationChange;
				if (change === undefined) break;
				switch (change.operation) {
					case "add":
						if (operationUuids.has(change.value.uuid)) return true;
						seedCaseOperation(m.uuid, change.value);
						caseOperationsBornInBatch.add(
							caseOperationKey(m.uuid, change.value.uuid),
						);
						break;
					case "remove":
						if (!operationUuids.has(change.uuid)) return true;
						removeSeededCaseOperation(m.uuid, change.uuid);
						break;
				}
				break;
			}
			case "addField":
				if (!container(m.parentUuid)) return true;
				fields.add(m.field.uuid);
				fieldKinds.set(m.field.uuid, m.field.kind);
				fieldIds.set(m.field.uuid, m.field.id);
				fieldOwners.set(m.field.uuid, m.parentUuid);
				fieldChildren.get(m.parentUuid)?.add(m.field.uuid);
				if (isContainer(m.field)) {
					containerFields.add(m.field.uuid);
					fieldChildren.set(m.field.uuid, new Set());
				}
				if (
					"optionsSource" in m.field &&
					m.field.optionsSource.kind === "inline"
				) {
					inlineOptionFields.add(m.field.uuid);
					for (const option of m.field.optionsSource.options) {
						optionOwners.set(option.uuid, m.field.uuid);
					}
				}
				break;
			case "removeField":
				if (!fields.has(m.uuid)) return true;
				removeFieldTree(m.uuid);
				break;
			case "moveField":
				if (!fields.has(m.uuid) || !container(m.toParentUuid)) return true;
				if (
					m.uuid === m.toParentUuid ||
					containingForm(m.uuid) !== containingForm(m.toParentUuid)
				) {
					return true;
				}
				for (
					let ancestor: string | undefined = m.toParentUuid;
					ancestor !== undefined;
					ancestor = fieldOwners.get(ancestor)
				) {
					if (ancestor === m.uuid) return true;
				}
				{
					const movingId = fieldIds.get(m.uuid);
					if (
						movingId === undefined ||
						[...(fieldChildren.get(m.toParentUuid) ?? [])].some(
							(siblingUuid) =>
								siblingUuid !== m.uuid &&
								fieldIds.get(siblingUuid) === movingId,
						)
					) {
						return true;
					}
				}
				fieldChildren.get(fieldOwners.get(m.uuid) ?? "")?.delete(m.uuid);
				fieldOwners.set(m.uuid, m.toParentUuid);
				fieldChildren.get(m.toParentUuid)?.add(m.uuid);
				break;
			case "updateField":
				if (!fields.has(m.uuid)) return true;
				if (fieldKinds.get(m.uuid) !== m.targetKind) return true;
				if (Object.hasOwn(m.patch, "id")) {
					if (typeof m.patch.id !== "string") return true;
					fieldIds.set(m.uuid, m.patch.id);
				}
				break;
			case "convertField": {
				if (!fields.has(m.uuid)) return true;
				const currentKind = fieldKinds.get(m.uuid);
				if (currentKind === undefined) return true;
				if (
					currentKind !== m.toKind &&
					!getConvertibleTypes(currentKind).includes(m.toKind)
				) {
					return true;
				}
				fieldKinds.set(m.uuid, m.toKind);
				if (!fieldKindDeclaresKey(m.toKind, "optionsSource")) {
					inlineOptionFields.delete(m.uuid);
					for (const [optionUuid, owner] of optionOwners) {
						if (owner === m.uuid) optionOwners.delete(optionUuid);
					}
				} else if (m.optionsSource?.kind === "inline") {
					inlineOptionFields.add(m.uuid);
					for (const [optionUuid, owner] of optionOwners) {
						if (owner === m.uuid) optionOwners.delete(optionUuid);
					}
					for (const option of m.optionsSource.options) {
						optionOwners.set(option.uuid, m.uuid);
					}
				}
				break;
			}
			case "setFieldMedia": {
				if (!fields.has(m.fieldUuid)) return true;
				const currentKind = fieldKinds.get(m.fieldUuid);
				if (
					currentKind === undefined ||
					!fieldKindDeclaresKey(currentKind, `${m.slot}_media`)
				) {
					return true;
				}
				break;
			}
			// ── Granular case-type catalog ─────────────────────────────
			case "declareCaseType":
				if (caseProperties.has(m.caseType)) return true;
				caseProperties.set(m.caseType, new Set());
				break;
			case "retireCaseType":
				if (!caseProperties.has(m.caseType)) return true;
				caseProperties.delete(m.caseType);
				break;
			case "addCaseProperty":
				if (!caseProperties.has(m.caseType)) return true;
				if (caseProperties.get(m.caseType)?.has(m.property.name)) return true;
				caseProperties.get(m.caseType)?.add(m.property.name);
				break;
			case "setCaseProperty":
				if (!caseProperties.has(m.caseType)) return true;
				caseProperties.get(m.caseType)?.add(m.property.name);
				break;
			case "removeCaseProperty":
				if (!caseProperties.get(m.caseType)?.has(m.property)) return true;
				caseProperties.get(m.caseType)?.delete(m.property);
				break;
			case "setCaseTypeMeta":
				// A catalog edit against a type a concurrent writer retired (and
				// not re-declared earlier in this batch) is a conflict, not a
				// silent no-op.
				if (!caseProperties.has(m.caseType)) return true;
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
				columnOwners.set(m.column.uuid, m.moduleUuid);
				break;
			case "removeColumn":
				if (columnOwners.get(m.uuid) !== m.moduleUuid) return true;
				columnOwners.delete(m.uuid);
				break;
			case "updateColumn":
			case "moveColumn":
				if (columnOwners.get(m.uuid) !== m.moduleUuid) return true;
				break;
			case "addSearchInput":
				if (!modules.has(m.moduleUuid)) return true;
				// The first search input births a config-less module's config;
				// seed presence so a same-batch `setCaseListMeta` resolves.
				modulesWithConfig.add(m.moduleUuid);
				searchInputOwners.set(m.searchInput.uuid, m.moduleUuid);
				break;
			case "removeSearchInput":
				if (searchInputOwners.get(m.uuid) !== m.moduleUuid) return true;
				searchInputOwners.delete(m.uuid);
				break;
			case "updateSearchInput":
			case "moveSearchInput":
				if (searchInputOwners.get(m.uuid) !== m.moduleUuid) return true;
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
				if (!inlineOptionFields.has(m.fieldUuid)) return true;
				if (m.option.uuid !== undefined) {
					optionOwners.set(m.option.uuid, m.fieldUuid);
				}
				break;
			case "removeOption":
				if (optionOwners.get(m.uuid) !== m.fieldUuid) return true;
				optionOwners.delete(m.uuid);
				break;
			case "updateOption":
			case "moveOption":
				if (optionOwners.get(m.uuid) !== m.fieldUuid) return true;
				break;
			// ── User properties, user types, personas ──────────────────
			case "addUserProperty":
				userProperties.add(m.property.uuid);
				break;
			case "removeUserProperty":
				if (!userProperties.has(m.uuid)) return true;
				if (
					[...userTypeValues.values(), ...personaValues.values()].some(
						(values) => values.has(m.uuid),
					)
				) {
					return true;
				}
				userProperties.delete(m.uuid);
				break;
			case "updateUserProperty":
				if (!userProperties.has(m.uuid)) return true;
				break;
			case "addUserType":
				if (
					Object.keys(m.userType.values ?? {}).some(
						(propertyUuid) => !userProperties.has(propertyUuid),
					)
				) {
					return true;
				}
				userTypes.add(m.userType.uuid);
				userTypeValues.set(
					m.userType.uuid,
					new Set(Object.keys(m.userType.values ?? {})),
				);
				break;
			case "removeUserType":
				if (!userTypes.has(m.uuid)) return true;
				if ([...personaUserTypes.values()].includes(m.uuid)) return true;
				userTypes.delete(m.uuid);
				userTypeValues.delete(m.uuid);
				break;
			case "updateUserType": {
				if (!userTypes.has(m.uuid)) return true;
				if (m.valuePatch !== undefined) {
					if (!userProperties.has(m.valuePatch.userPropertyUuid)) return true;
					const values = userTypeValues.get(m.uuid) ?? new Set<string>();
					if (m.valuePatch.value === null) {
						values.delete(m.valuePatch.userPropertyUuid);
					} else {
						values.add(m.valuePatch.userPropertyUuid);
					}
					userTypeValues.set(m.uuid, values);
				}
				break;
			}
			case "addPersona":
				if (
					m.persona.userTypeUuid !== undefined &&
					!userTypes.has(m.persona.userTypeUuid)
				) {
					return true;
				}
				if (
					Object.keys(m.persona.values ?? {}).some(
						(propertyUuid) => !userProperties.has(propertyUuid),
					)
				) {
					return true;
				}
				personas.add(m.persona.uuid);
				personaValues.set(
					m.persona.uuid,
					new Set(Object.keys(m.persona.values ?? {})),
				);
				if (m.persona.userTypeUuid !== undefined) {
					personaUserTypes.set(m.persona.uuid, m.persona.userTypeUuid);
				}
				break;
			case "removePersona":
				if (!personas.has(m.uuid)) return true;
				personas.delete(m.uuid);
				personaValues.delete(m.uuid);
				personaUserTypes.delete(m.uuid);
				break;
			case "updatePersona": {
				if (!personas.has(m.uuid)) return true;
				if ("userTypeUuid" in m.patch) {
					const nextUserType = m.patch.userTypeUuid;
					if (nextUserType === undefined) return true;
					if (nextUserType !== null && !userTypes.has(nextUserType)) {
						return true;
					}
					if (nextUserType === null) {
						personaUserTypes.delete(m.uuid);
					} else {
						personaUserTypes.set(m.uuid, nextUserType);
					}
				}
				if (m.valuePatch !== undefined) {
					if (!userProperties.has(m.valuePatch.userPropertyUuid)) return true;
					const values = personaValues.get(m.uuid) ?? new Set<string>();
					if (m.valuePatch.value === null) {
						values.delete(m.valuePatch.userPropertyUuid);
					} else {
						values.add(m.valuePatch.userPropertyUuid);
					}
					personaValues.set(m.uuid, values);
				}
				break;
			}
			case "addOrganizationLevel":
				if (
					m.level.parentLevelUuid !== undefined &&
					(!organizationLevels.has(m.level.parentLevelUuid) ||
						m.level.parentLevelUuid === m.level.uuid)
				) {
					return true;
				}
				organizationLevels.add(m.level.uuid);
				organizationLevelParents.set(m.level.uuid, m.level.parentLevelUuid);
				break;
			case "removeOrganizationLevel":
				if (!organizationLevels.has(m.uuid)) return true;
				organizationLevels.delete(m.uuid);
				organizationLevelParents.delete(m.uuid);
				break;
			case "updateOrganizationLevel": {
				if (!organizationLevels.has(m.uuid)) return true;
				if (Object.hasOwn(m.patch, "parentLevelUuid")) {
					const parent = m.patch.parentLevelUuid;
					if (
						parent !== null &&
						parent !== undefined &&
						(!organizationLevels.has(parent) || parent === m.uuid)
					) {
						return true;
					}
					organizationLevelParents.set(
						m.uuid,
						parent === null ? undefined : parent,
					);
				}
				break;
			}
			case "addLocationProperty":
				locationProperties.add(m.property.uuid);
				break;
			case "removeLocationProperty":
				if (!locationProperties.has(m.uuid)) return true;
				locationProperties.delete(m.uuid);
				break;
			case "updateLocationProperty":
				if (!locationProperties.has(m.uuid)) return true;
				break;
			case "addAutomation":
				seedAutomation(m.automation);
				break;
			case "removeAutomation":
				if (automations.get(m.uuid) !== m.targetKind) return true;
				automations.delete(m.uuid);
				automationScheduleKinds.delete(m.uuid);
				for (const [uuid, owner] of automationItemOwners) {
					if (owner.automationUuid === m.uuid)
						automationItemOwners.delete(uuid);
				}
				break;
			case "updateAutomation":
				if (automations.get(m.uuid) !== m.targetKind) return true;
				break;
			case "moveAutomation":
				if (automations.get(m.uuid) !== m.targetKind) return true;
				break;
			case "setAutomationSchedule":
				if (automations.get(m.uuid) !== "conditional-alert") return true;
				for (const [uuid, owner] of automationItemOwners) {
					if (
						owner.automationUuid === m.uuid &&
						(owner.collection === "immediate-event" ||
							owner.collection === "timed-event")
					) {
						automationItemOwners.delete(uuid);
					}
				}
				automationScheduleKinds.set(m.uuid, m.schedule.kind);
				for (const event of m.schedule.events) {
					automationItemOwners.set(event.uuid, {
						automationUuid: m.uuid,
						collection: `${m.schedule.kind}-event`,
					});
				}
				break;
			case "updateAutomationSchedule":
				if (
					automations.get(m.uuid) !== "conditional-alert" ||
					automationScheduleKinds.get(m.uuid) !== "timed"
				) {
					return true;
				}
				break;
			case "editAutomationItem": {
				const edit = m.edit;
				const kind = automations.get(m.automationUuid);
				if (kind === undefined || kind !== m.targetKind) return true;
				if (
					(edit.collection === "update" && kind !== "case-update") ||
					((edit.collection === "recipient" ||
						edit.collection === "user-data-filter" ||
						edit.collection === "immediate-event" ||
						edit.collection === "timed-event") &&
						kind !== "conditional-alert") ||
					(edit.collection === "immediate-event" &&
						automationScheduleKinds.get(m.automationUuid) !== "immediate") ||
					(edit.collection === "timed-event" &&
						automationScheduleKinds.get(m.automationUuid) !== "timed")
				) {
					return true;
				}
				if (edit.operation === "add") {
					automationItemOwners.set(edit.value.uuid, {
						automationUuid: m.automationUuid,
						collection: edit.collection,
					});
					break;
				}
				const itemUuid =
					edit.operation === "update" ? edit.value.uuid : edit.uuid;
				const owner = automationItemOwners.get(itemUuid);
				if (
					owner?.automationUuid !== m.automationUuid ||
					owner.collection !== edit.collection
				) {
					return true;
				}
				if (edit.operation === "remove") {
					automationItemOwners.delete(itemUuid);
				}
				break;
			}
			// ── App-level scalars — no entity target, always safe ──────
			case "setAppName":
			case "setConnectType":
			case "setAppLogo":
				break;
			case "relabelSourceLanguage": {
				if (languages.size !== 1) return true;
				const tag = languageTag(m.language);
				languages.clear();
				languages.add(tag);
				translations.clear();
				sourceLanguage = tag;
				defaultLanguage = tag;
				break;
			}
			case "addLanguage": {
				const tag = languageTag(m.language);
				if (languages.has(tag)) return true;
				languages.add(tag);
				translations.set(tag, new Map());
				break;
			}
			case "removeLanguage":
				if (
					!languages.has(m.code) ||
					m.code === sourceLanguage ||
					m.code === defaultLanguage
				) {
					return true;
				}
				languages.delete(m.code);
				translations.delete(m.code);
				break;
			case "setDefaultLanguage":
				if (!languages.has(m.code)) return true;
				defaultLanguage = m.code;
				break;
			case "setTranslation": {
				refreshTranslationUnits();
				const unit = translationUnits.get(m.unitId);
				if (
					m.language === sourceLanguage ||
					unit === undefined ||
					(m.entry !== null &&
						(m.entry.sourceFingerprint !== unit.sourceFingerprint ||
							translationValueIntegrityIssue(unit, m.entry.value) !==
								undefined))
				) {
					return true;
				}
				const target = translations.get(m.language);
				if (target === undefined) return true;
				if (m.entry === null) {
					if (!target.has(m.unitId)) return true;
					target.delete(m.unitId);
				} else {
					target.set(m.unitId, m.entry);
				}
				break;
			}
			case "reviewTranslation": {
				refreshTranslationUnits();
				const unit = translationUnits.get(m.unitId);
				if (
					unit === undefined ||
					m.sourceFingerprint !== unit.sourceFingerprint ||
					translationValueIntegrityIssue(unit, m.value) !== undefined
				) {
					return true;
				}
				const target = translations.get(m.language);
				const entry = target?.get(m.unitId);
				if (
					target === undefined ||
					entry === undefined ||
					entry.sourceFingerprint !== m.expectedSourceFingerprint ||
					!deepEqual(entry.value, m.value)
				) {
					return true;
				}
				target.set(m.unitId, {
					...entry,
					sourceFingerprint: m.sourceFingerprint,
					review: "reviewed",
				});
				break;
			}
			case "renameCaseProperties":
				break;
			default:
				assertNever(m, "mutationTargetsInvalid");
		}
		admittedPrefix.push(m);
		if (
			m.kind !== "relabelSourceLanguage" &&
			m.kind !== "addLanguage" &&
			m.kind !== "removeLanguage" &&
			m.kind !== "setDefaultLanguage" &&
			m.kind !== "setTranslation" &&
			m.kind !== "reviewTranslation"
		) {
			translationUnitsDirty = true;
		}
	}
	return false;
}
