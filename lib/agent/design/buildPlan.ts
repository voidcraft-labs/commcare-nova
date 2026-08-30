/**
 * Deterministic BuildPlan v1.
 *
 * Planning is a compiler pass over an accepted lean Design Contract, not a
 * model-authored artifact. The server creates one task-complete slice per
 * workflow, derives dependencies and external actions, and assigns every
 * other semantic element to the earliest workflow that creates, writes,
 * exposes, or protects it. Construction groups describe real units of work;
 * they are the executor's coverage identities and replace mirrored intent
 * ownership/lowering tables.
 */

import { z } from "zod";
import {
	type AppDesignContract,
	designConstructionIssues,
} from "@/lib/agent/design/contract";
import { designIdSchema } from "@/lib/agent/design/ids";
import {
	type BuildPlanLookupBinding,
	type BuildPlanLookupMaterialization,
	buildPlanLookupMaterializationSchema,
} from "@/lib/agent/design/lookupMaterializationTypes";
import { deterministicDesignId } from "@/lib/agent/design/loop/claimSeeding";
import { parentFormChildWriterWorkflowIds } from "@/lib/agent/design/nestedMenuConstruction";

const sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const blueprintAreaSchema = z.enum([
	"app",
	"case-catalog",
	"users",
	"organization-shape",
	"navigation",
	"case-list",
	"forms",
	"case-operations",
	"lookup-references",
	"media-references",
	"automations",
]);
export type BlueprintArea = z.infer<typeof blueprintAreaSchema>;

export const designElementRefSchema = z
	.object({
		kind: z.enum([
			"workflow",
			"actor",
			"record",
			"property",
			"list",
			"access",
			"navigation",
			"module-composition",
			"form-composition",
			"composition-section",
			"composition-item",
		]),
		id: designIdSchema,
	})
	.strict();
export type DesignElementRef = z.infer<typeof designElementRefSchema>;

export const constructionGroupSchema = z
	.object({
		id: designIdSchema,
		workflowId: designIdSchema,
		name: z.string().min(1),
		kind: z.enum(["foundation", "workflow", "work-queue", "access-navigation"]),
		elements: z.array(designElementRefSchema).min(1),
		blueprintAreas: z.array(blueprintAreaSchema).min(1),
	})
	.strict();
export type ConstructionGroup = z.infer<typeof constructionGroupSchema>;

/** External requirements are plan actions, not Blueprint mutations. */
export const externalActionSchema = z
	.object({
		id: designIdSchema,
		requirementId: designIdSchema,
		/** Copied from the requirement so the receipt gate can match evidence
		 * kinds without loading the contract. */
		kind: z.enum([
			"existing-reference",
			"user-prerequisite",
			"runtime-readiness",
			"deployment-readiness",
			"unsupported",
		]),
		/** `blocked` marks a construction-blocking requirement; admission
		 * refuses it until a durable receipt producer exists. */
		timing: z.enum(["blocked", "manual-setup", "after-slice"]),
		description: z.string().min(1),
	})
	.strict();
export type ExternalAction = z.infer<typeof externalActionSchema>;

export const buildSliceRiskSchema = z.enum([
	"ordinary",
	"cross-record",
	"external-effect",
]);
export type BuildSliceRisk = z.infer<typeof buildSliceRiskSchema>;

export const buildSliceSchema = z
	.object({
		id: designIdSchema,
		workflowId: designIdSchema,
		name: z.string().min(1),
		goal: z.string().min(1),
		prerequisiteSliceIds: z.array(designIdSchema),
		constructionGroups: z.array(constructionGroupSchema).min(1),
		externalActionIds: z.array(designIdSchema),
		risk: buildSliceRiskSchema,
		role: z.enum(["materialization-root", "ordinary"]),
	})
	.strict();
export type BuildSlice = z.infer<typeof buildSliceSchema>;

const buildPlanV1BaseSchema = z
	.object({
		schemaVersion: z.literal(1),
		designRevisionId: z.string().uuid(),
		designRevisionDigest: sha256HexSchema,
		id: z.string().uuid(),
		slices: z.array(buildSliceSchema).min(1),
		externalActions: z.array(externalActionSchema),
	})
	.strict();
export type BuildPlanV1 = z.infer<typeof buildPlanV1BaseSchema>;

const buildPlanV2BaseSchema = z
	.object({
		schemaVersion: z.literal(2),
		designRevisionId: z.string().uuid(),
		designRevisionDigest: sha256HexSchema,
		id: z.string().uuid(),
		slices: z.array(buildSliceSchema).min(1),
		externalActions: z.array(externalActionSchema),
		lookupMaterialization: z.union([
			buildPlanLookupMaterializationSchema,
			z.null(),
		]),
	})
	.strict();
export type BuildPlanV2 = z.infer<typeof buildPlanV2BaseSchema>;

const buildPlanBaseSchema = z.discriminatedUnion("schemaVersion", [
	buildPlanV1BaseSchema,
	buildPlanV2BaseSchema,
]);
export type BuildPlan = z.infer<typeof buildPlanBaseSchema>;

