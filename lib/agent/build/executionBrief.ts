import { uniqueSlug } from "@/lib/domain/idSlug";
import { orderSlicesForExecution } from "./sliceOrder";
/** Exact, derived execution context for one workflow slice. */

import {
	type ChangeSetHandle,
	changeSetHandleSchema,
} from "@/lib/agent/change-set/schemas";
import type {
	BuildPlan,
	BuildSlice,
	ExternalAction,
} from "@/lib/agent/design/buildPlan";
import {
	buildCapabilityCatalog,
	EXTERNAL_PREREQUISITES,
} from "@/lib/agent/design/capabilityCatalog";
import type {
	AccessPolicy,
	AppCharter,
	AppDesignContract,
	ArchitectureDecision,
	Assumption,
	DesignActor,
	DesignedLookupChoiceSource,
	DesignLookupChoiceSource,
	ExistingLookupChoiceReference,
	ExternalRequirement,
	FormComposition,
	FormCompositionItem,
	ModuleComposition,
	RecordConcept,
	RecordProperty,
	Workflow,
	WorkflowInput,
	WorkList,
} from "@/lib/agent/design/contract";
import type { DesignId } from "@/lib/agent/design/ids";
import {
	PLATFORM_CONSTRAINTS,
	type PlatformConstraint,
	type PlatformConstraintCode,
} from "@/lib/agent/design/platformConstraints";
import {
	isCaseLoadingFormComposition,
	moduleSelectionIntent,
	selectionRealizationWorkflowId,
} from "@/lib/agent/design/selectionCoverage";
import { workflowDataReferences } from "@/lib/agent/design/workflowReferences";
import { slugifyId } from "@/lib/domain/idSlug";
import { languageDescriptor } from "@/lib/domain/languageRegistry/names";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import {
	deriveExecutorToolProfile,
	type ExecutorToolProfile,
} from "./executorToolProfile";

type ExecutionChoiceReference =
	| ExistingLookupChoiceReference
	| DesignedLookupChoiceSource;
type ExecutionRecordConcept = Omit<RecordConcept, "properties"> & {
	readonly properties: readonly (Omit<RecordProperty, "choiceSource"> & {
		readonly choiceSource?: ExecutionChoiceReference;
	})[];
};
type ExecutionWorkflow = Omit<Workflow, "inputs"> & {
	readonly inputs: readonly (Omit<WorkflowInput, "choiceSource"> & {
		readonly choiceSource?: ExecutionChoiceReference;
	})[];
};

function executionChoiceReference(
	source: DesignLookupChoiceSource | undefined,
): ExecutionChoiceReference | undefined {
	if (source?.kind !== "existing-project-lookup") return source;
	const { inspection: _inspection, ...reference } = source;
	return reference;
}

export interface ConstructionChecklist {
	readonly groupName: string;
	readonly items: readonly {
		readonly kind: BuildSlice["constructionGroups"][number]["elements"][number]["kind"];
		readonly requirement: string;
	}[];
}

