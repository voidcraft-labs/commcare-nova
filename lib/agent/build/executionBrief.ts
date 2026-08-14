/** Exact, derived execution context for one workflow slice. */

import type {
	BuildPlan,
	BuildSlice,
	ExternalAction,
} from "@/lib/agent/design/buildPlan";
import { buildCapabilityCatalog } from "@/lib/agent/design/capabilityCatalog";
import type {
	AccessPolicy,
	AppCharter,
	AppDesignContract,
	ArchitectureDecision,
	Assumption,
	DesignActor,
	ExternalRequirement,
	NavigationIntent,
	RecordConcept,
	Workflow,
	WorkList,
} from "@/lib/agent/design/contract";
import type { DesignId } from "@/lib/agent/design/ids";
import {
	PLATFORM_CONSTRAINTS,
	type PlatformConstraint,
	type PlatformConstraintCode,
} from "@/lib/agent/design/platformConstraints";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import {
	deriveExecutorToolProfile,
	type ExecutorToolProfile,
} from "./executorToolProfile";

export interface ConstructionChecklist {
	readonly groupId: DesignId;
	readonly groupName: string;
	readonly items: readonly {
		readonly kind: BuildSlice["constructionGroups"][number]["elements"][number]["kind"];
		readonly id: DesignId;
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
	/** Small coverage vocabulary used by the change set instead of every design object. */
	readonly constructionGroupIds: readonly DesignId[];
	readonly constructionChecklist: readonly ConstructionChecklist[];
	readonly toolProfile: ExecutorToolProfile;
	readonly workflow: Workflow;
	readonly prerequisiteWorkflows: readonly Pick<
		Workflow,
		"id" | "name" | "goal"
	>[];
	readonly actors: readonly DesignActor[];
	readonly records: readonly RecordConcept[];
	readonly lists: readonly WorkList[];
	readonly access: readonly AccessPolicy[];
	readonly navigation: readonly NavigationIntent[];
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

const CONSTRAINT_AREAS: Readonly<
	Record<
		PlatformConstraintCode,
		readonly BuildSlice["constructionGroups"][number]["blueprintAreas"][number][]
	>
> = {
	PREVIEW_AUTOMATIONS_NOT_EXECUTED: ["automations"],
	AUTOMATION_HQ_MANUAL_SETUP: ["automations"],
	HQ_BUILD_RELEASE_NOT_API_DRIVEN: [],
	LOOKUP_HQ_EXPORT_CLOSED: ["lookup-references"],
	WORKER_PROVISIONING_NOT_SHIPPED: ["users"],
	LOCATION_OWNER_EXPORT_CLOSED: ["organization-shape", "case-operations"],
	CASE_SEARCH_IS_LIVE_AND_ONLINE: ["case-list"],
	CASE_UPDATES_ARE_NOT_COMPARE_AND_SET: ["case-operations"],
	SINGLE_DIRECT_CASE_WRITE_PER_FIELD: ["forms"],
	STANDARD_SCALAR_WRITERS_LIMITED: ["forms", "case-operations"],
	CASE_NAME_REQUIRED_ON_CREATE: ["forms", "case-operations"],
	RESERVED_CASE_IDENTIFIERS_REJECTED: ["case-catalog", "forms"],
	CASE_WRITE_TARGETS_MODULE_LINEAGE: ["forms", "case-operations"],
	CASE_PROPERTY_CLEAR_UNAVAILABLE: ["forms", "case-operations"],
	DISPLAY_CONDITIONS_ARE_UX_NOT_ACCESS: ["navigation", "users", "case-list"],
	ON_DEVICE_DATE_ADD_FIXED_DURATION_ONLY: ["forms", "case-operations"],
	GAP_GROUPED_CASE_TILES: ["case-list"],
	GAP_CASE_ATTACHMENT_EMISSION: ["forms", "case-list"],
	GAP_USERCASE_OWNER_SETS: ["users", "organization-shape", "case-operations"],
	GAP_PUSH_PROVISIONING_DRIVERS: [
		"lookup-references",
		"users",
		"organization-shape",
	],
	GAP_APP_SETUP_UI: [],
	GAP_FORM_LINKS_AND_SECTIONS: ["forms", "navigation"],
	GAP_NESTED_MENUS: ["navigation"],
	GAP_SESSION_ENDPOINTS_DEEP_LINKS: ["navigation"],
	GAP_MULTI_SELECT_RELATED_CASES: ["case-list", "forms"],
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
		return `Represent actor ${contract.actors.find((entry) => entry.id === id)?.name ?? id}.`;
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
	if (kind === "navigation")
		return `Author navigation ${contract.navigation.find((entry) => entry.id === id)?.name ?? id}.`;
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
	const usedPropertyIds = new Set<string>();
	for (const input of workflow.inputs) {
		if (input.propertyId !== undefined) usedPropertyIds.add(input.propertyId);
	}
	for (const decision of workflow.decisions) {
		for (const id of decision.inputPropertyIds) usedPropertyIds.add(id);
	}
	for (const effect of workflow.recordEffects) {
		for (const write of effect.writes) usedPropertyIds.add(write.propertyId);
	}
	for (const readback of workflow.readback) {
		for (const id of readback.propertyIds) usedPropertyIds.add(id);
	}
	const actorIds = new Set(workflow.actorIds);
	const recordIds = new Set<string>();
	if (workflow.contextRecordId !== undefined)
		recordIds.add(workflow.contextRecordId);
	for (const effect of workflow.recordEffects) {
		recordIds.add(effect.recordId);
		if (effect.sourceRecordId !== undefined)
			recordIds.add(effect.sourceRecordId);
	}
	for (const readback of workflow.readback) recordIds.add(readback.recordId);
	const lists = args.contract.lists.filter(
		(list) =>
			elements.has(list.id) ||
			list.selectionWorkflowId === workflow.id ||
			workflow.readback.some((readback) => readback.recordId === list.recordId),
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
	const access = args.contract.access.filter(
		(policy) =>
			elements.has(policy.id) ||
			policy.targets.some(
				(target) =>
					target.id === workflow.id ||
					recordIds.has(target.id) ||
					lists.some((list) => list.id === target.id),
			),
	);
	for (const policy of access) actorIds.add(policy.actorId);
	const navigation = args.contract.navigation.filter(
		(nav) =>
			elements.has(nav.id) ||
			nav.workflowIds.includes(workflow.id) ||
			nav.listIds.some((id) => lists.some((list) => list.id === id)),
	);
	for (const nav of navigation) {
		for (const actorId of nav.actorIds) actorIds.add(actorId);
	}
	const requirementIds = new Set(workflow.externalRequirementIds);
	const prerequisiteIds = new Set(workflow.prerequisiteWorkflowIds);
	const catalog = buildCapabilityCatalog();
	const toolProfile = deriveExecutorToolProfile(executableSlice);
	const areaSet = new Set(toolProfile.blueprintAreas);
	const relevantConstraints = Object.values(PLATFORM_CONSTRAINTS).filter(
		(constraint) =>
			CONSTRAINT_AREAS[constraint.code].some((area) => areaSet.has(area)) ||
			(constraint.code === "HQ_BUILD_RELEASE_NOT_API_DRIVEN" &&
				args.contract.externalRequirements.some(
					(requirement) =>
						requirementIds.has(requirement.id) &&
						requirement.kind === "deployment-readiness",
				)),
	);
	const constructionChecklist = executableSlice.constructionGroups.map(
		(group) => ({
			groupId: group.id,
			groupName: group.name,
			items: group.elements.map((element) => ({
				...element,
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
		constructionGroupIds: executableSlice.constructionGroups.map(
			(group) => group.id,
		),
		constructionChecklist,
		toolProfile,
		workflow,
		prerequisiteWorkflows: args.contract.workflows
			.filter((entry) => prerequisiteIds.has(entry.id))
			.map(({ id, name, goal }) => ({ id, name, goal })),
		actors: args.contract.actors.filter((actor) => actorIds.has(actor.id)),
		records: args.contract.records
			.filter((record) => recordIds.has(record.id))
			.map((record) => ({
				...record,
				properties: record.properties.filter(
					(property) =>
						ownedPropertyIds.has(property.id) ||
						usedPropertyIds.has(property.id),
				),
			})),
		lists,
		access,
		navigation,
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
				(_entry, index) =>
					(index === 0 && areaSet.has("media-references")) ||
					(index === 1 && areaSet.has("lookup-references")) ||
					(index === 2 &&
						(areaSet.has("organization-shape") || areaSet.has("users"))) ||
					(index === 3 &&
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

function jsonSection(
	heading: string,
	members: readonly unknown[],
): string | null {
	if (members.length === 0) return null;
	return section(
		heading,
		members.map((member) => JSON.stringify(member)).join("\n"),
	);
}

export function renderBriefMessage(brief: SliceExecutionBrief): string {
	const blocks: Array<string | null> = [
		section(
			"One-app charter",
			`Name: ${brief.charter.appName}\n${brief.charter.objective}\nDelivery: ${brief.charter.deliveryContext}. This session builds one app in the current Project.`,
		),
		section(
			"This workflow slice",
			[
				`${brief.slice.name} — ${brief.slice.goal}`,
				`Role: ${brief.slice.role}. Risk: ${brief.slice.risk}.`,
				`Complete these construction groups in order: ${brief.slice.constructionGroups.map((group) => `${group.name} (${group.id})`).join(", ")}.`,
				"Use each group id as the coverage identity for the staging batch that implements that group. Do not cite every nested design element as coverage.",
			].join("\n"),
		),
		section(
			"Semantic construction checklist",
			brief.constructionChecklist
				.map(
					(group) =>
						`${group.groupName} (${group.groupId})\n${group.items
							.map(
								(item) => `- [ ] ${item.kind} ${item.id}: ${item.requirement}`,
							)
							.join("\n")}`,
				)
				.join("\n"),
		),
		section(
			"Allowed executor operations",
			`Reads: ${brief.toolProfile.readTools.join(", ") || "none"}.\nMutations: ${brief.toolProfile.mutationTools.join(", ")}.`,
		),
		section("Workflow semantics", JSON.stringify(brief.workflow)),
		jsonSection(
			"Prerequisite workflows already established",
			brief.prerequisiteWorkflows,
		),
		jsonSection("Actors", brief.actors),
		jsonSection("Records and properties", brief.records),
		jsonSection("Lists and searches", brief.lists),
		jsonSection("Access", brief.access),
		jsonSection("Navigation", brief.navigation),
		jsonSection("External requirements", brief.externalRequirements),
		jsonSection("App decisions", brief.decisions),
		jsonSection("App assumptions", brief.assumptions),
		jsonSection("External actions", brief.externalActions),
		section("Capability boundary", JSON.stringify(brief.capabilityBoundary)),
		section(
			"Platform constraints",
			brief.loweringConstraints
				.map((constraint) => `- ${constraint.code}: ${constraint.statement}`)
				.join("\n"),
		),
	];
	return blocks.filter((block): block is string => block !== null).join("\n\n");
}