function validatePlan(plan: BuildPlan, ctx: z.RefinementCtx): void {
	const sliceIds = new Set<string>();
	const workflowIds = new Set<string>();
	const groupIds = new Set<string>();
	let roots = 0;
	plan.slices.forEach((slice, sliceIndex) => {
		if (sliceIds.has(slice.id)) {
			ctx.addIssue({
				code: "custom",
				path: ["slices", sliceIndex, "id"],
				message: "Slice ids must be unique.",
			});
		}
		sliceIds.add(slice.id);
		if (workflowIds.has(slice.workflowId)) {
			ctx.addIssue({
				code: "custom",
				path: ["slices", sliceIndex, "workflowId"],
				message: "Each workflow must have exactly one slice.",
			});
		}
		workflowIds.add(slice.workflowId);
		if (slice.role === "materialization-root") roots += 1;
		slice.constructionGroups.forEach((group, groupIndex) => {
			if (group.workflowId !== slice.workflowId) {
				ctx.addIssue({
					code: "custom",
					path: [
						"slices",
						sliceIndex,
						"constructionGroups",
						groupIndex,
						"workflowId",
					],
					message: "A construction group belongs to its slice workflow.",
				});
			}
			if (groupIds.has(group.id)) {
				ctx.addIssue({
					code: "custom",
					path: ["slices", sliceIndex, "constructionGroups", groupIndex, "id"],
					message: "Construction group ids must be unique.",
				});
			}
			groupIds.add(group.id);
		});
	});
	if (roots !== 1) {
		ctx.addIssue({
			code: "custom",
			path: ["slices"],
			message: "A build plan requires exactly one materialization root.",
		});
	}
	plan.slices.forEach((slice, sliceIndex) => {
		slice.prerequisiteSliceIds.forEach((id, index) => {
			if (!sliceIds.has(id))
				ctx.addIssue({
					code: "custom",
					path: ["slices", sliceIndex, "prerequisiteSliceIds", index],
					message: "The prerequisite slice does not exist.",
				});
			if (id === slice.id)
				ctx.addIssue({
					code: "custom",
					path: ["slices", sliceIndex, "prerequisiteSliceIds", index],
					message: "A slice cannot depend on itself.",
				});
		});
	});
	const byId = new Map<string, BuildSlice>(
		plan.slices.map((slice) => [slice.id, slice]),
	);
	for (const [sliceIndex, slice] of plan.slices.entries()) {
		const visiting = new Set<string>([slice.id]);
		const cycle = (id: string): boolean => {
			if (visiting.has(id)) return true;
			visiting.add(id);
			const found = (byId.get(id)?.prerequisiteSliceIds ?? []).some(cycle);
			visiting.delete(id);
			return found;
		};
		if (slice.prerequisiteSliceIds.some(cycle))
			ctx.addIssue({
				code: "custom",
				path: ["slices", sliceIndex, "prerequisiteSliceIds"],
				message: "Slice prerequisites must be acyclic.",
			});
	}
}

export const buildPlanSchema = buildPlanBaseSchema.superRefine(validatePlan);