export interface SliceExecutionBrief {
	readonly schemaVersion: 1;
	readonly designRevisionId: string;
	readonly designRevisionDigest: string;
	readonly buildPlanId: string;
	readonly buildPlanDigest: string;
	readonly charter: AppCharter;
	readonly slice: BuildSlice;
	readonly constructionChecklist: readonly ConstructionChecklist[];
	readonly toolProfile: ExecutorToolProfile;
	readonly workflow: ExecutionWorkflow;
	/** Read tasks realized by the same construction, without extra form submissions. */
	readonly readWorkflows?: readonly Workflow[];
	readonly prerequisiteWorkflows: readonly Pick<
		Workflow,
		"id" | "name" | "goal"
	>[];
	readonly actors: readonly DesignActor[];
	readonly records: readonly ExecutionRecordConcept[];
	/** Deterministic compiler mapping from semantic record identity to the exact
	 * Blueprint case-type key every construction operation must reuse. */
	readonly recordRealizations: readonly {
		readonly recordId: DesignId;
		readonly displayName: string;
		readonly blueprintCaseType: string;
		readonly parentBlueprintCaseType?: string;
	}[];
	readonly lists: readonly WorkList[];
	readonly access: readonly AccessPolicy[];
	readonly moduleCompositions: readonly ModuleComposition[];
	readonly formCompositions: readonly FormComposition[];
	readonly moduleRealizations: readonly {
		readonly compositionId: DesignId;
		/** Exact private-workspace identity for this accepted composition. The
		 * server binds this key so equal display names and
		 * record hosts never become an identity heuristic. */
		readonly blueprintModuleHandle: ChangeSetHandle;
		readonly action: "create" | "reuse";
		readonly parentModuleCompositionId: DesignId | null;
		readonly afterSiblingModuleCompositionId: DesignId | null;
		readonly hostRecord: {
			readonly id: DesignId;
			readonly name: string;
			readonly blueprintCaseType: string;
		} | null;
		/** Minimum valid-by-construction Results configuration for a newly
		 * created case module. This is compiler input, not a design choice. */
		readonly requiredInitialResultsColumn?: {
			readonly kind: "plain";
			readonly field: "case_name";
			readonly header: string;
			readonly visibleInList: true;
		};
		/** Deterministic lowering of the semantic module selection owned by this
		 * workflow. `create-with-module` is valid only when the same atomic module
		 * creation includes its batch-consuming form; a reused module configures
		 * selection only after that form exists. */
		readonly selectionRealization?:
			| {
					readonly action: "default-one";
					readonly workflowIds: readonly DesignId[];
					readonly cases: "one";
					readonly selection: null;
			  }
			| {
					readonly action: "create-with-module" | "configure-after-forms";
					readonly workflowIds: readonly DesignId[];
					readonly cases: "several";
					readonly maximum: number;
					readonly selection: {
						readonly kind: "multiple";
						readonly maximum: number;
					};
			  };
		readonly role: ModuleComposition["role"];
		readonly icon: ModuleComposition["icon"];
		readonly formCompositionIds: readonly DesignId[];
	}[];
	readonly entryPointRealizations?: readonly EntryPointRealization[];
	readonly formRealizations: readonly {
		readonly blueprintFormHandle?: ChangeSetHandle;
		readonly compositionId: DesignId;
		readonly moduleCompositionId: DesignId;
		readonly blueprintFormType:
			| "registration"
			| "followup"
			| "close"
			| "survey";
		readonly name: string;
		readonly icon: FormComposition["icon"];
		readonly layout: FormComposition["layout"];
		readonly layoutLowering:
			| {
					readonly kind: "nested-group-fields";
					readonly groups: readonly {
						readonly compositionSectionId: DesignId;
						readonly blueprintFieldKind: "group";
						readonly labelMarkdown: string;
						readonly items: readonly FormCompositionItemLowering[];
					}[];
			  }
			| {
					readonly kind: "root-fields";
					readonly items: readonly FormCompositionItemLowering[];
			  };
		readonly duplicateRationale?: string;
	}[];
	readonly externalRequirements: readonly ExternalRequirement[];
	readonly decisions: readonly ArchitectureDecision[];
	readonly assumptions: readonly Assumption[];
	readonly externalActions: readonly ExternalAction[];
	readonly loweringConstraints: readonly PlatformConstraint[];
	readonly capabilityBoundary: {
		readonly sessionBoundary: {
			readonly appCount: 1;
			readonly projectScope: "current-project";
		};
		readonly existingReferenceable: readonly string[];
		readonly externalPrerequisites: readonly string[];
		readonly unsupported: readonly string[];
	};
}

const MAX_BLUEPRINT_CASE_TYPE_LENGTH = 255;
const RESERVED_BLUEPRINT_CASE_TYPE_KEYS = new Set([
	"case",
	"form",
	"parent",
	"user",
]);

export interface EntryPointRealization {
	readonly kind: "module" | "case-list" | "form";
	readonly moduleCompositionId: DesignId;
	readonly blueprintModuleHandle: ChangeSetHandle;
	readonly blueprintFormHandle?: ChangeSetHandle;
	readonly id: string;
	readonly ignoreDisplayConditions?: true;
}

export function blueprintFormHandle(compositionId: DesignId): ChangeSetHandle {
	return changeSetHandleSchema.parse(
		`@form_${compositionId.replaceAll("-", "")}`,
	);
}

/** Derive once from complete accepted composition, reserving authored IDs before
 * allocating defaults so a generated name never steals an explicit identity. */
export function acceptedEntryPointRealizations(
	contract: AppDesignContract,
): EntryPointRealization[] {
	const taken = new Set(
		[
			...contract.moduleCompositions.flatMap((item) => [
				item.entryPoint?.id,
				item.caseListEntryPoint?.id,
			]),
			...contract.formCompositions.map((item) => item.entryPoint?.id),
		].filter((id): id is string => id !== undefined),
	);
	const result: EntryPointRealization[] = [];
	const add = (
		kind: EntryPointRealization["kind"],
		moduleCompositionId: DesignId,
		name: string,
		intent: { id?: string; ignoreDisplayConditions?: true },
		formId?: DesignId,
	) => {
		const id = intent.id ?? uniqueSlug(name, "entry_point", taken);
		taken.add(id);
		result.push({
			kind,
			moduleCompositionId,
			blueprintModuleHandle: blueprintModuleHandle(moduleCompositionId),
			id,
			...(formId === undefined
				? {}
				: { blueprintFormHandle: blueprintFormHandle(formId) }),
			...(intent.ignoreDisplayConditions === true
				? { ignoreDisplayConditions: true }
				: {}),
		});
	};
	for (const item of contract.moduleCompositions) {
		if (item.entryPoint !== undefined)
			add("module", item.id, item.name, item.entryPoint);
		if (item.caseListEntryPoint !== undefined)
			add("case-list", item.id, `${item.name} list`, item.caseListEntryPoint);
	}
	for (const item of contract.formCompositions)
		if (item.entryPoint !== undefined)
			add(
				"form",
				item.moduleCompositionId,
				item.name,
				item.entryPoint,
				item.id,
			);
	return result;
}

