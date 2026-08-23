import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc } from "@/lib/domain";
import { isContainer } from "@/lib/domain";
import { assertNever } from "@/lib/utils/assertNever";

export type SequencePlacementMode =
	| "intentional-append"
	| "optional-neighbor"
	| "required-neighbor";

/**
 * Closed inventory of every final mutation arm that inserts or moves a
 * Blueprint sequence member. Tests derive every `after*` schema path and keep
 * it in parity with this registry; append-only operation birth is named here
 * too, so it cannot hide as an unclassified array push.
 */
export const MUTATION_SEQUENCE_INVENTORY = [
	{ path: "addModule.after", mode: "optional-neighbor" },
	{ path: "moveModule.after", mode: "required-neighbor" },
	{ path: "addForm.after", mode: "optional-neighbor" },
	{ path: "moveForm.after", mode: "required-neighbor" },
	{ path: "addField.after", mode: "optional-neighbor" },
	{ path: "moveField.after", mode: "required-neighbor" },
	{ path: "addCaseProperty.after", mode: "optional-neighbor" },
	{ path: "addUserProperty.after", mode: "optional-neighbor" },
	{ path: "addUserType.after", mode: "optional-neighbor" },
	{ path: "addPersona.after", mode: "optional-neighbor" },
	{ path: "addOrganizationLevel.after", mode: "optional-neighbor" },
	{ path: "addLocationProperty.after", mode: "optional-neighbor" },
	{ path: "addAutomation.after", mode: "optional-neighbor" },
	{ path: "moveAutomation.after", mode: "required-neighbor" },
	{
		path: "editAutomationItem.edit.add.after",
		mode: "optional-neighbor",
	},
	{
		path: "editAutomationItem.edit.move.after",
		mode: "required-neighbor",
	},
	{ path: "addColumn.afterInList", mode: "required-neighbor" },
	{ path: "addColumn.afterInDetail", mode: "required-neighbor" },
	{ path: "moveColumn.after", mode: "required-neighbor" },
	{ path: "addSearchInput.after", mode: "optional-neighbor" },
	{ path: "moveSearchInput.after", mode: "required-neighbor" },
	{ path: "addFormLink.after", mode: "optional-neighbor" },
	{ path: "moveFormLink.after", mode: "required-neighbor" },
	{ path: "addOption.after", mode: "optional-neighbor" },
	{ path: "moveOption.after", mode: "required-neighbor" },
	{
		path: "updateForm.caseOperationChange.add",
		mode: "intentional-append",
	},
	{
		path: "updateForm.caseOperationPatch.add-write.after",
		mode: "optional-neighbor",
	},
	{
		path: "updateForm.caseOperationPatch.move-write.after",
		mode: "required-neighbor",
	},
	{
		path: "updateForm.caseOperationPatch.add-link.after",
		mode: "optional-neighbor",
	},
	{
		path: "updateForm.caseOperationPatch.move-link.after",
		mode: "required-neighbor",
	},
	{
		path: "updateForm.caseOperationPatch.move.after",
		mode: "required-neighbor",
	},
] as const satisfies readonly {
	readonly path: string;
	readonly mode: SequencePlacementMode;
}[];

export interface MutationSequenceAdmissionIssue {
	readonly mutationIndex: number;
	readonly mutationKind: Mutation["kind"];
	readonly collection: string;
	readonly anchor: string;
}

interface SequenceState {
	moduleOrder: string[];
	moduleParent: Map<string, string | null>;
	moduleSiblingOrder: Map<string, string[]>;
	formOrder: Map<string, string[]>;
	formOwner: Map<string, string>;
	fieldOrder: Map<string, string[]>;
	fieldOwner: Map<string, string>;
	userPropertyOrder: string[];
	userTypeOrder: string[];
	personaOrder: string[];
	organizationLevelOrder: string[];
	locationPropertyOrder: string[];
	automationOrder: string[];
	automationItemOrder: Map<string, string[]>;
	casePropertyOrder: Map<string, string[]>;
	columnListOrder: Map<string, string[]>;
	columnDetailOrder: Map<string, string[]>;
	columnOwner: Map<string, string>;
	searchInputOrder: Map<string, string[]>;
	searchInputOwner: Map<string, string>;
	optionOrder: Map<string, string[]>;
	operationOrder: Map<string, string[]>;
	operationWrites: Map<string, string[]>;
	operationLinks: Map<string, string[]>;
	/** After-submit links per form, in array (= sequence) order. */
	formLinkOrder: Map<string, string[]>;
}

const operationKey = (formUuid: string, operationUuid: string): string =>
	`${formUuid}\0${operationUuid}`;
const automationKey = (uuid: string, collection: string): string =>
	`${uuid}\0${collection}`;

