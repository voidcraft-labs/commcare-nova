/** Deterministic coherence checks for the lean Design Contract. */

import type { z } from "zod";
import type { AppDesignContract } from "@/lib/agent/design/contract";

type Path = Array<string | number>;

export interface DesignIdentityCollision {
	readonly path: Path;
	readonly priorPath: Path;
}

function objectWithId(value: unknown): value is { readonly id: string } {
	return (
		typeof value === "object" &&
		value !== null &&
		"id" in value &&
		typeof value.id === "string"
	);
}

function constructionWorkflowOrder(contract: AppDesignContract): string[] {
	const sourceOrder = new Map(
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
			.sort((left, right) => {
				if (left === contract.charter.initialWorkflowId) return -1;
				if (right === contract.charter.initialWorkflowId) return 1;
				return (sourceOrder.get(left) ?? 0) - (sourceOrder.get(right) ?? 0);
			});
		if (ready.length === 0)
			return contract.workflows.map((workflow) => workflow.id);
		for (const id of ready) {
			remaining.delete(id);
			emitted.push(id);
		}
	}
	return emitted;
}

/**
 * The identity-only proof that is safe on an incomplete authoring workspace.
 * References and collection closure require the final contract, but two
 * declarations may never share one DesignId at any intermediate revision.
 */
function collectDesignIdentities(
	candidate: Record<string, unknown>,
): Array<{ id: string; path: Path }> {
	const identities: Array<{ id: string; path: Path }> = [];
	if (typeof candidate.id === "string")
		identities.push({ id: candidate.id, path: ["id"] });
	const actors = Array.isArray(candidate.actors) ? candidate.actors : [];
	actors.forEach((value, index) => {
		if (objectWithId(value))
			identities.push({ id: value.id, path: ["actors", index, "id"] });
	});
	const records = Array.isArray(candidate.records) ? candidate.records : [];
	records.forEach((value, recordIndex) => {
		if (!objectWithId(value)) return;
		identities.push({
			id: value.id,
			path: ["records", recordIndex, "id"],
		});
		const properties =
			"properties" in value && Array.isArray(value.properties)
				? value.properties
				: [];
		properties.forEach((property, propertyIndex) => {
			if (objectWithId(property))
				identities.push({
					id: property.id,
					path: ["records", recordIndex, "properties", propertyIndex, "id"],
				});
		});
	});
	for (const collection of [
		"workflows",
		"lists",
		"access",
		"navigation",
		"moduleCompositions",
		"externalRequirements",
		"decisions",
		"assumptions",
		"openQuestions",
	] as const) {
		const values = Array.isArray(candidate[collection])
			? candidate[collection]
			: [];
		values.forEach((value, index) => {
			if (objectWithId(value))
				identities.push({ id: value.id, path: [collection, index, "id"] });
		});
	}
	const formCompositions = Array.isArray(candidate.formCompositions)
		? candidate.formCompositions
		: [];
	formCompositions.forEach((value, compositionIndex) => {
		if (!objectWithId(value)) return;
		identities.push({
			id: value.id,
			path: ["formCompositions", compositionIndex, "id"],
		});
		const layout =
			"layout" in value &&
			typeof value.layout === "object" &&
			value.layout !== null
				? (value.layout as Record<string, unknown>)
				: null;
		if (layout === null) return;
		if (layout.kind === "sectioned" && Array.isArray(layout.sections)) {
			layout.sections.forEach((section, sectionIndex) => {
				if (!objectWithId(section)) return;
				identities.push({
					id: section.id,
					path: [
						"formCompositions",
						compositionIndex,
						"layout",
						"sections",
						sectionIndex,
						"id",
					],
				});
				const items =
					"items" in section && Array.isArray(section.items)
						? section.items
						: [];
				items.forEach((item, itemIndex) => {
					if (objectWithId(item))
						identities.push({
							id: item.id,
							path: [
								"formCompositions",
								compositionIndex,
								"layout",
								"sections",
								sectionIndex,
								"items",
								itemIndex,
								"id",
							],
						});
				});
			});
		} else if (Array.isArray(layout.items)) {
			layout.items.forEach((item, itemIndex) => {
				if (objectWithId(item))
					identities.push({
						id: item.id,
						path: [
							"formCompositions",
							compositionIndex,
							"layout",
							"items",
							itemIndex,
							"id",
						],
					});
			});
		}
	});
	return identities;
}