/** Lower a semantic module identity into the executor's existing durable
 * handle vocabulary. Full DesignId bits keep the mapping injective without a
 * new persisted identity kind or a display-name uniqueness rule. */
export function blueprintModuleHandle(
	compositionId: DesignId,
): ChangeSetHandle {
	return changeSetHandleSchema.parse(
		`@module_${compositionId.replaceAll("-", "")}`,
	);
}

/** A semantic display name is not a machine identifier. Lower the complete
 * accepted record catalog once, before any slice is derived, so every slice
 * receives the same case-type key and a model can never create `Household`
 * beside `household`. UUID suffixes make display-name collisions stable and
 * independent of record order. */
function deriveRecordRealizations(
	records: readonly RecordConcept[],
): SliceExecutionBrief["recordRealizations"] {
	const bases = records.map((record) => {
		const slug = slugifyId(record.name, "record");
		const identifier = /^[a-z]/.test(slug) ? slug : `record_${slug}`;
		return RESERVED_BLUEPRINT_CASE_TYPE_KEYS.has(identifier)
			? `${identifier}_record`
			: identifier;
	});
	const suffixRequired = new Set<DesignId>();
	const keyByRecordId = new Map<DesignId, string>();
	// A generated UUID-suffixed key can itself be another record's display-name
	// slug. Resolve the complete catalog to a fixed point: suffix every member
	// of a collision, retaining ordinary keys where no collision exists.
	// Fully suffixed keys are distinct because each carries its complete UUID.
	for (;;) {
		const ownersByKey = new Map<string, DesignId[]>();
		for (const [index, record] of records.entries()) {
			const base = bases[index] ?? "record";
			const suffix = suffixRequired.has(record.id)
				? `_${record.id.replaceAll("-", "")}`
				: "";
			const key = `${base.slice(0, MAX_BLUEPRINT_CASE_TYPE_LENGTH - suffix.length)}${suffix}`;
			keyByRecordId.set(record.id, key);
			const owners = ownersByKey.get(key) ?? [];
			owners.push(record.id);
			ownersByKey.set(key, owners);
		}
		let changed = false;
		for (const owners of ownersByKey.values()) {
			if (owners.length < 2) continue;
			for (const id of owners) {
				if (!suffixRequired.has(id)) {
					suffixRequired.add(id);
					changed = true;
				}
			}
		}
		if (!changed) break;
	}
	return records.map((record) => ({
		recordId: record.id,
		displayName: record.name,
		blueprintCaseType: keyByRecordId.get(record.id) ?? "record",
		...(record.parentRecordId !== undefined && {
			parentBlueprintCaseType: keyByRecordId.get(record.parentRecordId),
		}),
	}));
}

interface FormCompositionItemLowering {
	readonly compositionItemId: DesignId;
	readonly blueprintFieldKind: "workflow-input" | "label";
	readonly inputHandle?: string;
	/** Exact form-local field id for an accepted workflow input. Keeping this
	 * deterministic lets finalization compare the realized field's contextual
	 * behavior with the accepted input instead of guessing by label or order. */
	readonly blueprintFieldId?: string;
	readonly markdown?: string;
	readonly recordSummary?: {
		readonly recordId: DesignId;
		readonly propertyIds: readonly DesignId[];
		readonly purpose: string;
	};
}

function lowerCompositionItems(
	items: readonly FormCompositionItem[],
): FormCompositionItemLowering[] {
	return items.map((item) => {
		if (item.kind === "input") {
			return {
				compositionItemId: item.id,
				blueprintFieldKind: "workflow-input" as const,
				inputHandle: item.inputHandle,
				blueprintFieldId: item.inputHandle,
			};
		}
		if (item.kind === "guidance") {
			return {
				compositionItemId: item.id,
				blueprintFieldKind: "label" as const,
				markdown: item.markdown,
			};
		}
		return {
			compositionItemId: item.id,
			blueprintFieldKind: "label" as const,
			recordSummary: {
				recordId: item.recordId,
				propertyIds: item.propertyIds,
				purpose: item.purpose,
			},
		};
	});
}

function lowerCompositionLayout(
	layout: FormComposition["layout"],
): SliceExecutionBrief["formRealizations"][number]["layoutLowering"] {
	return layout.kind === "sectioned"
		? {
				kind: "nested-group-fields",
				groups: layout.sections.map((section) => ({
					compositionSectionId: section.id,
					blueprintFieldKind: "group" as const,
					labelMarkdown: section.headingMarkdown,
					items: lowerCompositionItems(section.items),
				})),
			}
		: {
				kind: "root-fields",
				items: lowerCompositionItems(layout.items),
			};
}

const CONSTRAINT_AREAS: Readonly<
	Record<
		PlatformConstraintCode,
		readonly BuildSlice["constructionGroups"][number]["blueprintAreas"][number][]
	>