function stateFromDoc(doc: BlueprintDoc): SequenceState {
	const moduleParent = new Map<string, string | null>();
	const moduleSiblingOrder = new Map<string, string[]>();
	const moduleGroupKey = (parent: string | null): string => parent ?? "";
	for (const uuid of doc.moduleOrder) {
		const parent = doc.modules[uuid]?.parentModuleUuid ?? null;
		moduleParent.set(uuid, parent);
		const key = moduleGroupKey(parent);
		const siblings = moduleSiblingOrder.get(key) ?? [];
		siblings.push(uuid);
		moduleSiblingOrder.set(key, siblings);
	}
	const formOrder = new Map<string, string[]>();
	const formOwner = new Map<string, string>();
	for (const [moduleUuid, order] of Object.entries(doc.formOrder)) {
		formOrder.set(moduleUuid, [...order]);
		for (const formUuid of order) formOwner.set(formUuid, moduleUuid);
	}

	const fieldOrder = new Map<string, string[]>();
	const fieldOwner = new Map<string, string>();
	for (const [parentUuid, order] of Object.entries(doc.fieldOrder)) {
		fieldOrder.set(parentUuid, [...order]);
		for (const fieldUuid of order) fieldOwner.set(fieldUuid, parentUuid);
	}

	const columnListOrder = new Map<string, string[]>();
	const columnDetailOrder = new Map<string, string[]>();
	const columnOwner = new Map<string, string>();
	const searchInputOrder = new Map<string, string[]>();
	const searchInputOwner = new Map<string, string>();
	for (const module of Object.values(doc.modules)) {
		const config = module.caseListConfig;
		if (config === undefined) continue;
		columnListOrder.set(module.uuid, [...config.listColumnOrder]);
		columnDetailOrder.set(module.uuid, [...config.detailColumnOrder]);
		for (const column of config.columns)
			columnOwner.set(column.uuid, module.uuid);
		searchInputOrder.set(
			module.uuid,
			config.searchInputs.map((input) => input.uuid),
		);
		for (const input of config.searchInputs) {
			searchInputOwner.set(input.uuid, module.uuid);
		}
	}

	const optionOrder = new Map<string, string[]>();
	for (const field of Object.values(doc.fields)) {
		if ("optionsSource" in field && field.optionsSource.kind === "inline") {
			optionOrder.set(
				field.uuid,
				field.optionsSource.options.map((option) => option.uuid),
			);
		}
	}

	const casePropertyOrder = new Map(
		(doc.caseTypes ?? []).map((caseType) => [
			caseType.name,
			caseType.properties.map((property) => property.name),
		]),
	);

	const operationOrder = new Map<string, string[]>();
	const operationWrites = new Map<string, string[]>();
	const operationLinks = new Map<string, string[]>();
	const formLinkOrder = new Map<string, string[]>();
	for (const form of Object.values(doc.forms)) {
		formLinkOrder.set(
			form.uuid,
			(form.formLinks ?? []).map((link) => link.uuid),
		);
		const operations = form.caseOperations ?? [];
		operationOrder.set(
			form.uuid,
			operations.map((operation) => operation.uuid),
		);
		for (const operation of operations) {
			const key = operationKey(form.uuid, operation.uuid);
			operationWrites.set(
				key,
				(operation.writes ?? []).map((write) => write.property),
			);
			operationLinks.set(
				key,
				(operation.links ?? []).map((link) => link.identifier),
			);
		}
	}
	const automationItemOrder = new Map<string, string[]>();
	for (const automation of Object.values(doc.automations ?? {})) {
		automationItemOrder.set(
			automationKey(automation.uuid, "criterion"),
			automation.criteria.map((criterion) => criterion.uuid),
		);
		automationItemOrder.set(
			automationKey(automation.uuid, "setup-only-criterion"),
			automation.setupOnlyCriteria.map((criterion) => criterion.uuid),
		);
		if (automation.kind === "case-update") {
			automationItemOrder.set(
				automationKey(automation.uuid, "update"),
				automation.updates.map((update) => update.uuid),
			);
		} else {
			automationItemOrder.set(
				automationKey(automation.uuid, "recipient"),
				automation.recipients.map((recipient) => recipient.uuid),
			);
			automationItemOrder.set(
				automationKey(automation.uuid, `${automation.schedule.kind}-event`),
				automation.schedule.events.map((event) => event.uuid),
			);
			automationItemOrder.set(
				automationKey(automation.uuid, "user-data-filter"),
				automation.userDataFilters.map((filter) => filter.uuid),
			);
		}
	}

	return {
		moduleOrder: [...doc.moduleOrder],
		moduleParent,
		moduleSiblingOrder,
		formOrder,
		formOwner,
		fieldOrder,
		fieldOwner,
		userPropertyOrder: [...(doc.userPropertyOrder ?? [])],
		userTypeOrder: [...(doc.userTypeOrder ?? [])],
		personaOrder: [...(doc.personaOrder ?? [])],
		organizationLevelOrder: [...(doc.organizationLevelOrder ?? [])],
		locationPropertyOrder: [...(doc.locationPropertyOrder ?? [])],
		automationOrder: [...(doc.automationOrder ?? [])],
		automationItemOrder,
		casePropertyOrder,
		columnListOrder,
		columnDetailOrder,
		columnOwner,
		searchInputOrder,
		searchInputOwner,
		optionOrder,
		operationOrder,
		operationWrites,
		operationLinks,
		formLinkOrder,
	};
}

