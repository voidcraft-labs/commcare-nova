/** Deterministic coherence checks for the lean Design Contract. */

import type { z } from "zod";
import type { AppDesignContract } from "@/lib/agent/design/contract";

type Path = Array<string | number>;

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
	const identities: Array<{ id: string; path: Path }> = [
		{ id: contract.id, path: ["id"] },
	];
	contract.actors.forEach((value, index) => {
		identities.push({ id: value.id, path: ["actors", index, "id"] });
	});
	contract.records.forEach((record, recordIndex) => {
		identities.push({ id: record.id, path: ["records", recordIndex, "id"] });
		record.properties.forEach((property, propertyIndex) => {
			identities.push({
				id: property.id,
				path: ["records", recordIndex, "properties", propertyIndex, "id"],
			});
		});
	});
	for (const [collection, values] of [
		["workflows", contract.workflows],
		["lists", contract.lists],
		["access", contract.access],
		["navigation", contract.navigation],
		["externalRequirements", contract.externalRequirements],
		["decisions", contract.decisions],
		["assumptions", contract.assumptions],
		["openQuestions", contract.openQuestions],
	] as const) {
		values.forEach((value, index) => {
			identities.push({ id: value.id, path: [collection, index, "id"] });
		});
	}
	const seen = new Map<string, Path>();
	for (const identity of identities) {
		const prior = seen.get(identity.id);
		if (prior !== undefined) {
			issue(
				ctx,
				identity.path,
				`This id is already used at ${prior.join(".")}.`,
			);
		} else {
			seen.set(identity.id, identity.path);
		}
	}

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
	const requirements = new Set(
		contract.externalRequirements.map((value) => value.id),
	);

	const expect = (
		known: ReadonlySet<string> | ReadonlyMap<string, unknown>,
		id: string,
		path: Path,
		kind: string,
	): void => {
		if (!known.has(id))
			issue(ctx, path, `This ${kind} id does not exist in the contract.`);
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
	const allIds = new Set(identities.map((value) => value.id));
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