> = {
	PREVIEW_AUTOMATIONS_NOT_EXECUTED: ["automations"],
	NO_MATCHES_REGISTRATION_IS_WEB_APPS_ONLY: ["case-list", "forms"],
	AUTOMATION_HQ_MANUAL_SETUP: ["automations"],
	HQ_BUILD_RELEASE_NOT_API_DRIVEN: [],
	WORKER_SCHEMA_AND_ROLES_NOT_PUSHED: ["users"],
	LOCATION_OWNER_EXPORT_CLOSED: ["organization-shape", "case-operations"],
	CASE_SEARCH_IS_LIVE_AND_ONLINE: ["case-list"],
	CASE_STATUS_IS_OPEN_OR_CLOSED: ["case-list", "forms", "case-operations"],
	CASE_UPDATES_ARE_NOT_COMPARE_AND_SET: ["case-operations"],
	SINGLE_DIRECT_CASE_WRITE_PER_FIELD: ["forms"],
	STANDARD_SCALAR_WRITERS_LIMITED: ["forms", "case-operations"],
	CASE_NAME_REQUIRED_ON_CREATE: ["forms", "case-operations"],
	REGISTRATION_CREATE_IS_UNCONDITIONAL: ["forms", "case-operations"],
	RESERVED_CASE_IDENTIFIERS_REJECTED: ["case-catalog", "forms"],
	CASE_WRITE_TARGETS_MODULE_LINEAGE: ["forms", "case-operations"],
	CASE_PROPERTY_CLEAR_UNAVAILABLE: ["forms", "case-operations"],
	CASE_BOUND_UPDATE_INPUTS_EDIT_CURRENT_VALUES: ["forms"],
	SEVERAL_CASE_FORMS_SHARE_ONE_ANSWER_SET: [],
	DISPLAY_CONDITIONS_ARE_UX_NOT_ACCESS: ["navigation", "users", "case-list"],
	ON_DEVICE_DATE_ADD_FIXED_DURATION_ONLY: ["forms", "case-operations"],
	REPEATED_EVENTS_ARE_CHILD_RECORDS: [
		"case-catalog",
		"forms",
		"case-operations",
	],
};

function checklistRequirement(
	kind: ConstructionChecklist["items"][number]["kind"],
	id: string,
	contract: AppDesignContract,
): string {
	if (kind === "workflow") {
		const workflow = contract.workflows.find((entry) => entry.id === id);
		const features = workflow?.authoredFeatures ?? [];
		return [
			workflow?.goal ?? id,
			...(features.includes("existing-media")
				? ["Attach the accepted existing Project media references."]
				: []),
			...(features.includes("automation")
				? ["Author the accepted automatic update or alert behavior."]
				: []),
		].join(" ");
	}
	if (kind === "actor")
		return `Use actor ${contract.actors.find((entry) => entry.id === id)?.name ?? id} as workflow context; materialize worker properties, user types, or personas only where an accepted executable condition/reference or explicit authored-worker requirement needs them.`;
	if (kind === "record")
		return `Declare record ${contract.records.find((entry) => entry.id === id)?.name ?? id}.`;
	if (kind === "property") {
		const property = contract.records
			.flatMap((record) => record.properties)
			.find((entry) => entry.id === id);
		return `Declare and author ${property?.name ?? id}${property === undefined ? "" : ` as ${property.dataShape}`}.`;
	}
	if (kind === "list")
		return `Author list ${contract.lists.find((entry) => entry.id === id)?.name ?? id}.`;
	if (kind === "access") return `Implement accepted access policy ${id}.`;
	if (kind === "module-composition") {
		const composition = contract.moduleCompositions.find(
			(entry) => entry.id === id,
		);
		return composition === undefined
			? `Realize module composition ${id}.`
			: `Realize ${composition.role} module ${composition.name} with its accepted host, ${composition.parentModuleCompositionId === undefined ? "top-level menu placement" : `parent menu ${composition.parentModuleCompositionId}`}, order, and icon decision.`;
	}
	if (kind === "form-composition") {
		const composition = contract.formCompositions.find(
			(entry) => entry.id === id,
		);
		return composition === undefined
			? `Realize form composition ${id}.`
			: `Realize ${composition.mode} form ${composition.name} with its exact variant, icon, and ${composition.layout.kind} layout.`;
	}
	if (kind === "composition-section")
		return `Realize accepted form section ${id} in order.`;
	if (kind === "composition-item")
		return `Realize accepted input, guidance, or record-summary item ${id} in order.`;
	return `Account for external requirement ${id}.`;
}

