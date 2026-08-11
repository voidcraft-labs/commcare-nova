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
} from "@/lib/agent/design/platformConstraints";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";

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
	const elements = new Set(
		slice.constructionGroups.flatMap((group) =>
			group.elements.map((element) => element.id),
		),
	);
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
	for (const record of args.contract.records) {
		if (
			elements.has(record.id) ||
			record.properties.some((property) => elements.has(property.id))
		) {
			recordIds.add(record.id);
		}
	}
	const lists = args.contract.lists.filter(
		(list) =>
			elements.has(list.id) ||
			list.selectionWorkflowId === workflow.id ||
			workflow.readback.some((readback) => readback.recordId === list.recordId),
	);
	for (const list of lists) {
		recordIds.add(list.recordId);
		for (const actorId of list.actorIds) actorIds.add(actorId);
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
	const requirementIds = new Set(workflow.externalRequirementIds);
	const prerequisiteIds = new Set(workflow.prerequisiteWorkflowIds);
	const catalog = buildCapabilityCatalog();
	return {
		schemaVersion: 1,
		designRevisionId: args.revision.id,
		designRevisionDigest: args.revision.digest,
		buildPlanId: args.plan.id,
		buildPlanDigest: args.planDigest ?? canonicalJsonDigest(args.plan),
		charter: args.contract.charter,
		slice,
		constructionGroupIds: slice.constructionGroups.map((group) => group.id),
		workflow,
		prerequisiteWorkflows: args.contract.workflows
			.filter((entry) => prerequisiteIds.has(entry.id))
			.map(({ id, name, goal }) => ({ id, name, goal })),
		actors: args.contract.actors.filter((actor) => actorIds.has(actor.id)),
		records: args.contract.records.filter((record) => recordIds.has(record.id)),
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
		loweringConstraints: Object.values(PLATFORM_CONSTRAINTS),
		capabilityBoundary: {
			sessionBoundary: catalog.sessionBoundary,
			existingReferenceable: catalog.existingReferenceable,
			externalPrerequisites: catalog.externalPrerequisites,
			unsupported: catalog.unsupported,
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