const moduleGroupKey = (parent: string | null): string => parent ?? "";

function rebuildModuleOrder(state: SequenceState): void {
	state.moduleOrder = (
		state.moduleSiblingOrder.get(moduleGroupKey(null)) ?? []
	).flatMap((root) => [
		root,
		...(state.moduleSiblingOrder.get(moduleGroupKey(root)) ?? []),
	]);
}

function placeModule(
	state: SequenceState,
	member: string,
	destinationParent: string | null,
	after: string | null | undefined,
	requireExisting = false,
): boolean {
	const currentParent = state.moduleParent.get(member);
	if (requireExisting && currentParent === undefined) return false;
	const destinationKey = moduleGroupKey(destinationParent);
	const destination = [
		...(state.moduleSiblingOrder.get(destinationKey) ?? []),
	].filter((uuid) => uuid !== member);
	if (after === member) return false;
	let at: number;
	if (after === undefined) at = destination.length;
	else if (after === null) at = 0;
	else {
		const anchorIndex = destination.indexOf(after);
		if (anchorIndex < 0) return false;
		at = anchorIndex + 1;
	}
	if (currentParent !== undefined) {
		const currentKey = moduleGroupKey(currentParent);
		state.moduleSiblingOrder.set(
			currentKey,
			(state.moduleSiblingOrder.get(currentKey) ?? []).filter(
				(uuid) => uuid !== member,
			),
		);
	}
	destination.splice(at, 0, member);
	state.moduleSiblingOrder.set(destinationKey, destination);
	state.moduleParent.set(member, destinationParent);
	rebuildModuleOrder(state);
	return true;
}

function place(
	sequence: string[],
	member: string,
	after: string | null | undefined,
	requireExisting = false,
): boolean {
	if (requireExisting && !sequence.includes(member)) return false;
	const without = sequence.filter((entry) => entry !== member);
	if (after === undefined) {
		sequence.splice(0, sequence.length, ...without, member);
		return true;
	}
	if (after === null) {
		sequence.splice(0, sequence.length, member, ...without);
		return true;
	}
	const anchorIndex = without.indexOf(after);
	if (after === member || anchorIndex < 0) return false;
	sequence.splice(
		0,
		sequence.length,
		...without.slice(0, anchorIndex + 1),
		member,
		...without.slice(anchorIndex + 1),
	);
	return true;
}

function removeMember(sequence: string[] | undefined, member: string): void {
	if (sequence === undefined) return;
	const index = sequence.indexOf(member);
	if (index !== -1) sequence.splice(index, 1);
}

function seedOperation(
	state: SequenceState,
	formUuid: string,
	operation: NonNullable<
		BlueprintDoc["forms"][string]["caseOperations"]
	>[number],
): void {
	const key = operationKey(formUuid, operation.uuid);
	state.operationWrites.set(
		key,
		(operation.writes ?? []).map((write) => write.property),
	);
	state.operationLinks.set(
		key,
		(operation.links ?? []).map((link) => link.identifier),
	);
}

function removeFieldTree(state: SequenceState, fieldUuid: string): void {
	for (const child of [...(state.fieldOrder.get(fieldUuid) ?? [])]) {
		removeFieldTree(state, child);
	}
	removeMember(
		state.fieldOrder.get(state.fieldOwner.get(fieldUuid) ?? ""),
		fieldUuid,
	);
	state.fieldOwner.delete(fieldUuid);
	state.fieldOrder.delete(fieldUuid);
	state.optionOrder.delete(fieldUuid);
}

function removeFormTree(state: SequenceState, formUuid: string): void {
	for (const fieldUuid of [...(state.fieldOrder.get(formUuid) ?? [])]) {
		removeFieldTree(state, fieldUuid);
	}
	removeMember(
		state.formOrder.get(state.formOwner.get(formUuid) ?? ""),
		formUuid,
	);
	state.formOwner.delete(formUuid);
	state.fieldOrder.delete(formUuid);
	for (const operationUuid of state.operationOrder.get(formUuid) ?? []) {
		const key = operationKey(formUuid, operationUuid);
		state.operationWrites.delete(key);
		state.operationLinks.delete(key);
	}
	state.operationOrder.delete(formUuid);
	state.formLinkOrder.delete(formUuid);
}