export function deriveSliceExecutionBrief(args: {
	readonly contract: AppDesignContract;
	readonly revision: { readonly id: string; readonly digest: string };
	readonly plan: BuildPlan;
	readonly sliceId: DesignId;
	readonly planDigest?: string;
}): SliceExecutionBrief {
	const slice = args.plan.slices.find((entry) => entry.id === args.sliceId);
	if (slice === undefined) {
		throw new Error(
			`Build plan ${args.plan.id} holds no slice ${args.sliceId}.`,
		);
	}
	const workflow = args.contract.workflows.find(
		(entry) => entry.id === slice.workflowId,
	);
	if (workflow === undefined) {
		throw new Error(`Accepted design holds no workflow ${slice.workflowId}.`);
	}
	const executableSlice: BuildSlice = slice;
	if (executableSlice.constructionGroups.length === 0) {
		throw new Error(
			`Build slice ${slice.id} has no Blueprint construction work.`,
		);
	}
	const allRecordRealizations = deriveRecordRealizations(args.contract.records);
	const recordKeyById = new Map(
		allRecordRealizations.map((record) => [
			record.recordId,
			record.blueprintCaseType,
		]),
	);
	const elements = new Set(
		executableSlice.constructionGroups.flatMap((group) =>
			group.elements.map((element) => element.id),
		),
	);
	const ownedPropertyIds = new Set(
		executableSlice.constructionGroups.flatMap((group) =>
			group.elements
				.filter((element) => element.kind === "property")
				.map((element) => element.id),
		),
	);
	const readWorkflows = args.contract.workflows.filter(
		(item) => item.id !== workflow.id && elements.has(item.id),
	);
	const readback = [workflow, ...readWorkflows].flatMap(
		(item) => item.readback,
	);
	const usedPropertyIds = new Set<string>();
	const recordIds = new Set<string>();
	const actorIds = new Set(
		[workflow, ...readWorkflows].flatMap((item) => item.actorIds),
	);
	for (const covered of [workflow, ...readWorkflows]) {
		const references = workflowDataReferences(args.contract, covered);
		for (const id of references.recordIds) recordIds.add(id);
		for (const id of references.propertyIds) usedPropertyIds.add(id);
	}
	const lists = args.contract.lists.filter(
		(list) =>
			elements.has(list.id) ||
			readback.some((reading) => reading.recordId === list.recordId),
	);
	for (const list of lists) {
		recordIds.add(list.recordId);
		for (const actorId of list.actorIds) actorIds.add(actorId);
		for (const id of [
			...list.scanPropertyIds,
			...list.detailPropertyIds,
			...list.searchPropertyIds,
		])
			usedPropertyIds.add(id);
	}
	/* A property can be read from a record the workflow does not otherwise
	 * address (for example, a decision over a value established by an earlier
	 * workflow). Keep its owning record in the brief after every workflow/list
	 * property source has contributed, then project that record down to the
	 * exact owned-or-used properties below. */
	for (const record of args.contract.records) {
		if (
			elements.has(record.id) ||
			record.properties.some(
				(property) =>
					elements.has(property.id) || usedPropertyIds.has(property.id),
			)
		) {
			recordIds.add(record.id);
		}
	}
	const formCompositions = args.contract.formCompositions.filter(
		(composition) => composition.workflowId === workflow.id,
	);
	const orderedPlanWorkflowIds = args.plan.slices.map(
		(planSlice) => planSlice.workflowId,
	);
	const entryPointRealizations =
		orderedPlanWorkflowIds.at(-1) === workflow.id
			? acceptedEntryPointRealizations(args.contract)
			: [];
	const relevantModuleCompositionIds = new Set<string>([
		...entryPointRealizations.map((entry) => entry.moduleCompositionId),
		...formCompositions.map(
			(composition) => composition.moduleCompositionId as string,
		),
		...executableSlice.constructionGroups.flatMap((group) =>
			group.elements.flatMap((element) =>
				element.kind === "module-composition" ? [element.id as string] : [],
			),
		),
	]);
	for (const composition of args.contract.moduleCompositions) {
		const selectionIntent = moduleSelectionIntent(args.contract, composition);
		if (
			selectionIntent !== undefined &&
			selectionRealizationWorkflowId(
				selectionIntent.workflowIds,
				orderedPlanWorkflowIds,
			) === workflow.id
		) {
			relevantModuleCompositionIds.add(composition.id);
		}
	}
	// Briefs validate the full expected construction prefix, not just modules
	// that happen to be present. Every earlier slice has committed in this same
	// shared deterministic execution order.
	const expectedModuleIds = new Set<string>();
	for (const prefixSlice of orderSlicesForExecution(args.plan)) {
		for (const group of prefixSlice.constructionGroups) {
			for (const element of group.elements) {
				if (element.kind === "module-composition")
					expectedModuleIds.add(element.id);
			}
		}
		if (prefixSlice.workflowId === workflow.id) break;
	}
	for (const id of expectedModuleIds) relevantModuleCompositionIds.add(id);
	const placementModules = args.contract.moduleCompositions.filter((entry) =>
		expectedModuleIds.has(entry.id),
	);
	/* A child cannot be realized from its row alone: construction needs its
	 * parent and preceding sibling as exact create/reuse anchors. Close that
	 * one-tier placement context before filtering the immutable contract order. */
	const placementClosure = [...relevantModuleCompositionIds];
	for (
		let closureIndex = 0;
		closureIndex < placementClosure.length;
		closureIndex++
	) {
		const compositionId = placementClosure[closureIndex];
		if (compositionId === undefined) continue;
		const composition = args.contract.moduleCompositions.find(
			(entry) => entry.id === compositionId,
		);
		if (composition?.parentModuleCompositionId !== undefined) {
			if (
				!relevantModuleCompositionIds.has(composition.parentModuleCompositionId)
			) {
				relevantModuleCompositionIds.add(composition.parentModuleCompositionId);
				placementClosure.push(composition.parentModuleCompositionId);
			}
		}
		if (composition !== undefined) {
			const siblings = placementModules.filter(
				(entry) =>
					entry.parentModuleCompositionId ===
					composition.parentModuleCompositionId,
			);
			const siblingIndex = siblings.findIndex(
				(entry) => entry.id === composition.id,
			);
			if (siblingIndex > 0) {
				const preceding = siblings[siblingIndex - 1];
				if (preceding !== undefined) {
					if (!relevantModuleCompositionIds.has(preceding.id)) {
						relevantModuleCompositionIds.add(preceding.id);
						placementClosure.push(preceding.id);
					}
					if (preceding.parentModuleCompositionId !== undefined) {
						if (
							!relevantModuleCompositionIds.has(
								preceding.parentModuleCompositionId,
							)
						) {
							relevantModuleCompositionIds.add(
								preceding.parentModuleCompositionId,
							);
							placementClosure.push(preceding.parentModuleCompositionId);
						}
					}
				}
			}
		}
	}
	const moduleCompositions = args.contract.moduleCompositions.filter(
		(composition) => relevantModuleCompositionIds.has(composition.id),
	);
	const access = args.contract.access.filter(
		(policy) =>
			elements.has(policy.id) ||
			policy.targets.some(
				(target) =>
					target.id === workflow.id ||
					(target.kind === "module-composition" &&
						args.contract.moduleCompositions.some(
							(module) =>
								module.id === target.id &&
								(module.workflowIds.includes(workflow.id) ||
									elements.has(module.id)),
						)) ||
					recordIds.has(target.id) ||
					lists.some((list) => list.id === target.id),
			),
	);
	for (const policy of access) actorIds.add(policy.actorId);
	for (const module of moduleCompositions)
		if (module.workflowIds.includes(workflow.id) || elements.has(module.id))
			for (const actorId of module.actorIds) actorIds.add(actorId);
	const ownedModuleCompositionIds = new Set(
		executableSlice.constructionGroups.flatMap((group) =>
			group.elements.flatMap((element) =>
				element.kind === "module-composition" ? [element.id] : [],
			),
		),
	);
	const moduleRealizations = moduleCompositions.map((composition) => {
		const hostRecord = args.contract.records.find(
			(record) => record.id === composition.hostRecordId,
		);
		const action = ownedModuleCompositionIds.has(composition.id)
			? ("create" as const)
			: ("reuse" as const);
		const selectionIntent = moduleSelectionIntent(args.contract, composition);
		const realizationWorkflowId =
			selectionIntent === undefined
				? undefined
				: selectionRealizationWorkflowId(
						selectionIntent.workflowIds,
						orderedPlanWorkflowIds,
					);
		const directlyHostedCaseLoadingForms =
			args.contract.formCompositions.filter(
				(form) =>
					form.moduleCompositionId === composition.id &&
					isCaseLoadingFormComposition(form),
			);
		const selectionRealization =
			selectionIntent === undefined || realizationWorkflowId !== workflow.id
				? undefined
				: selectionIntent.cases === "one"
					? {
							action: "default-one" as const,
							workflowIds: selectionIntent.workflowIds,
							cases: "one" as const,
							selection: null,
						}
					: {
							action:
								action === "create" &&
								selectionIntent.workflowIds.every(
									(workflowId) => workflowId === workflow.id,
								) &&
								directlyHostedCaseLoadingForms.length > 0 &&
								directlyHostedCaseLoadingForms.every(
									(form) => form.workflowId === workflow.id,
								)
									? ("create-with-module" as const)
									: ("configure-after-forms" as const),
							workflowIds: selectionIntent.workflowIds,
							cases: "several" as const,
							maximum: selectionIntent.maximum,
							selection: {
								kind: "multiple" as const,
								maximum: selectionIntent.maximum,
							},
						};
		const siblings = placementModules.filter(
			(entry) =>
				entry.parentModuleCompositionId ===
				composition.parentModuleCompositionId,
		);
		const siblingIndex = siblings.findIndex(
			(entry) => entry.id === composition.id,
		);
		return {
			compositionId: composition.id,
			blueprintModuleHandle: blueprintModuleHandle(composition.id),
			action,
			parentModuleCompositionId: composition.parentModuleCompositionId ?? null,
			afterSiblingModuleCompositionId:
				siblingIndex <= 0 ? null : (siblings[siblingIndex - 1]?.id ?? null),
			hostRecord:
				hostRecord === undefined
					? null
					: {
							id: hostRecord.id,
							name: hostRecord.name,
							blueprintCaseType: recordKeyById.get(hostRecord.id) ?? "record",
						},
			...(action === "create" && hostRecord !== undefined
				? {
						requiredInitialResultsColumn: {
							kind: "plain" as const,
							field: "case_name" as const,
							header: hostRecord.name,
							visibleInList: true as const,
						},
					}
				: {}),
			...(selectionRealization === undefined ? {} : { selectionRealization }),
			role: composition.role,
			icon: composition.icon,
			formCompositionIds: formCompositions
				.filter((form) => form.moduleCompositionId === composition.id)
				.map((form) => form.id),
		};
	});
	const formRealizations = formCompositions.map((composition) => ({
		...(composition.entryPoint === undefined
			? {}
			: { blueprintFormHandle: blueprintFormHandle(composition.id) }),
		compositionId: composition.id,
		moduleCompositionId: composition.moduleCompositionId,
		blueprintFormType:
			composition.mode === "selected-record"
				? ("followup" as const)
				: composition.mode === "standalone"
					? ("survey" as const)
					: composition.mode,
		name: composition.name,
		icon: composition.icon,
		layout: composition.layout,
		layoutLowering: lowerCompositionLayout(composition.layout),
		...(composition.duplicateRationale !== undefined && {
			duplicateRationale: composition.duplicateRationale,
		}),
	}));
	const requirementIds = new Set(
		[workflow, ...readWorkflows].flatMap((item) => item.externalRequirementIds),
	);
	const prerequisiteSliceIds = new Set(executableSlice.prerequisiteSliceIds);
	const prerequisiteIds = new Set(
		args.plan.slices
			.filter((entry) => prerequisiteSliceIds.has(entry.id))
			.map((entry) => entry.workflowId),
	);
	const catalog = buildCapabilityCatalog();
	const toolProfile = deriveExecutorToolProfile(executableSlice, {
		entryPoints: entryPointRealizations.length > 0,
		configureCaseSelection: moduleRealizations.some(
			(realization) =>
				realization.selectionRealization?.action === "configure-after-forms",
		),
	});
	const areaSet = new Set(toolProfile.blueprintAreas);
	const relevantConstraints = Object.values(PLATFORM_CONSTRAINTS).filter(
		(constraint) =>
			CONSTRAINT_AREAS[constraint.code].some((area) => areaSet.has(area)) ||
			(constraint.code === "SEVERAL_CASE_FORMS_SHARE_ONE_ANSWER_SET" &&
				args.contract.moduleCompositions.some((composition) => {
					const intent = moduleSelectionIntent(args.contract, composition);
					return (
						intent?.cases === "several" &&
						intent.workflowIds.includes(workflow.id)
					);
				})) ||
			(constraint.code === "HQ_BUILD_RELEASE_NOT_API_DRIVEN" &&
				args.contract.externalRequirements.some(
					(requirement) =>
						requirementIds.has(requirement.id) &&
						requirement.kind === "deployment-readiness",
				)),
	);
	const constructionChecklist = executableSlice.constructionGroups.map(
		(group) => ({
			groupName: group.name,
			items: group.elements.map((element) => ({
				kind: element.kind,
				requirement: checklistRequirement(
					element.kind,
					element.id,
					args.contract,
				),
			})),
		}),
	);
	return {
		schemaVersion: 1,
		designRevisionId: args.revision.id,
		designRevisionDigest: args.revision.digest,
		buildPlanId: args.plan.id,
		buildPlanDigest: args.planDigest ?? canonicalJsonDigest(args.plan),
		charter: args.contract.charter,
		slice: executableSlice,
		constructionChecklist,
		toolProfile,
		...(readWorkflows.length === 0 ? {} : { readWorkflows }),
		workflow: {
			...workflow,
			inputs: workflow.inputs.map((input) => ({
				...input,
				...(input.choiceSource === undefined
					? {}
					: {
							choiceSource: executionChoiceReference(input.choiceSource),
						}),
			})),
		},
		prerequisiteWorkflows: args.contract.workflows
			.filter((entry) => prerequisiteIds.has(entry.id))
			.map(({ id, name, goal }) => ({ id, name, goal })),
		actors: args.contract.actors.filter((actor) => actorIds.has(actor.id)),
		records: args.contract.records
			.filter((record) => recordIds.has(record.id))
			.map((record) => ({
				...record,
				properties: record.properties
					.filter(
						(property) =>
							ownedPropertyIds.has(property.id) ||
							usedPropertyIds.has(property.id),
					)
					.map((property) => ({
						...property,
						...(property.choiceSource === undefined
							? {}
							: {
									choiceSource: executionChoiceReference(property.choiceSource),
								}),
					})),
			})),
		recordRealizations: allRecordRealizations.filter((record) =>
			recordIds.has(record.recordId),
		),
		lists,
		access,
		moduleCompositions,
		formCompositions,
		...(entryPointRealizations.length === 0 ? {} : { entryPointRealizations }),
		moduleRealizations,
		formRealizations,
		externalRequirements: args.contract.externalRequirements.filter(
			(requirement) => requirementIds.has(requirement.id),
		),
		decisions:
			slice.role === "materialization-root" ? [...args.contract.decisions] : [],
		assumptions:
			slice.role === "materialization-root"
				? [...args.contract.assumptions]
				: [],
		externalActions: args.plan.externalActions.filter((action) =>
			slice.externalActionIds.includes(action.id),
		),
		loweringConstraints: relevantConstraints,
		capabilityBoundary: {
			sessionBoundary: catalog.sessionBoundary,
			existingReferenceable: catalog.existingReferenceable.filter(
				(_entry, index) =>
					(index === 0 && areaSet.has("lookup-references")) ||
					(index === 1 && areaSet.has("media-references")) ||
					(index === 2 &&
						(areaSet.has("organization-shape") || areaSet.has("users"))),
			),
			externalPrerequisites: catalog.externalPrerequisites.filter(
				(entry) =>
					(entry === EXTERNAL_PREREQUISITES.media &&
						areaSet.has("media-references")) ||
					(entry === EXTERNAL_PREREQUISITES.provisioning &&
						(areaSet.has("organization-shape") || areaSet.has("users"))) ||
					(entry === EXTERNAL_PREREQUISITES.deployment &&
						args.contract.externalRequirements.some(
							(requirement) =>
								requirementIds.has(requirement.id) &&
								requirement.kind === "deployment-readiness",
						)),
			),
			unsupported: catalog.unsupported.filter(
				(_entry, index) =>
					index === 0 ||
					(index === 2 && areaSet.has("media-references")) ||
					(index === 3 &&
						args.contract.externalRequirements.some((requirement) =>
							requirementIds.has(requirement.id),
						)),
			),
		},
	};
}