function deriveOwnerByElement(
	contract: AppDesignContract,
	orderedWorkflowIds: readonly string[],
): Map<string, string> {
	const initial = contract.charter.initialWorkflowId;
	const rank = new Map(orderedWorkflowIds.map((id, index) => [id, index]));
	const earliest = (ids: readonly string[]): string =>
		[...ids].sort(
			(a, b) =>
				(rank.get(a) ?? Number.MAX_SAFE_INTEGER) -
				(rank.get(b) ?? Number.MAX_SAFE_INTEGER),
		)[0] ?? initial;
	const ownerByElement = new Map<string, string>();
	const moduleOwnerById = new Map(
		contract.moduleCompositions.map((composition) => [
			composition.id,
			earliest(composition.workflowIds),
		]),
	);
	const moduleOwnersByListId = new Map<string, string[]>();
	for (const composition of contract.moduleCompositions) {
		const moduleOwner = moduleOwnerById.get(composition.id) ?? initial;
		for (const listId of composition.listIds) {
			const owners = moduleOwnersByListId.get(listId) ?? [];
			owners.push(moduleOwner);
			moduleOwnersByListId.set(listId, owners);
		}
	}
	const listOwnerById = new Map(
		contract.lists.map((list) => {
			const containingModuleOwners = moduleOwnersByListId.get(list.id) ?? [];
			const semanticUsers =
				list.selectionWorkflowId !== undefined
					? [list.selectionWorkflowId]
					: contract.workflows
							.filter(
								(workflow) =>
									workflow.contextRecordId === list.recordId ||
									workflow.recordEffects.some(
										(effect) => effect.recordId === list.recordId,
									),
							)
							.map((workflow) => workflow.id);
			return [
				list.id,
				earliest(
					containingModuleOwners.length > 0
						? containingModuleOwners
						: semanticUsers,
				),
			] as const;
		}),
	);
	for (const workflow of contract.workflows)
		ownerByElement.set(workflow.id, workflow.id);
	for (const actor of contract.actors) {
		ownerByElement.set(
			actor.id,
			earliest(
				contract.workflows
					.filter((workflow) => workflow.actorIds.includes(actor.id))
					.map((workflow) => workflow.id),
			),
		);
	}
	for (const record of contract.records) {
		const references = contract.workflows.filter(
			(workflow) =>
				workflow.contextRecordId === record.id ||
				workflow.recordEffects.some(
					(effect) =>
						effect.recordId === record.id ||
						effect.sourceRecordId === record.id,
				) ||
				workflow.readback.some((readback) => readback.recordId === record.id),
		);
		const creators = references.filter((workflow) =>
			workflow.recordEffects.some(
				(effect) => effect.recordId === record.id && effect.kind === "create",
			),
		);
		ownerByElement.set(
			record.id,
			earliest(
				(creators.length > 0 ? creators : references).map(
					(workflow) => workflow.id,
				),
			),
		);
		for (const property of record.properties) {
			const directUsers = contract.workflows.filter(
				(workflow) =>
					workflow.inputs.some((input) => input.propertyId === property.id) ||
					workflow.decisions.some((decision) =>
						decision.inputPropertyIds.includes(property.id),
					) ||
					workflow.recordEffects.some((effect) =>
						effect.writes.some((write) => write.propertyId === property.id),
					) ||
					workflow.readback.some((readback) =>
						readback.propertyIds.includes(property.id),
					),
			);
			const listUsers = contract.lists
				.filter((list) =>
					[
						...list.scanPropertyIds,
						...list.detailPropertyIds,
						...list.searchPropertyIds,
					].includes(property.id),
				)
				.flatMap((list) => {
					const owner = listOwnerById.get(list.id);
					return owner === undefined ? [] : [owner];
				});
			ownerByElement.set(
				property.id,
				earliest([...directUsers.map((workflow) => workflow.id), ...listUsers]),
			);
		}
	}
	for (const list of contract.lists) {
		ownerByElement.set(list.id, listOwnerById.get(list.id) ?? initial);
	}
	for (const nav of contract.navigation) {
		ownerByElement.set(
			nav.id,
			earliest([
				...nav.workflowIds,
				...nav.listIds.map((id) => ownerByElement.get(id) ?? initial),
			]),
		);
	}
	for (const policy of contract.access) {
		ownerByElement.set(
			policy.id,
			earliest(
				policy.targets.map((target) =>
					target.kind === "workflow"
						? target.id
						: (ownerByElement.get(target.id) ?? initial),
				),
			),
		);
	}
	for (const composition of contract.moduleCompositions) {
		ownerByElement.set(
			composition.id,
			moduleOwnerById.get(composition.id) ?? initial,
		);
	}
	for (const composition of contract.formCompositions) {
		ownerByElement.set(composition.id, composition.workflowId);
		if (composition.layout.kind === "sectioned") {
			for (const section of composition.layout.sections) {
				ownerByElement.set(section.id, composition.workflowId);
				for (const item of section.items)
					ownerByElement.set(item.id, composition.workflowId);
			}
		} else {
			for (const item of composition.layout.items)
				ownerByElement.set(item.id, composition.workflowId);
		}
	}
	return ownerByElement;
}