function removeModuleTree(state: SequenceState, moduleUuid: string): void {
	if (
		(state.moduleSiblingOrder.get(moduleGroupKey(moduleUuid))?.length ?? 0) > 0
	) {
		return;
	}
	for (const formUuid of [...(state.formOrder.get(moduleUuid) ?? [])]) {
		removeFormTree(state, formUuid);
	}
	removeMember(state.moduleOrder, moduleUuid);
	const parent = state.moduleParent.get(moduleUuid);
	if (parent !== undefined) {
		const key = moduleGroupKey(parent);
		state.moduleSiblingOrder.set(
			key,
			(state.moduleSiblingOrder.get(key) ?? []).filter(
				(uuid) => uuid !== moduleUuid,
			),
		);
	}
	state.moduleParent.delete(moduleUuid);
	state.moduleSiblingOrder.delete(moduleGroupKey(moduleUuid));
	rebuildModuleOrder(state);
	state.formOrder.delete(moduleUuid);
	state.columnListOrder.delete(moduleUuid);
	state.columnDetailOrder.delete(moduleUuid);
	state.searchInputOrder.delete(moduleUuid);
	for (const [columnUuid, owner] of state.columnOwner) {
		if (owner === moduleUuid) state.columnOwner.delete(columnUuid);
	}
	for (const [inputUuid, owner] of state.searchInputOwner) {
		if (owner === moduleUuid) state.searchInputOwner.delete(inputUuid);
	}
}

function issue(
	mutation: Mutation,
	mutationIndex: number,
	collection: string,
	anchor: string | null | undefined,
): MutationSequenceAdmissionIssue {
	return {
		mutationIndex,
		mutationKind: mutation.kind,
		collection,
		anchor: anchor ?? "(first)",
	};
}

/**
 * Simulate every sequence membership over the complete batch and return the
 * first declared neighbor that is missing, self-referential, or belongs to a
 * different collection. Omitted optional anchors are intentional append.
 */