export function briefDigest(brief: SliceExecutionBrief): string {
	return canonicalJsonDigest(brief);
}

function section(heading: string, body: string): string {
	return `## ${heading}\n${body}`;
}

function jsonSection(heading: string, value: unknown): string | null {
	if (Array.isArray(value))
		return value.length
			? section(
					heading,
					value.map((member) => JSON.stringify(member)).join("\n"),
				)
			: null;
	return value === undefined ? null : section(heading, JSON.stringify(value));
}

/** Working context retains accepted semantics once. Compiler instructions,
 * lineage digests, and internal binding keys stay in the durable brief. */
export function renderBriefMessage(
	brief: SliceExecutionBrief,
	resolveReferences: (value: unknown) => unknown = (value) => value,
): string {
	const blocks: Array<string | null> = [
		section(
			"App",
			`Name: ${brief.charter.appName}\n${brief.charter.objective}\nDelivery: ${brief.charter.deliveryContext}.${
				brief.charter.localization === undefined
					? "\nWrite worker content in English."
					: `\nWrite worker content in ${languageDescriptor(brief.charter.localization.sourceLanguage)}. Nova adds the accepted translations after construction.`
			}`,
		),
		section("Workflow", `${brief.slice.name}: ${brief.slice.goal}`),
		section(
			"Available operations",
			`Reads: ${brief.toolProfile.readTools.join(", ")}.\nChanges: ${brief.toolProfile.mutationTools.join(", ")}.`,
		),
		jsonSection("Workflow requirements", resolveReferences(brief.workflow)),
		jsonSection(
			"Reading saved records",
			resolveReferences(brief.readWorkflows),
		),
		jsonSection("Earlier workflows", brief.prerequisiteWorkflows),
		jsonSection("People", brief.actors),
		jsonSection(
			"Records",
			resolveReferences(
				brief.records.map((record) => ({
					...record,
					caseType: brief.recordRealizations.find(
						(item) => item.recordId === record.id,
					)?.blueprintCaseType,
					parentCaseType: brief.recordRealizations.find(
						(item) => item.recordId === record.id,
					)?.parentBlueprintCaseType,
				})),
			),
		),
		jsonSection("Lists and searches", brief.lists),
		jsonSection("Access", brief.access),
		jsonSection(
			"Modules",
			brief.moduleCompositions.map((composition) => ({
				...composition,
				action: brief.moduleRealizations.find(
					(item) => item.compositionId === composition.id,
				)?.action,
			})),
		),
		jsonSection("Forms", brief.formCompositions),
		jsonSection(
			"Entry points",
			brief.entryPointRealizations?.map((entry) => ({
				kind: entry.kind,
				module: brief.moduleCompositions.find(
					(item) => item.id === entry.moduleCompositionId,
				)?.name,
				...(entry.blueprintFormHandle && {
					form: brief.formRealizations.find(
						(item) =>
							blueprintFormHandle(item.compositionId) ===
							entry.blueprintFormHandle,
					)?.name,
				}),
				id: entry.id,
				...(entry.ignoreDisplayConditions && { ignoreDisplayConditions: true }),
			})) ?? [],
		),
		jsonSection("External requirements", brief.externalRequirements),
		jsonSection("Decisions", brief.decisions),
		jsonSection("Assumptions", brief.assumptions),
		jsonSection("External actions", brief.externalActions),
		jsonSection("Capability boundary", brief.capabilityBoundary),
		section(
			"Platform constraints",
			brief.loweringConstraints
				.map((constraint) => `- ${constraint.code}: ${constraint.statement}`)
				.join("\n"),
		),
	];
	return blocks.filter((block): block is string => block !== null).join("\n\n");
}