function requiredPrerequisiteWorkflowIds(
	contract: AppDesignContract,
	orderedWorkflowIds: readonly string[],
	ownerByElement: ReadonlyMap<string, string>,
): Map<string, string[]> {
	const required: Map<string, Set<string>> = new Map(
		contract.workflows.map((workflow) => [
			workflow.id,
			new Set<string>(workflow.prerequisiteWorkflowIds),
		]),
	);
	const moduleById = new Map(
		contract.moduleCompositions.map((composition) => [
			composition.id,
			composition,
		]),
	);
	const workflowRank = new Map(
		orderedWorkflowIds.map((workflowId, index) => [workflowId, index]),
	);
	const addPlacementOwner = (
		compositionId: string,
		anchorId: string | undefined,
	): void => {
		if (anchorId === undefined) return;
		const owner = ownerByElement.get(compositionId);
		const anchorOwner = ownerByElement.get(anchorId);
		if (
			owner !== undefined &&
			anchorOwner !== undefined &&
			owner !== anchorOwner
		) {
			required.get(owner)?.add(anchorOwner);
		}
	};
	for (const [
		compositionIndex,
		composition,
	] of contract.moduleCompositions.entries()) {
		const parent =
			composition.parentModuleCompositionId === undefined
				? undefined
				: moduleById.get(composition.parentModuleCompositionId);
		addPlacementOwner(composition.id, parent?.id);
		/* A different-record child consumes a case selection created by the
		 * parent menu's first form. A form-and-queue parent can be born earlier
		 * from its list alone, so depending only on the parent module owner would
		 * let the child run before that form exists. Graph admission proves this
		 * form owner is not later than the child owner. */
		if (
			parent !== undefined &&
			composition.hostRecordId !== undefined &&
			parent.hostRecordId !== composition.hostRecordId
		) {
			const parentFormOwner = contract.formCompositions
				.filter((form) => form.moduleCompositionId === parent.id)
				.map((form) => form.workflowId)
				.sort(
					(left, right) =>
						(workflowRank.get(left) ?? Number.MAX_SAFE_INTEGER) -
						(workflowRank.get(right) ?? Number.MAX_SAFE_INTEGER),
				)[0];
			const childOwner = ownerByElement.get(composition.id);
			if (
				parentFormOwner !== undefined &&
				childOwner !== undefined &&
				parentFormOwner !== childOwner
			) {
				required.get(childOwner)?.add(parentFormOwner);
			}
			/* The Blueprint validator requires a viewer module before any form
			 * creates that case type. When the writer lives in this parent menu,
			 * schedule the child viewer's owner first. If one workflow owns both,
			 * the executor uses the bounded top-level bootstrap and reparents the
			 * child before finalizing the slice. */
			for (const writerWorkflowId of parentFormChildWriterWorkflowIds(
				contract,
				parent.id,
				composition.hostRecordId,
			)) {
				if (childOwner !== undefined && writerWorkflowId !== childOwner) {
					required.get(writerWorkflowId)?.add(childOwner);
				}
			}
		}

		/* `createModule.after` names the exact preceding sibling, so source order
		 * alone is insufficient: the scheduler needs the sibling owner's durable
		 * slice dependency before this slice may run. Graph validation has already
		 * proved that owner is not later, preventing a new cycle or a root that
		 * depends on a later slice. */
		const precedingSibling = contract.moduleCompositions
			.slice(0, compositionIndex)
			.filter(
				(candidate) =>
					candidate.parentModuleCompositionId ===
					composition.parentModuleCompositionId,
			)
			.pop();
		addPlacementOwner(composition.id, precedingSibling?.id);
	}
	return new Map(
		[...required].map(([workflowId, ids]) => [
			workflowId,
			orderedWorkflowIds.filter((id) => ids.has(id)),
		]),
	);
}

function expectedElementKinds(
	contract: AppDesignContract,
): Map<string, DesignElementRef["kind"]> {
	return new Map([
		...contract.actors.map((value) => [value.id, "actor"] as const),
		...contract.records.flatMap((record) => [
			[record.id, "record"] as const,
			...record.properties.map(
				(property) => [property.id, "property"] as const,
			),
		]),
		...contract.workflows.map((value) => [value.id, "workflow"] as const),
		...contract.lists.map((value) => [value.id, "list"] as const),
		...contract.access.map((value) => [value.id, "access"] as const),
		...contract.navigation.map((value) => [value.id, "navigation"] as const),
		...contract.moduleCompositions.map(
			(value) => [value.id, "module-composition"] as const,
		),
		...contract.formCompositions.flatMap((composition) => [
			[composition.id, "form-composition"] as const,
			...(composition.layout.kind === "sectioned"
				? composition.layout.sections.flatMap((section) => [
						[section.id, "composition-section"] as const,
						...section.items.map(
							(item) => [item.id, "composition-item"] as const,
						),
					])
				: composition.layout.items.map(
						(item) => [item.id, "composition-item"] as const,
					)),
		]),
	]);
}

function expectedLookupBindingKinds(
	contract: Extract<AppDesignContract, { schemaVersion: 2 }>,
): ReadonlyMap<string, BuildPlanLookupBinding["kind"]> {
	const expected = new Map<string, BuildPlanLookupBinding["kind"]>();
	for (const table of contract.lookupTables) {
		if (table.kind === "create") {
			expected.set(table.id, "lookup-table");
			for (const column of table.columns)
				expected.set(column.id, "lookup-column");
			continue;
		}
		for (const operation of table.operations) {
			switch (operation.kind) {
				case "add-column":
					expected.set(operation.column.id, "lookup-column");
					break;
				case "add-row":
				case "replace-rows":
					break;
			}
		}
	}
	return expected;
}