export function mutationSequenceAdmissionIssue(
	doc: BlueprintDoc,
	mutations: readonly Mutation[],
): MutationSequenceAdmissionIssue | undefined {
	const state = stateFromDoc(doc);
	for (const [mutationIndex, mutation] of mutations.entries()) {
		switch (mutation.kind) {
			case "addModule":
				if (
					!placeModule(
						state,
						mutation.module.uuid,
						mutation.module.parentModuleUuid ?? null,
						mutation.after,
					)
				) {
					return issue(mutation, mutationIndex, "modules", mutation.after);
				}
				state.formOrder.set(mutation.module.uuid, []);
				if (mutation.module.caseListConfig !== undefined) {
					const config = mutation.module.caseListConfig;
					state.columnListOrder.set(mutation.module.uuid, [
						...config.listColumnOrder,
					]);
					state.columnDetailOrder.set(mutation.module.uuid, [
						...config.detailColumnOrder,
					]);
					state.searchInputOrder.set(
						mutation.module.uuid,
						config.searchInputs.map((input) => input.uuid),
					);
					for (const column of config.columns) {
						state.columnOwner.set(column.uuid, mutation.module.uuid);
					}
					for (const input of config.searchInputs) {
						state.searchInputOwner.set(input.uuid, mutation.module.uuid);
					}
				}
				break;
			case "removeModule":
				removeModuleTree(state, mutation.uuid);
				break;
			case "moveModule":
				if (
					!placeModule(
						state,
						mutation.uuid,
						Object.hasOwn(mutation, "parentModuleUuid")
							? (mutation.parentModuleUuid ?? null)
							: (state.moduleParent.get(mutation.uuid) ?? null),
						mutation.after,
						true,
					)
				) {
					return issue(mutation, mutationIndex, "modules", mutation.after);
				}
				break;
			case "renameModule":
			case "setModuleMedia":
			case "setCaseListMeta":
				break;
			case "updateModule":
				if (mutation.patch.caseListConfig === null) {
					state.columnListOrder.delete(mutation.uuid);
					state.columnDetailOrder.delete(mutation.uuid);
					state.searchInputOrder.delete(mutation.uuid);
					for (const [columnUuid, owner] of state.columnOwner) {
						if (owner === mutation.uuid) state.columnOwner.delete(columnUuid);
					}
					for (const [inputUuid, owner] of state.searchInputOwner) {
						if (owner === mutation.uuid) {
							state.searchInputOwner.delete(inputUuid);
						}
					}
				}
				if (mutation.ensureCaseListConfig) {
					state.columnListOrder.set(
						mutation.uuid,
						state.columnListOrder.get(mutation.uuid) ?? [],
					);
					state.columnDetailOrder.set(
						mutation.uuid,
						state.columnDetailOrder.get(mutation.uuid) ?? [],
					);
					state.searchInputOrder.set(
						mutation.uuid,
						state.searchInputOrder.get(mutation.uuid) ?? [],
					);
				}
				break;
			case "addForm": {
				const order = state.formOrder.get(mutation.moduleUuid) ?? [];
				if (!place(order, mutation.form.uuid, mutation.after)) {
					return issue(
						mutation,
						mutationIndex,
						`module ${mutation.moduleUuid} forms`,
						mutation.after,
					);
				}
				state.formOrder.set(mutation.moduleUuid, order);
				state.formOwner.set(mutation.form.uuid, mutation.moduleUuid);
				state.fieldOrder.set(mutation.form.uuid, []);
				const operations = mutation.form.caseOperations ?? [];
				state.operationOrder.set(
					mutation.form.uuid,
					operations.map((operation) => operation.uuid),
				);
				for (const operation of operations) {
					seedOperation(state, mutation.form.uuid, operation);
				}
				state.formLinkOrder.set(
					mutation.form.uuid,
					(mutation.form.formLinks ?? []).map((link) => link.uuid),
				);
				break;
			}
			case "removeForm":
				removeFormTree(state, mutation.uuid);
				break;
			case "moveForm": {
				const currentOwner = state.formOwner.get(mutation.uuid);
				const target = state.formOrder.get(mutation.toModuleUuid) ?? [];
				if (!place(target, mutation.uuid, mutation.after)) {
					return issue(
						mutation,
						mutationIndex,
						`module ${mutation.toModuleUuid} forms`,
						mutation.after,
					);
				}
				if (
					currentOwner !== undefined &&
					currentOwner !== mutation.toModuleUuid
				) {
					removeMember(state.formOrder.get(currentOwner), mutation.uuid);
				}
				state.formOrder.set(mutation.toModuleUuid, target);
				state.formOwner.set(mutation.uuid, mutation.toModuleUuid);
				break;
			}
			case "renameForm":
			case "setFormMedia":
				break;
			case "updateForm": {
				const change = mutation.caseOperationChange;
				if (change !== undefined) {
					const order = state.operationOrder.get(mutation.uuid) ?? [];
					state.operationOrder.set(mutation.uuid, order);
					if (change.operation === "add") {
						order.push(change.value.uuid);
						seedOperation(state, mutation.uuid, change.value);
					} else {
						removeMember(order, change.uuid);
						const key = operationKey(mutation.uuid, change.uuid);
						state.operationWrites.delete(key);
						state.operationLinks.delete(key);
					}
				}
				const patch = mutation.caseOperationPatch;
				if (patch === undefined) break;
				const key = operationKey(mutation.uuid, patch.uuid);
				switch (patch.operation) {
					case "update":
						break;
					case "add-write": {
						const order = state.operationWrites.get(key) ?? [];
						if (!place(order, patch.value.property, patch.after)) {
							return issue(
								mutation,
								mutationIndex,
								`case operation ${patch.uuid} writes`,
								patch.after,
							);
						}
						state.operationWrites.set(key, order);
						break;
					}
					case "update-write":
						break;
					case "remove-write":
						removeMember(state.operationWrites.get(key), patch.property);
						break;
					case "move-write": {
						const order = state.operationWrites.get(key) ?? [];
						if (!place(order, patch.property, patch.after, true)) {
							return issue(
								mutation,
								mutationIndex,
								`case operation ${patch.uuid} writes`,
								patch.after,
							);
						}
						state.operationWrites.set(key, order);
						break;
					}
					case "add-link": {
						const order = state.operationLinks.get(key) ?? [];
						if (!place(order, patch.value.identifier, patch.after)) {
							return issue(
								mutation,
								mutationIndex,
								`case operation ${patch.uuid} links`,
								patch.after,
							);
						}
						state.operationLinks.set(key, order);
						break;
					}
					case "update-link":
						break;
					case "remove-link":
						removeMember(state.operationLinks.get(key), patch.identifier);
						break;
					case "move-link": {
						const order = state.operationLinks.get(key) ?? [];
						if (!place(order, patch.identifier, patch.after, true)) {
							return issue(
								mutation,
								mutationIndex,
								`case operation ${patch.uuid} links`,
								patch.after,
							);
						}
						state.operationLinks.set(key, order);
						break;
					}
					case "move": {
						const order = state.operationOrder.get(mutation.uuid) ?? [];
						if (!place(order, patch.uuid, patch.after, true)) {
							return issue(
								mutation,
								mutationIndex,
								`form ${mutation.uuid} case operations`,
								patch.after,
							);
						}
						state.operationOrder.set(mutation.uuid, order);
						break;
					}
				}
				break;
			}
			case "addField": {
				const order = state.fieldOrder.get(mutation.parentUuid) ?? [];
				if (!place(order, mutation.field.uuid, mutation.after)) {
					return issue(
						mutation,
						mutationIndex,
						`parent ${mutation.parentUuid} fields`,
						mutation.after,
					);
				}
				state.fieldOrder.set(mutation.parentUuid, order);
				state.fieldOwner.set(mutation.field.uuid, mutation.parentUuid);
				if (isContainer(mutation.field)) {
					state.fieldOrder.set(mutation.field.uuid, []);
				}
				if (
					"optionsSource" in mutation.field &&
					mutation.field.optionsSource.kind === "inline"
				) {
					state.optionOrder.set(
						mutation.field.uuid,
						mutation.field.optionsSource.options.map((option) => option.uuid),
					);
				}
				break;
			}
			case "removeField":
				removeFieldTree(state, mutation.uuid);
				break;
			case "moveField": {
				const currentOwner = state.fieldOwner.get(mutation.uuid);
				const target = state.fieldOrder.get(mutation.toParentUuid) ?? [];
				if (!place(target, mutation.uuid, mutation.after)) {
					return issue(
						mutation,
						mutationIndex,
						`parent ${mutation.toParentUuid} fields`,
						mutation.after,
					);
				}
				if (
					currentOwner !== undefined &&
					currentOwner !== mutation.toParentUuid
				) {
					removeMember(state.fieldOrder.get(currentOwner), mutation.uuid);
				}
				state.fieldOrder.set(mutation.toParentUuid, target);
				state.fieldOwner.set(mutation.uuid, mutation.toParentUuid);
				break;
			}
			case "updateField":
				if ("optionsSource" in mutation.patch) {
					const source = mutation.patch.optionsSource;
					if (source?.kind === "inline") {
						state.optionOrder.set(
							mutation.uuid,
							source.options.map((option) => option.uuid),
						);
					} else {
						state.optionOrder.delete(mutation.uuid);
					}
				}
				break;
			case "convertField":
				if (mutation.optionsSource?.kind === "inline") {
					state.optionOrder.set(
						mutation.uuid,
						mutation.optionsSource.options.map((option) => option.uuid),
					);
				} else if (mutation.optionsSource !== undefined) {
					state.optionOrder.delete(mutation.uuid);
				}
				break;
			case "setFieldMedia":
				break;
			case "addOption": {
				const order = state.optionOrder.get(mutation.fieldUuid) ?? [];
				if (!place(order, mutation.option.uuid, mutation.after)) {
					return issue(
						mutation,
						mutationIndex,
						`field ${mutation.fieldUuid} options`,
						mutation.after,
					);
				}
				state.optionOrder.set(mutation.fieldUuid, order);
				break;
			}
			case "removeOption":
				removeMember(state.optionOrder.get(mutation.fieldUuid), mutation.uuid);
				break;
			case "moveOption": {
				const order = state.optionOrder.get(mutation.fieldUuid) ?? [];
				if (!place(order, mutation.uuid, mutation.after, true)) {
					return issue(
						mutation,
						mutationIndex,
						`field ${mutation.fieldUuid} options`,
						mutation.after,
					);
				}
				state.optionOrder.set(mutation.fieldUuid, order);
				break;
			}
			case "updateOption":
				break;
			case "addColumn": {
				const list = state.columnListOrder.get(mutation.moduleUuid) ?? [];
				if (!place(list, mutation.column.uuid, mutation.afterInList)) {
					return issue(
						mutation,
						mutationIndex,
						`module ${mutation.moduleUuid} results columns`,
						mutation.afterInList,
					);
				}
				const detail = state.columnDetailOrder.get(mutation.moduleUuid) ?? [];
				if (!place(detail, mutation.column.uuid, mutation.afterInDetail)) {
					return issue(
						mutation,
						mutationIndex,
						`module ${mutation.moduleUuid} details columns`,
						mutation.afterInDetail,
					);
				}
				state.columnListOrder.set(mutation.moduleUuid, list);
				state.columnDetailOrder.set(mutation.moduleUuid, detail);
				state.columnOwner.set(mutation.column.uuid, mutation.moduleUuid);
				break;
			}
			case "removeColumn": {
				const owner = state.columnOwner.get(mutation.uuid);
				if (owner !== undefined) {
					removeMember(state.columnListOrder.get(owner), mutation.uuid);
					removeMember(state.columnDetailOrder.get(owner), mutation.uuid);
				}
				state.columnOwner.delete(mutation.uuid);
				break;
			}
			case "moveColumn": {
				const order =
					mutation.surface === "list"
						? (state.columnListOrder.get(mutation.moduleUuid) ?? [])
						: (state.columnDetailOrder.get(mutation.moduleUuid) ?? []);
				if (!place(order, mutation.uuid, mutation.after, true)) {
					return issue(
						mutation,
						mutationIndex,
						`module ${mutation.moduleUuid} ${mutation.surface} columns`,
						mutation.after,
					);
				}
				if (mutation.surface === "list") {
					state.columnListOrder.set(mutation.moduleUuid, order);
				} else {
					state.columnDetailOrder.set(mutation.moduleUuid, order);
				}
				break;
			}
			case "updateColumn":
				break;
			case "addSearchInput": {
				const order = state.searchInputOrder.get(mutation.moduleUuid) ?? [];
				if (!place(order, mutation.searchInput.uuid, mutation.after)) {
					return issue(
						mutation,
						mutationIndex,
						`module ${mutation.moduleUuid} Search inputs`,
						mutation.after,
					);
				}
				state.searchInputOrder.set(mutation.moduleUuid, order);
				state.searchInputOwner.set(
					mutation.searchInput.uuid,
					mutation.moduleUuid,
				);
				break;
			}
			case "removeSearchInput":
				removeMember(
					state.searchInputOrder.get(mutation.moduleUuid),
					mutation.uuid,
				);
				state.searchInputOwner.delete(mutation.uuid);
				break;
			case "moveSearchInput": {
				const order = state.searchInputOrder.get(mutation.moduleUuid) ?? [];
				if (!place(order, mutation.uuid, mutation.after, true)) {
					return issue(
						mutation,
						mutationIndex,
						`module ${mutation.moduleUuid} Search inputs`,
						mutation.after,
					);
				}
				state.searchInputOrder.set(mutation.moduleUuid, order);
				break;
			}
			case "updateSearchInput":
				break;
			case "addFormLink": {
				const order = state.formLinkOrder.get(mutation.formUuid) ?? [];
				if (!place(order, mutation.link.uuid, mutation.after)) {
					return issue(
						mutation,
						mutationIndex,
						`form ${mutation.formUuid} links`,
						mutation.after,
					);
				}
				state.formLinkOrder.set(mutation.formUuid, order);
				break;
			}
			case "removeFormLink":
				removeMember(state.formLinkOrder.get(mutation.formUuid), mutation.uuid);
				break;
			case "moveFormLink": {
				const order = state.formLinkOrder.get(mutation.formUuid) ?? [];
				if (!place(order, mutation.uuid, mutation.after, true)) {
					return issue(
						mutation,
						mutationIndex,
						`form ${mutation.formUuid} links`,
						mutation.after,
					);
				}
				state.formLinkOrder.set(mutation.formUuid, order);
				break;
			}
			case "updateFormLink":
				break;
			case "addUserProperty":
				if (
					!place(
						state.userPropertyOrder,
						mutation.property.uuid,
						mutation.after,
					)
				) {
					return issue(
						mutation,
						mutationIndex,
						"worker information",
						mutation.after,
					);
				}
				break;
			case "removeUserProperty":
				removeMember(state.userPropertyOrder, mutation.uuid);
				break;
			case "updateUserProperty":
				break;
			case "addUserType":
				if (
					!place(state.userTypeOrder, mutation.userType.uuid, mutation.after)
				) {
					return issue(mutation, mutationIndex, "user types", mutation.after);
				}
				break;
			case "removeUserType":
				removeMember(state.userTypeOrder, mutation.uuid);
				break;
			case "updateUserType":
				break;
			case "addPersona":
				if (!place(state.personaOrder, mutation.persona.uuid, mutation.after)) {
					return issue(mutation, mutationIndex, "personas", mutation.after);
				}
				break;
			case "removePersona":
				removeMember(state.personaOrder, mutation.uuid);
				break;
			case "updatePersona":
				break;
			case "addOrganizationLevel":
				if (
					!place(
						state.organizationLevelOrder,
						mutation.level.uuid,
						mutation.after,
					)
				) {
					return issue(
						mutation,
						mutationIndex,
						"organization levels",
						mutation.after,
					);
				}
				break;
			case "removeOrganizationLevel":
				removeMember(state.organizationLevelOrder, mutation.uuid);
				break;
			case "updateOrganizationLevel":
				break;
			case "addLocationProperty":
				if (
					!place(
						state.locationPropertyOrder,
						mutation.property.uuid,
						mutation.after,
					)
				) {
					return issue(
						mutation,
						mutationIndex,
						"place information",
						mutation.after,
					);
				}
				break;
			case "removeLocationProperty":
				removeMember(state.locationPropertyOrder, mutation.uuid);
				break;
			case "updateLocationProperty":
				break;
			case "addAutomation": {
				if (
					!place(
						state.automationOrder,
						mutation.automation.uuid,
						mutation.after,
					)
				) {
					return issue(mutation, mutationIndex, "automations", mutation.after);
				}
				const automation = mutation.automation;
				state.automationItemOrder.set(
					automationKey(automation.uuid, "criterion"),
					automation.criteria.map((criterion) => criterion.uuid),
				);
				state.automationItemOrder.set(
					automationKey(automation.uuid, "setup-only-criterion"),
					automation.setupOnlyCriteria.map((criterion) => criterion.uuid),
				);
				if (automation.kind === "case-update") {
					state.automationItemOrder.set(
						automationKey(automation.uuid, "update"),
						automation.updates.map((update) => update.uuid),
					);
				} else {
					state.automationItemOrder.set(
						automationKey(automation.uuid, "recipient"),
						automation.recipients.map((recipient) => recipient.uuid),
					);
					state.automationItemOrder.set(
						automationKey(automation.uuid, `${automation.schedule.kind}-event`),
						automation.schedule.events.map((event) => event.uuid),
					);
					state.automationItemOrder.set(
						automationKey(automation.uuid, "user-data-filter"),
						automation.userDataFilters.map((filter) => filter.uuid),
					);
				}
				break;
			}
			case "removeAutomation":
				removeMember(state.automationOrder, mutation.uuid);
				for (const key of state.automationItemOrder.keys()) {
					if (key.startsWith(`${mutation.uuid}\0`)) {
						state.automationItemOrder.delete(key);
					}
				}
				break;
			case "moveAutomation":
				if (
					!place(state.automationOrder, mutation.uuid, mutation.after, true)
				) {
					return issue(mutation, mutationIndex, "automations", mutation.after);
				}
				break;
			case "setAutomationSchedule":
				state.automationItemOrder.delete(
					automationKey(mutation.uuid, "immediate-event"),
				);
				state.automationItemOrder.delete(
					automationKey(mutation.uuid, "timed-event"),
				);
				state.automationItemOrder.set(
					automationKey(mutation.uuid, `${mutation.schedule.kind}-event`),
					mutation.schedule.events.map((event) => event.uuid),
				);
				break;
			case "editAutomationItem": {
				const edit = mutation.edit;
				const order = state.automationItemOrder.get(
					automationKey(mutation.automationUuid, edit.collection),
				);
				if (order === undefined) {
					return issue(
						mutation,
						mutationIndex,
						`automation ${edit.collection}`,
						null,
					);
				}
				if (edit.operation === "add") {
					if (!place(order, edit.value.uuid, edit.after)) {
						return issue(
							mutation,
							mutationIndex,
							`automation ${edit.collection}`,
							edit.after,
						);
					}
				} else if (edit.operation === "remove") {
					removeMember(order, edit.uuid);
				} else if (edit.operation === "move") {
					if (!place(order, edit.uuid, edit.after, true)) {
						return issue(
							mutation,
							mutationIndex,
							`automation ${edit.collection}`,
							edit.after,
						);
					}
				}
				break;
			}
			case "updateAutomation":
			case "updateAutomationSchedule":
				break;
			case "setAppName":
			case "setConnectType":
			case "setAppLogo":
			case "relabelSourceLanguage":
			case "addLanguage":
			case "removeLanguage":
			case "setDefaultLanguage":
			case "setTranslation":
			case "reviewTranslation":
			case "renameCaseProperties":
				break;
			case "declareCaseType":
				state.casePropertyOrder.set(mutation.caseType, []);
				break;
			case "retireCaseType":
				state.casePropertyOrder.delete(mutation.caseType);
				break;
			case "addCaseProperty": {
				const order = state.casePropertyOrder.get(mutation.caseType);
				if (
					order === undefined ||
					!place(order, mutation.property.name, mutation.after)
				) {
					return issue(
						mutation,
						mutationIndex,
						`case type ${mutation.caseType} properties`,
						mutation.after,
					);
				}
				break;
			}
			case "setCaseProperty":
			case "setCaseTypeMeta":
				break;
			case "removeCaseProperty":
				removeMember(
					state.casePropertyOrder.get(mutation.caseType),
					mutation.property,
				);
				break;
			default:
				assertNever(mutation, "mutationSequenceAdmissionIssue");
		}
	}
	return undefined;
}