export function designIdentityCollisions(
	candidate: Record<string, unknown>,
): DesignIdentityCollision[] {
	const seen = new Map<string, Path>();
	const collisions: DesignIdentityCollision[] = [];
	for (const identity of collectDesignIdentities(candidate)) {
		const priorPath = seen.get(identity.id);
		if (priorPath === undefined) seen.set(identity.id, identity.path);
		else collisions.push({ path: identity.path, priorPath });
	}
	return collisions;
}

function issue(ctx: z.RefinementCtx, path: Path, message: string): void {
	ctx.addIssue({ code: "custom", path, message });
}

function proveForest(
	members: readonly { id: string; parent?: string }[],
	path: string,
	ctx: z.RefinementCtx,
): void {
	const byId = new Map(members.map((member) => [member.id, member]));
	for (const [index, member] of members.entries()) {
		if (member.parent !== undefined && !byId.has(member.parent)) {
			issue(
				ctx,
				[path, index, "parent"],
				"The parent does not exist in this contract.",
			);
		}
		const seen = new Set<string>();
		let cursor: string | undefined = member.id;
		while (cursor !== undefined) {
			if (seen.has(cursor)) {
				issue(
					ctx,
					[path, index, "parent"],
					"Parent relationships must not form a cycle.",
				);
				break;
			}
			seen.add(cursor);
			cursor = byId.get(cursor)?.parent;
		}
	}
}