/** Contract-bound persisted-read proof. */
export function buildPlanSchemaFor(contract: AppDesignContract) {
	return buildPlanSchema.superRefine((plan, ctx) => {
		if (plan.schemaVersion !== contract.schemaVersion) {
			ctx.addIssue({
				code: "custom",
				path: ["schemaVersion"],
				message:
					"The BuildPlan schema version must match its accepted Design Contract.",
			});
			return;
		}
		if (contract.schemaVersion === 2 && plan.schemaVersion === 2) {
			const expectedBindings = expectedLookupBindingKinds(contract);
			const lookupRequired =
				contract.lookupTables.length > 0 ||
				contract.records.some((record) =>
					record.properties.some(
						(property) => property.choiceSource !== undefined,
					),
				) ||
				contract.workflows.some((workflow) =>
					workflow.inputs.some((input) => input.choiceSource !== undefined),
				);
			if (lookupRequired && plan.lookupMaterialization === null) {
				ctx.addIssue({
					code: "custom",
					path: ["lookupMaterialization"],
					message:
						"Accepted lookup intent requires its durable materialization receipt before planning.",
				});
			}
			if (plan.lookupMaterialization !== null) {
				const seen = new Map<string, string>();
				for (const [
					index,
					binding,
				] of plan.lookupMaterialization.bindings.entries()) {
					const prior = seen.get(binding.designId);
					if (prior !== undefined) {
						ctx.addIssue({
							code: "custom",
							path: ["lookupMaterialization", "bindings", index, "designId"],
							message: `A lookup Design ID may bind exactly once; it is already bound as ${prior}.`,
						});
					}
					seen.set(binding.designId, binding.kind);
					const expectedKind = expectedBindings.get(binding.designId);
					if (expectedKind === undefined) {
						ctx.addIssue({
							code: "custom",
							path: ["lookupMaterialization", "bindings", index, "designId"],
							message:
								"The lookup receipt contains a Design ID that the accepted contract does not materialize.",
						});
					} else if (binding.kind !== expectedKind) {
						ctx.addIssue({
							code: "custom",
							path: ["lookupMaterialization", "bindings", index, "kind"],
							message: `This Design ID requires a ${expectedKind} binding, not ${binding.kind}.`,
						});
					}
				}
				for (const [designId, kind] of expectedBindings) {
					if (seen.has(designId)) continue;
					ctx.addIssue({
						code: "custom",
						path: ["lookupMaterialization", "bindings"],
						message: `The lookup receipt is missing the ${kind} binding for accepted Design ID ${designId}.`,
					});
				}
			}
		}
		/* These are producer invariants for plans derived from an accepted
		 * contract, not v1 wire-format invariants. Earlier v1 producers placed
		 * the app area on every foundation group, so the generic persisted reader
		 * must remain permissive while newly derived plans stay exact. */
		if (plan.slices[0]?.role !== "materialization-root") {
			ctx.addIssue({
				code: "custom",
				path: ["slices", 0, "role"],
				message: "The materialization root must be the first build slice.",
			});
		}
		const appAreaOwners = plan.slices.flatMap((slice, sliceIndex) =>
			slice.constructionGroups.flatMap((group, groupIndex) =>
				group.blueprintAreas.includes("app")
					? [{ sliceIndex, groupIndex }]
					: [],
			),
		);
		if (
			appAreaOwners.length !== 1 ||
			plan.slices[appAreaOwners[0]?.sliceIndex ?? -1]?.role !==
				"materialization-root"
		) {
			ctx.addIssue({
				code: "custom",
				path: ["slices"],
				message:
					"Exactly one construction group must own the app area, and it must belong to the materialization root.",
			});
		}
		const workflowIds = new Set(
			contract.workflows.map((workflow) => workflow.id),
		);
		const constructibleElementIds = new Set<string>([
			...contract.actors.map((value) => value.id),
			...contract.records.flatMap((record) => [
				record.id,
				...record.properties.map((property) => property.id),
			]),
			...contract.workflows.map((value) => value.id),
			...contract.lists.map((value) => value.id),
			...contract.access.map((value) => value.id),
			...contract.navigation.map((value) => value.id),
			...contract.moduleCompositions.map((value) => value.id),
			...contract.formCompositions.flatMap((composition) => [
				composition.id,
				...(composition.layout.kind === "sectioned"
					? composition.layout.sections.flatMap((section) => [
							section.id,
							...section.items.map((item) => item.id),
						])
					: composition.layout.items.map((item) => item.id)),
			]),
		]);
		const assigned = new Map<string, string>();
		const orderedWorkflowIds = workflowOrder(contract);
		const ownerByElement = deriveOwnerByElement(contract, orderedWorkflowIds);
		const requiredPrerequisites = requiredPrerequisiteWorkflowIds(
			contract,
			orderedWorkflowIds,
			ownerByElement,
		);
		const kindsByElement = expectedElementKinds(contract);
		const planWorkflowIds = new Set<string>(
			plan.slices.map((slice) => slice.workflowId),
		);
		for (const workflowId of orderedWorkflowIds) {
			if (!planWorkflowIds.has(workflowId)) {
				ctx.addIssue({
					code: "custom",
					path: ["slices"],
					message: `Included workflow ${workflowId} has no build slice.`,
				});
			}
		}
		if (plan.slices.length !== orderedWorkflowIds.length) {
			ctx.addIssue({
				code: "custom",
				path: ["slices"],
				message:
					"A BuildPlan must contain exactly one slice for every included workflow and no extra slices.",
			});
		}
		const workflowBySliceId = new Map(
			plan.slices.map((entry) => [
				entry.id as string,
				entry.workflowId as string,
			]),
		);
		plan.slices.forEach((slice, sliceIndex) => {
			const actualPrerequisites = slice.prerequisiteSliceIds
				.map((id) => workflowBySliceId.get(id as string))
				.filter((id): id is string => id !== undefined);
			const expectedPrerequisites =
				requiredPrerequisites.get(slice.workflowId) ?? [];
			if (
				actualPrerequisites.length !== expectedPrerequisites.length ||
				actualPrerequisites.some(
					(id, index) => id !== expectedPrerequisites[index],
				)
			) {
				ctx.addIssue({
					code: "custom",
					path: ["slices", sliceIndex, "prerequisiteSliceIds"],
					message:
						"Slice prerequisites must exactly include accepted workflow dependencies, every distinct parent or preceding-sibling module construction owner, the first form owner for a different-record parent menu, and every child viewer required before a parent-menu form creates that child record.",
				});
			}
			if (!workflowIds.has(slice.workflowId))
				ctx.addIssue({
					code: "custom",
					path: ["slices", sliceIndex, "workflowId"],
					message: "This slice workflow is absent from the accepted design.",
				});
			slice.constructionGroups.forEach((group, groupIndex) => {
				group.elements.forEach((element, elementIndex) => {
					if (!constructibleElementIds.has(element.id))
						ctx.addIssue({
							code: "custom",
							path: [
								"slices",
								sliceIndex,
								"constructionGroups",
								groupIndex,
								"elements",
								elementIndex,
								"id",
							],
							message:
								"This construction element is absent from the accepted design.",
						});
					const expectedKind = kindsByElement.get(element.id);
					if (expectedKind !== undefined && element.kind !== expectedKind) {
						ctx.addIssue({
							code: "custom",
							path: [
								"slices",
								sliceIndex,
								"constructionGroups",
								groupIndex,
								"elements",
								elementIndex,
								"kind",
							],
							message: `Design element ${element.id} must retain kind ${expectedKind}.`,
						});
					}
					const ownerWorkflowId = ownerByElement.get(element.id);
					const groupKey =
						element.kind === "actor" ||
						element.kind === "record" ||
						element.kind === "property"
							? "foundation"
							: element.kind === "workflow" ||
									element.kind === "form-composition" ||
									element.kind === "composition-section" ||
									element.kind === "composition-item"
								? "workflow"
								: element.kind === "list"
									? "queues"
									: "access";
					const expectedGroupId =
						ownerWorkflowId === undefined
							? undefined
							: stableId(
									plan.designRevisionDigest,
									`group:${groupKey}`,
									ownerWorkflowId,
								);
					if (
						ownerWorkflowId !== slice.workflowId ||
						expectedGroupId !== group.id
					) {
						ctx.addIssue({
							code: "custom",
							path: [
								"slices",
								sliceIndex,
								"constructionGroups",
								groupIndex,
								"elements",
								elementIndex,
								"id",
							],
							message:
								"This design element is not owned by its deterministic workflow construction group.",
						});
					}
					const owner = assigned.get(element.id);
					if (owner !== undefined && owner !== group.id)
						ctx.addIssue({
							code: "custom",
							path: [
								"slices",
								sliceIndex,
								"constructionGroups",
								groupIndex,
								"elements",
								elementIndex,
								"id",
							],
							message:
								"A semantic element may belong to only one construction group.",
						});
					assigned.set(element.id, group.id);
				});
			});
		});
		for (const id of constructibleElementIds) {
			if (!assigned.has(id))
				ctx.addIssue({
					code: "custom",
					path: ["slices"],
					message: `Design element ${id} is not assigned to a construction group.`,
				});
		}
	});
}