export function validateDesignGraph(
	contract: AppDesignContract,
	ctx: z.RefinementCtx,
): void {
	for (const collision of designIdentityCollisions(contract))
		issue(
			ctx,
			collision.path,
			`This id is already used at ${collision.priorPath.join(".")}.`,
		);

	const actors = new Set(contract.actors.map((value) => value.id));
	const records = new Map(contract.records.map((value) => [value.id, value]));
	const properties = new Map(
		contract.records.flatMap((record) =>
			record.properties.map(
				(property) => [property.id, { property, record }] as const,
			),
		),
	);
	const workflows = new Set(contract.workflows.map((value) => value.id));
	const lists = new Set(contract.lists.map((value) => value.id));
	const navigation = new Set(contract.navigation.map((value) => value.id));
	const moduleCompositions = new Map(
		contract.moduleCompositions.map((value) => [value.id, value]),
	);
	const moduleCompositionIndex = new Map(
		contract.moduleCompositions.map((value, index) => [value.id, index]),
	);
	const requirements = new Set(
		contract.externalRequirements.map((value) => value.id),
	);

	const expect = (
		known: ReadonlySet<string> | ReadonlyMap<string, unknown>,
		id: string,
		path: Path,
		kind: string,
	): void => {
		/* The id rides in the message so the loop's rejection renderer can
		 * project it back to the symbol the model wrote — a forward reference
		 * whose element never arrived names itself as its @handle. */
		if (!known.has(id))
			issue(
				ctx,
				path,
				`This ${kind} id (${id}) does not exist in the contract.`,
			);
	};

	contract.charter.includedWorkflowIds.forEach((id, index) => {
		expect(
			workflows,
			id,
			["charter", "includedWorkflowIds", index],
			"workflow",
		);
	});
	expect(
		workflows,
		contract.charter.initialWorkflowId,
		["charter", "initialWorkflowId"],
		"workflow",
	);
	if (
		!contract.charter.includedWorkflowIds.includes(
			contract.charter.initialWorkflowId,
		)
	) {
		issue(
			ctx,
			["charter", "initialWorkflowId"],
			"The initial useful workflow must be included in this app.",
		);
	}
	const initialWorkflow = contract.workflows.find(
		(workflow) => workflow.id === contract.charter.initialWorkflowId,
	);
	if (
		initialWorkflow !== undefined &&
		initialWorkflow.prerequisiteWorkflowIds.length > 0
	) {
		issue(
			ctx,
			["charter", "initialWorkflowId"],
			"The initial workflow must not depend on another workflow.",
		);
	}
	if (
		new Set(contract.charter.includedWorkflowIds).size !==
		contract.workflows.length
	) {
		issue(
			ctx,
			["charter", "includedWorkflowIds"],
			"The one-app charter must include every workflow defined in this contract exactly once.",
		);
	}

	proveForest(
		contract.records.map((value) => ({
			id: value.id,
			parent: value.parentRecordId,
		})),
		"records",
		ctx,
	);
	proveForest(
		contract.navigation.map((value) => ({
			id: value.id,
			parent: value.parentNavigationId,
		})),
		"navigation",
		ctx,
	);

	for (const [workflowIndex, workflow] of contract.workflows.entries()) {
		workflow.actorIds.forEach((id, index) => {
			expect(
				actors,
				id,
				["workflows", workflowIndex, "actorIds", index],
				"actor",
			);
		});
		if (workflow.contextRecordId !== undefined) {
			expect(
				records,
				workflow.contextRecordId,
				["workflows", workflowIndex, "contextRecordId"],
				"record",
			);
		}
		workflow.prerequisiteWorkflowIds.forEach((id, index) => {
			expect(
				workflows,
				id,
				["workflows", workflowIndex, "prerequisiteWorkflowIds", index],
				"workflow",
			);
			if (id === workflow.id)
				issue(
					ctx,
					["workflows", workflowIndex, "prerequisiteWorkflowIds", index],
					"A workflow cannot depend on itself.",
				);
		});
		const handles = new Set<string>();
		for (const [collection, entries] of [
			["inputs", workflow.inputs],
			["decisions", workflow.decisions],
			["recordEffects", workflow.recordEffects],
		] as const) {
			entries.forEach((entry, index) => {
				if (handles.has(entry.handle))
					issue(
						ctx,
						["workflows", workflowIndex, collection, index, "handle"],
						"Workflow-local handles must be unique.",
					);
				handles.add(entry.handle);
			});
		}
		workflow.inputs.forEach((input, index) => {
			if (input.propertyId !== undefined)
				expect(
					properties,
					input.propertyId,
					["workflows", workflowIndex, "inputs", index, "propertyId"],
					"property",
				);
			if (input.propertyId === undefined && input.dataShape === undefined)
				issue(
					ctx,
					["workflows", workflowIndex, "inputs", index, "dataShape"],
					"A form-only input must declare its data shape.",
				);
		});
		workflow.decisions.forEach((decision, decisionIndex) => {
			decision.inputPropertyIds.forEach((id, index) => {
				expect(
					properties,
					id,
					[
						"workflows",
						workflowIndex,
						"decisions",
						decisionIndex,
						"inputPropertyIds",
						index,
					],
					"property",
				);
			});
		});
		workflow.recordEffects.forEach((effect, effectIndex) => {
			expect(
				records,
				effect.recordId,
				["workflows", workflowIndex, "recordEffects", effectIndex, "recordId"],
				"record",
			);
			if (effect.sourceRecordId !== undefined)
				expect(
					records,
					effect.sourceRecordId,
					[
						"workflows",
						workflowIndex,
						"recordEffects",
						effectIndex,
						"sourceRecordId",
					],
					"record",
				);
			effect.writes.forEach((write, writeIndex) => {
				const owner = properties.get(write.propertyId)?.record.id;
				if (owner === undefined)
					expect(
						properties,
						write.propertyId,
						[
							"workflows",
							workflowIndex,
							"recordEffects",
							effectIndex,
							"writes",
							writeIndex,
							"propertyId",
						],
						"property",
					);
				else if (owner !== effect.recordId)
					issue(
						ctx,
						[
							"workflows",
							workflowIndex,
							"recordEffects",
							effectIndex,
							"writes",
							writeIndex,
							"propertyId",
						],
						"A record effect may write only properties of its target record.",
					);
			});
		});
		workflow.readback.forEach((readback, readbackIndex) => {
			expect(
				records,
				readback.recordId,
				["workflows", workflowIndex, "readback", readbackIndex, "recordId"],
				"record",
			);
			readback.propertyIds.forEach((id, index) => {
				const owner = properties.get(id)?.record.id;
				if (owner === undefined)
					expect(
						properties,
						id,
						[
							"workflows",
							workflowIndex,
							"readback",
							readbackIndex,
							"propertyIds",
							index,
						],
						"property",
					);
				else if (owner !== readback.recordId)
					issue(
						ctx,
						[
							"workflows",
							workflowIndex,
							"readback",
							readbackIndex,
							"propertyIds",
							index,
						],
						"Readback properties must belong to the record being shown.",
					);
			});
		});
		workflow.externalRequirementIds.forEach((id, index) => {
			expect(
				requirements,
				id,
				["workflows", workflowIndex, "externalRequirementIds", index],
				"external requirement",
			);
		});
	}

	/* Workflow dependencies must be acyclic. Shared prerequisite closures are
	 * valid, so only a back edge to the active recursion stack is a cycle. */
	const workflowById = new Map<string, AppDesignContract["workflows"][number]>(
		contract.workflows.map((value) => [value.id, value]),
	);
	const workflowState = new Map<string, "active" | "complete">();
	const visitWorkflow = (id: string): boolean => {
		const state = workflowState.get(id);
		if (state === "active") return true;
		if (state === "complete") return false;
		workflowState.set(id, "active");
		const cyclic = (workflowById.get(id)?.prerequisiteWorkflowIds ?? []).some(
			visitWorkflow,
		);
		workflowState.set(id, "complete");
		return cyclic;
	};
	for (const [index, workflow] of contract.workflows.entries()) {
		if (visitWorkflow(workflow.id))
			issue(
				ctx,
				["workflows", index, "prerequisiteWorkflowIds"],
				"Workflow prerequisites must not form a cycle.",
			);
	}

	contract.lists.forEach((list, listIndex) => {
		list.actorIds.forEach((id, index) => {
			expect(actors, id, ["lists", listIndex, "actorIds", index], "actor");
		});
		expect(records, list.recordId, ["lists", listIndex, "recordId"], "record");
		for (const key of [
			"scanPropertyIds",
			"detailPropertyIds",
			"searchPropertyIds",
		] as const) {
			list[key].forEach((id, index) => {
				const owner = properties.get(id)?.record.id;
				if (owner === undefined)
					expect(properties, id, ["lists", listIndex, key, index], "property");
				else if (owner !== list.recordId)
					issue(
						ctx,
						["lists", listIndex, key, index],
						"A list may display or search only properties of its record.",
					);
			});
		}
		if (list.selectionWorkflowId !== undefined)
			expect(
				workflows,
				list.selectionWorkflowId,
				["lists", listIndex, "selectionWorkflowId"],
				"workflow",
			);
	});
	contract.access.forEach((policy, policyIndex) => {
		expect(actors, policy.actorId, ["access", policyIndex, "actorId"], "actor");
		const targetSets = {
			record: new Set(records.keys()),
			workflow: workflows,
			list: lists,
			navigation,
		};
		policy.targets.forEach((target, index) => {
			expect(
				targetSets[target.kind],
				target.id,
				["access", policyIndex, "targets", index, "id"],
				target.kind,
			);
		});
	});
	contract.navigation.forEach((nav, navIndex) => {
		nav.actorIds.forEach((id, index) => {
			expect(actors, id, ["navigation", navIndex, "actorIds", index], "actor");
		});
		nav.workflowIds.forEach((id, index) => {
			expect(
				workflows,
				id,
				["navigation", navIndex, "workflowIds", index],
				"workflow",
			);
		});
		nav.listIds.forEach((id, index) => {
			expect(lists, id, ["navigation", navIndex, "listIds", index], "list");
		});
	});

	const workflowRank = new Map(
		constructionWorkflowOrder(contract).map((id, index) => [id, index]),
	);
	const compositionOwner = (
		composition: AppDesignContract["moduleCompositions"][number],
	): string | undefined =>
		[...composition.workflowIds].sort(
			(left, right) =>
				(workflowRank.get(left) ?? Number.MAX_SAFE_INTEGER) -
				(workflowRank.get(right) ?? Number.MAX_SAFE_INTEGER),
		)[0];
	const referencedAsParent = new Set(
		contract.moduleCompositions.flatMap((composition) =>
			composition.parentModuleCompositionId === undefined
				? []
				: [composition.parentModuleCompositionId],
		),
	);
	const projectedCompositionOrder = contract.moduleCompositions
		.filter(
			(composition) => composition.parentModuleCompositionId === undefined,
		)
		.flatMap((parent) => [
			parent.id,
			...contract.moduleCompositions
				.filter(
					(composition) => composition.parentModuleCompositionId === parent.id,
				)
				.map((composition) => composition.id),
		]);
	if (
		projectedCompositionOrder.length === contract.moduleCompositions.length &&
		projectedCompositionOrder.some(
			(id, index) => id !== contract.moduleCompositions[index]?.id,
		)
	) {
		issue(
			ctx,
			["moduleCompositions"],
			"Module compositions must use parent-first preorder with each parent's child menus contiguous.",
		);
	}

	contract.moduleCompositions.forEach((composition, compositionIndex) => {
		/* Every module is created at its exact accepted sibling position. Its
		 * immediate predecessor therefore has to be owned by this slice or by an
		 * earlier slice. A later-owned predecessor would make the earlier owner —
		 * including the dependency-free materialization root — wait for a module
		 * that cannot exist yet. Reject that ordering in the accepted design rather
		 * than discovering an impossible `after` anchor during execution. */
		const precedingSibling = contract.moduleCompositions
			.slice(0, compositionIndex)
			.filter(
				(candidate) =>
					candidate.parentModuleCompositionId ===
					composition.parentModuleCompositionId,
			)
			.pop();
		if (precedingSibling !== undefined) {
			const precedingOwner = compositionOwner(precedingSibling);
			const owner = compositionOwner(composition);
			if (
				precedingOwner !== undefined &&
				owner !== undefined &&
				(workflowRank.get(precedingOwner) ?? Number.MAX_SAFE_INTEGER) >
					(workflowRank.get(owner) ?? Number.MAX_SAFE_INTEGER)
			) {
				issue(
					ctx,
					["moduleCompositions", compositionIndex, "workflowIds"],
					"A module composition's construction owner must be the same as or later than its preceding sibling's owner so the exact after-sibling anchor exists before this module is built.",
				);
			}
		}
		if (composition.parentModuleCompositionId !== undefined) {
			const parentId = composition.parentModuleCompositionId;
			const parent = moduleCompositions.get(parentId);
			expect(
				moduleCompositions,
				parentId,
				["moduleCompositions", compositionIndex, "parentModuleCompositionId"],
				"parent module composition",
			);
			if (parentId === composition.id) {
				issue(
					ctx,
					["moduleCompositions", compositionIndex, "parentModuleCompositionId"],
					"A module composition cannot contain itself.",
				);
			}
			if (parent?.parentModuleCompositionId !== undefined) {
				issue(
					ctx,
					["moduleCompositions", compositionIndex, "parentModuleCompositionId"],
					"Nova supports one submenu tier, so a child menu cannot contain another child.",
				);
			}
			if (
				(moduleCompositionIndex.get(parentId) ?? Number.MAX_SAFE_INTEGER) >=
				compositionIndex
			) {
				issue(
					ctx,
					["moduleCompositions", compositionIndex, "parentModuleCompositionId"],
					"A parent module composition must appear before its child.",
				);
			}
			if (parent !== undefined) {
				if (
					parent.role === "queue-only" &&
					parent.hostRecordId !== composition.hostRecordId
				) {
					issue(
						ctx,
						["moduleCompositions", compositionIndex, "hostRecordId"],
						"A child menu beneath a queue-only parent must host the same record. A different-record child needs a form-hosting parent so the two case selections can be represented.",
					);
				}
				const parentOwner = compositionOwner(parent);
				const childOwner = compositionOwner(composition);
				if (
					parentOwner !== undefined &&
					childOwner !== undefined &&
					(workflowRank.get(parentOwner) ?? Number.MAX_SAFE_INTEGER) >
						(workflowRank.get(childOwner) ?? Number.MAX_SAFE_INTEGER)
				) {
					issue(
						ctx,
						[
							"moduleCompositions",
							compositionIndex,
							"parentModuleCompositionId",
						],
						"The parent module's construction owner must be the same as or earlier than the child module's owner.",
					);
				}
				if (parentOwner !== undefined && parentOwner === childOwner) {
					const ownsParentSurface =
						parent.listIds.length > 0 ||
						contract.formCompositions.some(
							(form) =>
								form.moduleCompositionId === parent.id &&
								form.workflowId === parentOwner,
						);
					if (!ownsParentSurface) {
						issue(
							ctx,
							[
								"moduleCompositions",
								compositionIndex,
								"parentModuleCompositionId",
							],
							"When a parent and child share a construction owner, that workflow must also own the parent's form or case-list surface so the parent can be created validly before the child.",
						);
					}
				}
			}
		}
		if (
			composition.parentModuleCompositionId !== undefined &&
			referencedAsParent.has(composition.id)
		) {
			issue(
				ctx,
				["moduleCompositions", compositionIndex, "parentModuleCompositionId"],
				"A child menu cannot itself contain child menus.",
			);
		}
		for (const [key, ids] of [
			["workflowIds", composition.workflowIds],
			["actorIds", composition.actorIds],
			["navigationIds", composition.navigationIds],
			["listIds", composition.listIds],
		] as const) {
			if (new Set(ids).size !== ids.length) {
				issue(
					ctx,
					["moduleCompositions", compositionIndex, key],
					"Composition placement identities must not repeat.",
				);
			}
		}
		composition.workflowIds.forEach((id, index) => {
			expect(
				workflows,
				id,
				["moduleCompositions", compositionIndex, "workflowIds", index],
				"workflow",
			);
		});
		if (composition.hostRecordId !== undefined) {
			expect(
				records,
				composition.hostRecordId,
				["moduleCompositions", compositionIndex, "hostRecordId"],
				"record",
			);
		}
		composition.actorIds.forEach((id, index) => {
			expect(
				actors,
				id,
				["moduleCompositions", compositionIndex, "actorIds", index],
				"actor",
			);
		});
		composition.navigationIds.forEach((id, index) => {
			expect(
				navigation,
				id,
				["moduleCompositions", compositionIndex, "navigationIds", index],
				"navigation",
			);
			const nav = contract.navigation.find((entry) => entry.id === id);
			if (
				nav !== undefined &&
				!nav.workflowIds.some((workflowId) =>
					composition.workflowIds.includes(workflowId),
				) &&
				!nav.listIds.some((listId) => composition.listIds.includes(listId))
			) {
				issue(
					ctx,
					["moduleCompositions", compositionIndex, "navigationIds", index],
					"A module's navigation placement must contain one of its workflows or lists.",
				);
			}
		});
		composition.listIds.forEach((id, index) => {
			expect(
				lists,
				id,
				["moduleCompositions", compositionIndex, "listIds", index],
				"list",
			);
			const list = contract.lists.find((entry) => entry.id === id);
			if (
				list !== undefined &&
				composition.hostRecordId !== undefined &&
				list.recordId !== composition.hostRecordId
			) {
				issue(
					ctx,
					["moduleCompositions", compositionIndex, "listIds", index],
					"A module may place only lists for the record it hosts.",
				);
			}
		});
		if (composition.role === "queue-only" && composition.listIds.length === 0) {
			issue(
				ctx,
				["moduleCompositions", compositionIndex, "listIds"],
				"A queue-only module must place at least one accepted list.",
			);
		}
		if (composition.role === "form-host" && composition.listIds.length > 0) {
			issue(
				ctx,
				["moduleCompositions", compositionIndex, "listIds"],
				"A form-host module cannot also place a queue; choose form-and-queue when both are intentional.",
			);
		}
		if (
			composition.role === "form-and-queue" &&
			composition.listIds.length === 0
		) {
			issue(
				ctx,
				["moduleCompositions", compositionIndex, "listIds"],
				"A form-and-queue module must place at least one accepted list.",
			);
		}
	});

	const compositionItems = (
		composition: AppDesignContract["formCompositions"][number],
	) =>
		composition.layout.kind === "sectioned"
			? composition.layout.sections.flatMap((section) => section.items)
			: composition.layout.items;
	const formCompositionsByWorkflow = new Map<
		string,
		AppDesignContract["formCompositions"]
	>();
	contract.formCompositions.forEach((composition, compositionIndex) => {
		expect(
			workflows,
			composition.workflowId,
			["formCompositions", compositionIndex, "workflowId"],
			"workflow",
		);
		expect(
			moduleCompositions,
			composition.moduleCompositionId,
			["formCompositions", compositionIndex, "moduleCompositionId"],
			"module composition",
		);
		const workflow = contract.workflows.find(
			(entry) => entry.id === composition.workflowId,
		);
		const module = moduleCompositions.get(composition.moduleCompositionId);
		if (
			module !== undefined &&
			!module.workflowIds.includes(composition.workflowId)
		) {
			issue(
				ctx,
				["formCompositions", compositionIndex, "moduleCompositionId"],
				"The form's module composition must include this workflow.",
			);
		}
		if (module?.role === "queue-only") {
			issue(
				ctx,
				["formCompositions", compositionIndex, "moduleCompositionId"],
				"A queue-only module cannot host a form.",
			);
		}
		composition.actorIds.forEach((id, index) => {
			expect(
				actors,
				id,
				["formCompositions", compositionIndex, "actorIds", index],
				"actor",
			);
			if (workflow !== undefined && !workflow.actorIds.includes(id)) {
				issue(
					ctx,
					["formCompositions", compositionIndex, "actorIds", index],
					"A form variant may serve only actors assigned to its workflow.",
				);
			}
			if (module !== undefined && !module.actorIds.includes(id)) {
				issue(
					ctx,
					["formCompositions", compositionIndex, "actorIds", index],
					"A form variant's actors must be included in its module placement.",
				);
			}
		});
		if (new Set(composition.actorIds).size !== composition.actorIds.length) {
			issue(
				ctx,
				["formCompositions", compositionIndex, "actorIds"],
				"A form variant may name each actor only once.",
			);
		}
		if (workflow !== undefined && module !== undefined) {
			if (
				(composition.mode === "selected-record" ||
					composition.mode === "close") &&
				(workflow.contextRecordId === undefined ||
					module.hostRecordId !== workflow.contextRecordId)
			) {
				issue(
					ctx,
					["formCompositions", compositionIndex, "mode"],
					"A selected-record or close form must live in a module hosted by the workflow's context record.",
				);
			}
			if (
				composition.mode === "standalone" &&
				(module.hostRecordId !== undefined ||
					workflow.contextRecordId !== undefined)
			) {
				issue(
					ctx,
					["formCompositions", compositionIndex, "mode"],
					"A standalone form must have no selected-record context and live in a module with no record host.",
				);
			}
			if (composition.mode === "registration") {
				const createEffects = workflow.recordEffects.filter(
					(effect) => effect.kind === "create",
				);
				const createdRecordIds = new Set(
					createEffects.map((effect) => effect.recordId),
				);
				if (workflow.contextRecordId !== undefined) {
					issue(
						ctx,
						["formCompositions", compositionIndex, "mode"],
						"A workflow that starts from a selected context record must use a selected-record or close form; a child record it creates is an effect, not the form host.",
					);
				} else if (
					module.hostRecordId === undefined ||
					!createdRecordIds.has(module.hostRecordId)
				) {
					issue(
						ctx,
						["formCompositions", compositionIndex, "mode"],
						"A registration form must live in a module hosted by a record the workflow creates.",
					);
				}
				const conditionalPrimaryCreate = createEffects.find(
					(effect) =>
						effect.recordId === module.hostRecordId &&
						effect.condition !== undefined,
				);
				if (conditionalPrimaryCreate !== undefined) {
					issue(
						ctx,
						["formCompositions", compositionIndex, "mode"],
						"A registration form always creates its hosted record when submitted, so it cannot realize a conditional primary create. Use a standalone form with a conditional create effect when submission must succeed without creating the record, or make the condition a submission-blocking validation.",
					);
				}
			}
			if (
				composition.mode === "close" &&
				!workflow.recordEffects.some(
					(effect) =>
						effect.kind === "close" &&
						effect.recordId === workflow.contextRecordId,
				)
			) {
				issue(
					ctx,
					["formCompositions", compositionIndex, "mode"],
					"A close form must close its selected context record.",
				);
			}
		}

		const inputHandles = compositionItems(composition).flatMap((item) =>
			item.kind === "input" ? [item.inputHandle] : [],
		);
		const expectedInputHandles =
			workflow?.inputs.map((input) => input.handle) ?? [];
		for (const handle of expectedInputHandles) {
			if (inputHandles.filter((entry) => entry === handle).length !== 1) {
				issue(
					ctx,
					["formCompositions", compositionIndex, "layout"],
					`Every complete form variant must place workflow input ${handle} exactly once.`,
				);
			}
		}
		inputHandles.forEach((handle) => {
			if (!expectedInputHandles.includes(handle)) {
				issue(
					ctx,
					["formCompositions", compositionIndex, "layout"],
					`Composition input ${handle} is not declared by this workflow.`,
				);
			}
		});
		compositionItems(composition).forEach((item) => {
			if (item.kind !== "record-summary") return;
			expect(
				records,
				item.recordId,
				["formCompositions", compositionIndex, "layout"],
				"record",
			);
			item.propertyIds.forEach((id) => {
				const owner = properties.get(id)?.record.id;
				if (owner === undefined) {
					expect(
						properties,
						id,
						["formCompositions", compositionIndex, "layout"],
						"property",
					);
				} else if (owner !== item.recordId) {
					issue(
						ctx,
						["formCompositions", compositionIndex, "layout"],
						"A record summary may show only properties of its named record.",
					);
				}
			});
		});
		const current =
			formCompositionsByWorkflow.get(composition.workflowId) ?? [];
		current.push(composition);
		formCompositionsByWorkflow.set(composition.workflowId, current);
	});
	for (const workflow of contract.workflows) {
		const variants = formCompositionsByWorkflow.get(workflow.id) ?? [];
		// Composition was added to schema v1 after reviewed design artifacts had
		// already been persisted. Keep the base graph backward-readable; the
		// construction gate below is what refuses a new accepted revision that
		// has not made these decisions.
		if (variants.length === 0) continue;
		const actorUse = new Map<string, number>();
		for (const variant of variants) {
			for (const actorId of variant.actorIds)
				actorUse.set(actorId, (actorUse.get(actorId) ?? 0) + 1);
		}
		for (const actorId of workflow.actorIds) {
			if ((actorUse.get(actorId) ?? 0) !== 1) {
				issue(
					ctx,
					["formCompositions"],
					`Workflow ${workflow.id} must give actor ${actorId} exactly one complete form variant.`,
				);
			}
		}
		if (variants.length === 1) {
			const variant = variants[0];
			if (variant?.variant !== "shared") {
				issue(
					ctx,
					["formCompositions"],
					`Workflow ${workflow.id} has one form composition, so it must be marked shared.`,
				);
			}
		} else if (variants.length > 1) {
			for (const variant of variants) {
				if (
					variant.variant !== "actor-specific" ||
					variant.duplicateRationale === undefined
				) {
					issue(
						ctx,
						["formCompositions"],
						`Every duplicated form for workflow ${workflow.id} must name its actor distinction and duplicate rationale.`,
					);
				}
			}
		}
	}
	for (const [
		compositionIndex,
		composition,
	] of contract.moduleCompositions.entries()) {
		const hostedForms = contract.formCompositions.filter(
			(form) => form.moduleCompositionId === composition.id,
		);
		if (composition.role === "queue-only" && hostedForms.length > 0) {
			issue(
				ctx,
				["moduleCompositions", compositionIndex, "role"],
				"A queue-only module cannot have form compositions.",
			);
		}
		if (
			(composition.role === "form-host" ||
				composition.role === "form-and-queue") &&
			hostedForms.length === 0
		) {
			issue(
				ctx,
				["moduleCompositions", compositionIndex, "role"],
				"A form-hosting module must contain at least one accepted form composition.",
			);
		}
	}
	contract.externalRequirements.forEach((requirement, requirementIndex) => {
		requirement.relatedWorkflowIds.forEach((id, index) => {
			expect(
				workflows,
				id,
				["externalRequirements", requirementIndex, "relatedWorkflowIds", index],
				"workflow",
			);
		});
		if (requirement.kind === "unsupported" && !requirement.blocksConstruction)
			issue(
				ctx,
				["externalRequirements", requirementIndex, "blocksConstruction"],
				"An unsupported promise must block the affected construction until the design changes.",
			);
		if (
			requirement.blocksConstruction &&
			!contract.openQuestions.some(
				(question) =>
					question.blocking &&
					question.relatedElementIds.includes(requirement.id),
			)
		) {
			issue(
				ctx,
				["externalRequirements", requirementIndex, "blocksConstruction"],
				"A construction-blocking external requirement must remain tied to a blocking user question until it is resolved.",
			);
		}
	});
	const allIds = new Set(
		collectDesignIdentities(contract).map((value) => value.id),
	);
	contract.openQuestions.forEach((question, questionIndex) => {
		question.relatedElementIds.forEach((id, index) => {
			expect(
				allIds,
				id,
				["openQuestions", questionIndex, "relatedElementIds", index],
				"design element",
			);
		});
		if (question.blocking && question.relatedElementIds.length === 0)
			issue(
				ctx,
				["openQuestions", questionIndex, "relatedElementIds"],
				"A blocking question must name the design elements it can change.",
			);
	});
}