function stableId(
	revisionDigest: string,
	kind: string,
	id: string,
): z.infer<typeof designIdSchema> {
	return designIdSchema.parse(
		deterministicDesignId(`build-plan-v1:${revisionDigest}:${kind}:${id}`),
	);
}

function workflowOrder(contract: AppDesignContract): string[] {
	const initial = contract.charter.initialWorkflowId;
	const order = new Map(
		contract.workflows.map((workflow, index) => [workflow.id, index]),
	);
	const remaining = new Set(contract.workflows.map((workflow) => workflow.id));
	const emitted: string[] = [];
	while (remaining.size > 0) {
		const ready = [...remaining]
			.filter((id) =>
				(
					contract.workflows.find((workflow) => workflow.id === id)
						?.prerequisiteWorkflowIds ?? []
				).every((dependency) => !remaining.has(dependency)),
			)
			.sort((a, b) => {
				if (a === initial) return -1;
				if (b === initial) return 1;
				return (order.get(a) ?? 0) - (order.get(b) ?? 0);
			});
		if (ready.length === 0)
			throw new Error("Accepted design has cyclic workflow prerequisites.");
		for (const id of ready) {
			remaining.delete(id);
			emitted.push(id);
		}
	}
	return emitted;
}

/** Derive the complete BuildPlan from one exact accepted revision. */
export function deriveBuildPlan(args: {
	readonly contract: AppDesignContract;
	readonly revision: { readonly id: string; readonly digest: string };
	readonly planId?: string;
	readonly lookupMaterialization?: BuildPlanLookupMaterialization | null;
}): BuildPlan {
	const { contract, revision } = args;
	const constructionIssues = designConstructionIssues(contract);
	if (constructionIssues.length > 0) {
		throw new Error(
			`Accepted design is not constructible: ${constructionIssues
				.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
				.join("; ")}`,
		);
	}
	const orderedWorkflowIds = workflowOrder(contract);
	const workflowById = new Map<string, AppDesignContract["workflows"][number]>(
		contract.workflows.map((workflow) => [workflow.id, workflow]),
	);
	const initial = contract.charter.initialWorkflowId;
	const ownerByElement = deriveOwnerByElement(contract, orderedWorkflowIds);
	const requiredPrerequisites = requiredPrerequisiteWorkflowIds(
		contract,
		orderedWorkflowIds,
		ownerByElement,
	);
	const refsFor = (
		workflowId: string,
		kinds: DesignElementRef["kind"][],
	): DesignElementRef[] => {
		const refs: DesignElementRef[] = [];
		const push = (kind: DesignElementRef["kind"], id: string): void => {
			if (ownerByElement.get(id) === workflowId && kinds.includes(kind))
				refs.push({ kind, id: designIdSchema.parse(id) });
		};
		contract.actors.forEach((value) => {
			push("actor", value.id);
		});
		contract.records.forEach((record) => {
			push("record", record.id);
			record.properties.forEach((property) => {
				push("property", property.id);
			});
		});
		contract.workflows.forEach((value) => {
			push("workflow", value.id);
		});
		contract.lists.forEach((value) => {
			push("list", value.id);
		});
		contract.access.forEach((value) => {
			push("access", value.id);
		});
		contract.navigation.forEach((value) => {
			push("navigation", value.id);
		});
		contract.moduleCompositions.forEach((value) => {
			push("module-composition", value.id);
		});
		contract.formCompositions.forEach((composition) => {
			push("form-composition", composition.id);
			if (composition.layout.kind === "sectioned") {
				composition.layout.sections.forEach((section) => {
					push("composition-section", section.id);
					section.items.forEach((item) => {
						push("composition-item", item.id);
					});
				});
			} else {
				composition.layout.items.forEach((item) => {
					push("composition-item", item.id);
				});
			}
		});
		return refs;
	};
	const groupsFor = (workflowId: string): ConstructionGroup[] => {
		const workflow = workflowById.get(workflowId);
		const propertyById = new Map(
			contract.records.flatMap((record) =>
				record.properties.map(
					(property) => [property.id as string, property] as const,
				),
			),
		);
		const authoredFeatures = new Set(workflow?.authoredFeatures);
		const formCompositions = contract.formCompositions.filter(
			(composition) => composition.workflowId === workflowId,
		);
		const needsAdvancedCaseOperations =
			(workflow?.recordEffects.length ?? 0) > 1 ||
			(formCompositions.some(
				(composition) => composition.mode === "standalone",
			) &&
				(workflow?.recordEffects.length ?? 0) > 0) ||
			workflow?.recordEffects.some(
				(effect) =>
					effect.kind === "link" ||
					effect.kind === "reassign" ||
					effect.sourceRecordId !== undefined ||
					(workflow.contextRecordId !== undefined &&
						effect.recordId !== workflow.contextRecordId),
			) === true;
		const specs: Array<{
			key: string;
			name: string;
			kind: ConstructionGroup["kind"];
			kinds: DesignElementRef["kind"][];
			areas: (elements: readonly DesignElementRef[]) => BlueprintArea[];
		}> = [
			{
				key: "foundation",
				name: "Data and people",
				kind: "foundation",
				kinds: ["actor", "record", "property"],
				areas: (elements) => [
					...(elements.some(
						(element) =>
							element.kind === "record" || element.kind === "property",
					)
						? (["case-catalog"] as const)
						: []),
					...(elements.some((element) => element.kind === "actor")
						? (["users"] as const)
						: []),
					...(elements.some((element) => {
						if (element.kind !== "property") return false;
						return contract.records.some((record) =>
							record.properties.some(
								(property) =>
									property.id === element.id &&
									property.choiceSource !== undefined,
							),
						);
					})
						? (["lookup-references"] as const)
						: []),
				],
			},
			{
				key: "workflow",
				name: "Workflow",
				kind: "workflow",
				kinds: [
					"workflow",
					"form-composition",
					"composition-section",
					"composition-item",
				],
				areas: (elements) => [
					...(workflowId === initial ? (["app"] as const) : []),
					"forms",
					...(needsAdvancedCaseOperations
						? (["case-operations"] as const)
						: []),
					...(workflow?.inputs.some(
						(input) =>
							input.choiceSource !== undefined ||
							(input.propertyId !== undefined &&
								propertyById.get(input.propertyId as string)?.choiceSource !==
									undefined),
					)
						? (["lookup-references"] as const)
						: []),
					...(authoredFeatures.has("existing-media") ||
					elements.some(
						(element) =>
							element.kind === "form-composition" &&
							contract.formCompositions.some(
								(composition) =>
									composition.id === element.id &&
									composition.icon.kind === "builtin",
							),
					)
						? (["media-references"] as const)
						: []),
					...(authoredFeatures.has("automation")
						? (["automations"] as const)
						: []),
				],
			},
			{
				key: "queues",
				name: "Lists and search",
				kind: "work-queue",
				kinds: ["list"],
				areas: () => ["case-list"],
			},
			{
				key: "access",
				name: "Access and navigation",
				kind: "access-navigation",
				kinds: ["access", "navigation", "module-composition"],
				areas: (elements) => [
					"navigation",
					...(elements.some(
						(element) =>
							element.kind === "module-composition" &&
							contract.moduleCompositions.some(
								(composition) =>
									composition.id === element.id &&
									composition.icon.kind === "builtin",
							),
					)
						? (["media-references"] as const)
						: []),
					...(elements.some((element) => element.kind === "access")
						? (["users"] as const)
						: []),
					...(elements.some((element) => {
						if (element.kind !== "access") return false;
						return contract.access.some(
							(policy) =>
								policy.id === element.id && policy.locationScope !== undefined,
						);
					})
						? (["organization-shape"] as const)
						: []),
				],
			},
		];
		return specs.flatMap((spec) => {
			const elements = refsFor(workflowId, spec.kinds);
			return elements.length === 0
				? []
				: [
						{
							id: stableId(revision.digest, `group:${spec.key}`, workflowId),
							workflowId: designIdSchema.parse(workflowId),
							name: spec.name,
							kind: spec.kind,
							elements,
							blueprintAreas: spec.areas(elements),
						},
					];
		});
	};

	const externalActions: ExternalAction[] = contract.externalRequirements.map(
		(requirement) => ({
			id: stableId(revision.digest, "external-action", requirement.id),
			requirementId: requirement.id,
			kind: requirement.kind,
			timing: requirement.blocksConstruction
				? "blocked"
				: requirement.kind === "deployment-readiness"
					? "manual-setup"
					: "after-slice",
			description: requirement.description,
		}),
	);
	const actionByRequirement = new Map(
		externalActions.map((action) => [action.requirementId, action.id]),
	);
	const sliceIdByWorkflow = new Map(
		orderedWorkflowIds.map((id) => [
			id,
			stableId(revision.digest, "slice", id),
		]),
	);
	const slices: BuildSlice[] = orderedWorkflowIds.map((workflowId) => {
		const workflow = workflowById.get(workflowId);
		if (workflow === undefined)
			throw new Error(`Missing workflow ${workflowId}.`);
		const crossRecord =
			new Set(workflow.recordEffects.map((effect) => effect.recordId)).size >
				1 ||
			workflow.recordEffects.some(
				(effect) => effect.kind === "link" || effect.kind === "reassign",
			);
		return {
			id: sliceIdByWorkflow.get(workflowId) as z.infer<typeof designIdSchema>,
			workflowId: workflow.id,
			name: workflow.name,
			goal: workflow.goal,
			prerequisiteSliceIds: (requiredPrerequisites.get(workflow.id) ?? []).map(
				(id) => sliceIdByWorkflow.get(id) as z.infer<typeof designIdSchema>,
			),
			constructionGroups: groupsFor(workflowId),
			externalActionIds: workflow.externalRequirementIds
				.map((id) => actionByRequirement.get(id))
				.filter((id): id is z.infer<typeof designIdSchema> => id !== undefined),
			risk: crossRecord
				? "cross-record"
				: workflow.externalRequirementIds.length > 0
					? "external-effect"
					: "ordinary",
			role: workflowId === initial ? "materialization-root" : "ordinary",
		};
	});
	const lookupRequired =
		contract.schemaVersion === 2 &&
		(contract.lookupTables.length > 0 ||
			contract.records.some((record) =>
				record.properties.some(
					(property) => property.choiceSource !== undefined,
				),
			) ||
			contract.workflows.some((workflow) =>
				workflow.inputs.some((input) => input.choiceSource !== undefined),
			));
	if (lookupRequired && args.lookupMaterialization == null) {
		throw new Error(
			"Accepted Design Contract v2 lookup intent requires its durable Project-data materialization receipt before planning.",
		);
	}
	return buildPlanSchemaFor(contract).parse({
		schemaVersion: contract.schemaVersion,
		designRevisionId: revision.id,
		designRevisionDigest: revision.digest,
		id: args.planId ?? crypto.randomUUID(),
		slices,
		externalActions,
		...(contract.schemaVersion === 2
			? { lookupMaterialization: args.lookupMaterialization ?? null }
			: {}),
	});
}

/** Environment-dependent admission policy. The v1 schema retains producer-
 * bound blocking-action timings, but this deployment may not persist one
 * until its durable receipt producer is registered. */
export function newPlanAdmissionMessages(
	plan: Pick<BuildPlan, "externalActions">,
): string[] {
	return plan.externalActions.flatMap((action) =>
		action.timing === "blocked"
			? [
					`External action ${action.id} blocks construction, but no registered completion producer can issue its durable receipt. The design must resolve this requirement or defer its workflow before a plan can be admitted.`,
				]
			: [],
	);
}
