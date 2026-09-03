import { deepEqual } from "@/lib/doc/deepEqual";
import type { Mutation } from "@/lib/doc/types";
import {
	type BlueprintDoc,
	CASE_LOADING_FORM_TYPES,
	type CaseSelection,
	caseSelectionCanFlowBetweenModules,
	formLinkSelectionIsCompatible,
	type Module,
	type Uuid,
} from "@/lib/domain";

export type CaseSelectionChangePlan =
	| {
			readonly ok: true;
			readonly mutations: readonly Mutation[];
			readonly clearsPersistentTile: boolean;
	  }
	| {
			readonly ok: false;
			readonly reason: "missing-case-list";
	  };

/**
 * Plan the one canonical selection edit shared by Builder, SA, and MCP.
 *
 * `undefined` means the ordinary one-case flow and is emitted as an explicit
 * `null` clear so it survives both JSON wires. Enabling multiple selection
 * also removes only `tile.persistOnForms`: that presentation requires a
 * scalar selected case, while the tile itself and any grouping remain valid.
 * Every other compatibility rule stays in the absolute document gate, so a
 * caller receives the same findings on all three authoring surfaces.
 */
export function planCaseSelectionChange(
	module: Pick<Module, "uuid" | "caseListConfig">,
	selection: CaseSelection | undefined,
): CaseSelectionChangePlan {
	const config = module.caseListConfig;
	if (config === undefined) {
		return { ok: false, reason: "missing-case-list" };
	}

	const clearsPersistentTile =
		selection?.kind === "multiple" && config.tile?.persistOnForms === true;
	const selectionChanged = !deepEqual(config.selection, selection);
	if (!selectionChanged && !clearsPersistentTile) {
		return { ok: true, mutations: [], clearsPersistentTile: false };
	}

	const patch: Extract<Mutation, { kind: "setCaseListMeta" }>["patch"] = {};
	if (selectionChanged) {
		patch.selection = selection ?? null;
	}
	if (clearsPersistentTile) {
		const { persistOnForms: _persistOnForms, ...retainedTile } =
			config.tile ?? {};
		patch.tile = structuredClone(retainedTile);
	}

	return {
		ok: true,
		mutations: [{ kind: "setCaseListMeta", uuid: module.uuid, patch }],
		clearsPersistentTile,
	};
}

export interface CaseSelectionTransition {
	readonly moduleUuid: Uuid;
	readonly moduleName: string;
	readonly selection: CaseSelection | undefined;
	readonly clearsPersistentTile: boolean;
	readonly reasons: readonly CaseSelectionTransitionReason[];
}

export type CaseSelectionTransitionReason =
	| {
			readonly kind: "form-link";
			readonly sourceModuleUuid: Uuid;
			readonly sourceModuleName: string;
			readonly sourceFormUuid: Uuid;
			readonly sourceFormName: string;
			readonly linkUuid: Uuid;
			readonly targetModuleUuid: Uuid;
			readonly targetModuleName: string;
			readonly targetFormUuid: Uuid;
			readonly targetFormName: string;
	  }
	| {
			readonly kind: "structural-case-flow";
			readonly parentModuleUuid: Uuid;
			readonly parentModuleName: string;
			readonly childModuleUuid: Uuid;
			readonly childModuleName: string;
	  };

export type CaseSelectionTransitionBlocker =
	| {
			readonly kind: "form-link";
			readonly reason:
				| "authored-datums"
				| "different-case-type"
				| "target-form-not-found"
				| "target-form-not-owned"
				| "target-module-not-found"
				| "selection-not-repairable";
			readonly sourceModuleUuid: Uuid;
			readonly sourceModuleName: string;
			readonly sourceFormUuid: Uuid;
			readonly sourceFormName: string;
			readonly linkUuid: Uuid;
			readonly targetModuleUuid: Uuid;
			readonly targetModuleName: string | undefined;
			readonly targetFormUuid: Uuid;
			readonly targetFormName: string | undefined;
	  }
	| {
			readonly kind: "module";
			readonly reason: "missing-case-list";
			readonly moduleUuid: Uuid;
			readonly moduleName: string;
	  }
	| {
			readonly kind: "structural-case-flow";
			readonly reason: "batch-consumer-not-found";
			readonly parentModuleUuid: Uuid;
			readonly parentModuleName: string;
	  };

export type CaseSelectionTransitionPlan =
	| {
			readonly kind: "ready";
			readonly mutations: readonly Mutation[];
			readonly transitions: readonly CaseSelectionTransition[];
	  }
	| {
			readonly kind: "needs-coordination";
			readonly transitions: readonly CaseSelectionTransition[];
	  }
	| {
			readonly kind: "blocked";
			readonly blockers: readonly CaseSelectionTransitionBlocker[];
	  }
	| {
			readonly kind: "unavailable";
			readonly reason:
				| "module-not-found"
				| "missing-case-list"
				| "duplicate-module"
				| "not-coordinated-module";
			readonly moduleUuid: Uuid;
	  };

function moduleWithSelection(
	module: Module,
	selection: CaseSelection | undefined,
): Module {
	const config = module.caseListConfig;
	if (config === undefined) return module;
	const { selection: _selection, ...configWithoutSelection } = config;
	return {
		...module,
		caseListConfig: {
			...configWithoutSelection,
			...(selection !== undefined && { selection }),
		},
	};
}

interface FormSelectionEdge {
	readonly kind: "form-link";
	readonly sourceModule: Module;
	readonly sourceFormUuid: Uuid;
	readonly sourceFormName: string;
	readonly linkUuid: Uuid;
	readonly targetModule: Module;
	readonly targetFormUuid: Uuid;
	readonly targetFormName: string;
}

interface StructuralSelectionEdge {
	readonly kind: "structural-case-flow";
	readonly sourceModule: Module;
	readonly targetModule: Module;
}

type SelectionEdge = FormSelectionEdge | StructuralSelectionEdge;

interface UnresolvedFormLink {
	readonly sourceModule: Module;
	readonly sourceFormUuid: Uuid;
	readonly sourceFormName: string;
	readonly linkUuid: Uuid;
	readonly targetModuleUuid: Uuid;
	readonly targetModule: Module | undefined;
	readonly targetFormUuid: Uuid;
	readonly targetFormName: string | undefined;
	readonly reason:
		| "authored-datums"
		| "different-case-type"
		| "target-form-not-found"
		| "target-form-not-owned"
		| "target-module-not-found";
}

function selectionOf(
	module: Module,
	projected: ReadonlyMap<Uuid, CaseSelection | undefined>,
): CaseSelection | undefined {
	return projected.has(module.uuid)
		? projected.get(module.uuid)
		: module.caseListConfig?.selection;
}

function isBatchConsumer(module: Module, doc: BlueprintDoc): boolean {
	return (doc.formOrder[module.uuid] ?? []).some((formUuid) => {
		const form = doc.forms[formUuid];
		return form?.type === "followup" || form?.type === "close";
	});
}

function buildFormSelectionEdges(doc: BlueprintDoc): {
	readonly edges: readonly FormSelectionEdge[];
	readonly unresolved: readonly UnresolvedFormLink[];
} {
	const edges: FormSelectionEdge[] = [];
	const unresolved: UnresolvedFormLink[] = [];
	for (const moduleUuid of doc.moduleOrder) {
		const sourceModule = doc.modules[moduleUuid];
		if (sourceModule === undefined) continue;
		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			const sourceForm = doc.forms[formUuid];
			if (
				sourceForm === undefined ||
				!CASE_LOADING_FORM_TYPES.has(sourceForm.type)
			) {
				continue;
			}
			for (const link of sourceForm.formLinks ?? []) {
				if (link.target.type !== "form") continue;
				const targetModule = doc.modules[link.target.moduleUuid];
				const targetForm = doc.forms[link.target.formUuid];
				const base = {
					sourceModule,
					sourceFormUuid: sourceForm.uuid,
					sourceFormName: sourceForm.name,
					linkUuid: link.uuid,
					targetModuleUuid: link.target.moduleUuid,
					targetModule,
					targetFormUuid: link.target.formUuid,
					targetFormName: targetForm?.name,
				};
				if (targetModule === undefined) {
					unresolved.push({ ...base, reason: "target-module-not-found" });
					continue;
				}
				if (targetForm === undefined) {
					unresolved.push({ ...base, reason: "target-form-not-found" });
					continue;
				}
				if (
					!(doc.formOrder[targetModule.uuid] ?? []).includes(targetForm.uuid)
				) {
					unresolved.push({ ...base, reason: "target-form-not-owned" });
					continue;
				}
				if (!CASE_LOADING_FORM_TYPES.has(targetForm.type)) continue;
				if (link.datums !== undefined) {
					unresolved.push({ ...base, reason: "authored-datums" });
					continue;
				}
				if (sourceModule.caseType !== targetModule.caseType) {
					unresolved.push({ ...base, reason: "different-case-type" });
					continue;
				}
				edges.push({
					kind: "form-link",
					sourceModule,
					sourceFormUuid: sourceForm.uuid,
					sourceFormName: sourceForm.name,
					linkUuid: link.uuid,
					targetModule,
					targetFormUuid: targetForm.uuid,
					targetFormName: targetForm.name,
				});
			}
		}
	}
	return { edges, unresolved };
}

function connectedModules(
	sourceModuleUuid: Uuid,
	edges: readonly SelectionEdge[],
): ReadonlySet<Uuid> {
	const connected = new Set<Uuid>([sourceModuleUuid]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const edge of edges) {
			const sourceUuid = edge.sourceModule.uuid;
			const targetUuid = edge.targetModule.uuid;
			if (connected.has(sourceUuid) && !connected.has(targetUuid)) {
				connected.add(targetUuid);
				changed = true;
			}
			if (connected.has(targetUuid) && !connected.has(sourceUuid)) {
				connected.add(sourceUuid);
				changed = true;
			}
		}
	}
	return connected;
}

function solveConnectedSelections(
	doc: BlueprintDoc,
	connected: ReadonlySet<Uuid>,
	edges: readonly SelectionEdge[],
	sourceModuleUuid: Uuid,
	selection: CaseSelection | undefined,
): ReadonlyMap<Uuid, CaseSelection | undefined> {
	const projected = new Map<Uuid, CaseSelection | undefined>();
	if (selection === undefined) {
		for (const moduleUuid of connected) projected.set(moduleUuid, undefined);
		return projected;
	}

	const maxima = new Map<Uuid, number>();
	for (const moduleUuid of connected) {
		const current = doc.modules[moduleUuid]?.caseListConfig?.selection;
		maxima.set(
			moduleUuid,
			current?.kind === "multiple" ? current.maximum : selection.maximum,
		);
	}
	maxima.set(sourceModuleUuid, selection.maximum);

	// The requested source is fixed. Cap every directed ancestor before the
	// forward pass so an existing larger maximum can never force it upward.
	const ancestors = new Set<Uuid>([sourceModuleUuid]);
	let foundAncestor = true;
	while (foundAncestor) {
		foundAncestor = false;
		for (const edge of edges) {
			if (
				connected.has(edge.sourceModule.uuid) &&
				ancestors.has(edge.targetModule.uuid) &&
				!ancestors.has(edge.sourceModule.uuid)
			) {
				ancestors.add(edge.sourceModule.uuid);
				foundAncestor = true;
			}
		}
	}
	for (const moduleUuid of ancestors) {
		if (moduleUuid !== sourceModuleUuid) {
			maxima.set(
				moduleUuid,
				Math.min(
					maxima.get(moduleUuid) ?? selection.maximum,
					selection.maximum,
				),
			);
		}
	}

	let raised = true;
	while (raised) {
		raised = false;
		for (const edge of edges) {
			const sourceUuid = edge.sourceModule.uuid;
			const targetUuid = edge.targetModule.uuid;
			if (!connected.has(sourceUuid) || !connected.has(targetUuid)) continue;
			const sourceMaximum = maxima.get(sourceUuid) ?? selection.maximum;
			const targetMaximum = maxima.get(targetUuid) ?? selection.maximum;
			if (sourceMaximum <= targetMaximum || targetUuid === sourceModuleUuid) {
				continue;
			}
			maxima.set(targetUuid, sourceMaximum);
			raised = true;
		}
	}

	for (const moduleUuid of connected) {
		projected.set(moduleUuid, {
			kind: "multiple",
			maximum: maxima.get(moduleUuid) ?? selection.maximum,
		});
	}
	return projected;
}

function transitionReason(edge: SelectionEdge): CaseSelectionTransitionReason {
	if (edge.kind === "form-link") {
		return {
			kind: "form-link",
			sourceModuleUuid: edge.sourceModule.uuid,
			sourceModuleName: edge.sourceModule.name,
			sourceFormUuid: edge.sourceFormUuid,
			sourceFormName: edge.sourceFormName,
			linkUuid: edge.linkUuid,
			targetModuleUuid: edge.targetModule.uuid,
			targetModuleName: edge.targetModule.name,
			targetFormUuid: edge.targetFormUuid,
			targetFormName: edge.targetFormName,
		};
	}
	return {
		kind: "structural-case-flow",
		parentModuleUuid: edge.sourceModule.uuid,
		parentModuleName: edge.sourceModule.name,
		childModuleUuid: edge.targetModule.uuid,
		childModuleName: edge.targetModule.name,
	};
}

/**
 * Plan the complete selection-only repair closure for one exact source edit.
 *
 * Direct case-loading form links carry selection when they use the same case
 * type and do not author manual datums. Those links are followed in both
 * directions until every affected cardinality and maximum is compatible.
 * When a multiple-selection, case-list-only parent would otherwise lose its
 * batch-consuming child, the compatible structural child flow joins the same
 * closure. Every resulting module edit must be explicitly confirmed before
 * the planner returns one atomic mutation batch.
 *
 * Module links are excluded because they open the destination's own Results
 * screen. A direct form link that cannot be repaired by selection alone is
 * returned with its precise location instead of being hidden behind the final
 * candidate gate.
 */
export function planCaseSelectionTransition(
	doc: BlueprintDoc,
	args: {
		readonly sourceModuleUuid: Uuid;
		readonly selection: CaseSelection | undefined;
		readonly confirmedModuleUuids?: readonly Uuid[];
	},
): CaseSelectionTransitionPlan {
	const sourceModule = doc.modules[args.sourceModuleUuid];
	if (sourceModule === undefined) {
		return {
			kind: "unavailable",
			reason: "module-not-found",
			moduleUuid: args.sourceModuleUuid,
		};
	}
	if (sourceModule.caseListConfig === undefined) {
		return {
			kind: "unavailable",
			reason: "missing-case-list",
			moduleUuid: args.sourceModuleUuid,
		};
	}

	const confirmed = args.confirmedModuleUuids ?? [];
	const confirmedSet = new Set(confirmed);
	if (
		confirmedSet.size !== confirmed.length ||
		confirmedSet.has(args.sourceModuleUuid)
	) {
		return {
			kind: "unavailable",
			reason: "duplicate-module",
			moduleUuid:
				confirmed.find(
					(uuid, index) =>
						uuid === args.sourceModuleUuid || confirmed.indexOf(uuid) !== index,
				) ?? args.sourceModuleUuid,
		};
	}

	const { edges: formEdges, unresolved } = buildFormSelectionEdges(doc);
	const edges: SelectionEdge[] = [...formEdges];
	const structuralEdgeKeys = new Set<string>();
	let connected = connectedModules(args.sourceModuleUuid, edges);
	let projected = solveConnectedSelections(
		doc,
		connected,
		edges,
		args.sourceModuleUuid,
		args.selection,
	);

	// A case-list-only parent needs only one compatible batch-consuming child.
	// If none survives the projected change, join every selection-repairable
	// candidate to the explicit closure rather than choosing a workflow silently.
	let addedStructuralEdge = true;
	while (addedStructuralEdge) {
		addedStructuralEdge = false;
		const relevantParents = new Set<Uuid>();
		for (const moduleUuid of connected) {
			const module = doc.modules[moduleUuid];
			if (module?.caseListOnly === true) relevantParents.add(moduleUuid);
			if (module?.parentModuleUuid !== undefined) {
				const parent = doc.modules[module.parentModuleUuid];
				if (parent?.caseListOnly === true) relevantParents.add(parent.uuid);
			}
		}

		const structuralBlockers: CaseSelectionTransitionBlocker[] = [];
		for (const parentUuid of relevantParents) {
			const parent = doc.modules[parentUuid];
			if (parent === undefined) continue;
			const projectedParent = moduleWithSelection(
				parent,
				selectionOf(parent, projected),
			);
			if (
				projectedParent.caseListConfig?.selection?.kind !== "multiple" ||
				isBatchConsumer(projectedParent, doc)
			) {
				continue;
			}

			const childConsumers = doc.moduleOrder.flatMap((moduleUuid) => {
				const child = doc.modules[moduleUuid];
				return child?.parentModuleUuid === parent.uuid &&
					child.caseType === parent.caseType &&
					isBatchConsumer(child, doc)
					? [child]
					: [];
			});
			const hasCompatibleChild = childConsumers.some((child) =>
				caseSelectionCanFlowBetweenModules(
					projectedParent,
					moduleWithSelection(child, selectionOf(child, projected)),
				),
			);
			if (hasCompatibleChild) continue;

			const repairableChildren = childConsumers.filter(
				(child) => child.caseListConfig !== undefined,
			);
			if (repairableChildren.length === 0) {
				structuralBlockers.push({
					kind: "structural-case-flow",
					reason: "batch-consumer-not-found",
					parentModuleUuid: parent.uuid,
					parentModuleName: parent.name,
				});
				continue;
			}
			for (const child of repairableChildren) {
				const key = `${parent.uuid}:${child.uuid}`;
				if (structuralEdgeKeys.has(key)) continue;
				structuralEdgeKeys.add(key);
				edges.push({
					kind: "structural-case-flow",
					sourceModule: parent,
					targetModule: child,
				});
				addedStructuralEdge = true;
			}
		}
		if (structuralBlockers.length > 0) {
			return { kind: "blocked", blockers: structuralBlockers };
		}
		if (addedStructuralEdge) {
			connected = connectedModules(args.sourceModuleUuid, edges);
			projected = solveConnectedSelections(
				doc,
				connected,
				edges,
				args.sourceModuleUuid,
				args.selection,
			);
		}
	}

	const blockers: CaseSelectionTransitionBlocker[] = [];
	for (const moduleUuid of connected) {
		const module = doc.modules[moduleUuid];
		if (
			module !== undefined &&
			module.caseListConfig === undefined &&
			selectionOf(module, projected)?.kind === "multiple"
		) {
			blockers.push({
				kind: "module",
				reason: "missing-case-list",
				moduleUuid,
				moduleName: module.name,
			});
		}
	}
	for (const link of unresolved) {
		if (
			!connected.has(link.sourceModule.uuid) &&
			!connected.has(link.targetModuleUuid)
		) {
			continue;
		}
		const source = moduleWithSelection(
			link.sourceModule,
			selectionOf(link.sourceModule, projected),
		);
		const target =
			link.targetModule === undefined
				? undefined
				: moduleWithSelection(
						link.targetModule,
						selectionOf(link.targetModule, projected),
					);
		const remainsCompatible =
			(link.reason === "authored-datums" ||
				link.reason === "different-case-type") &&
			target !== undefined &&
			link.targetFormName !== undefined &&
			formLinkSelectionIsCompatible({
				sourceModule: source,
				targetModule: target,
				sourceLoadsCase: true,
				targetLoadsCase: true,
				hasAuthoredDatums: link.reason === "authored-datums",
			});
		if (remainsCompatible) continue;
		blockers.push({
			kind: "form-link",
			reason: link.reason,
			sourceModuleUuid: link.sourceModule.uuid,
			sourceModuleName: link.sourceModule.name,
			sourceFormUuid: link.sourceFormUuid,
			sourceFormName: link.sourceFormName,
			linkUuid: link.linkUuid,
			targetModuleUuid: link.targetModuleUuid,
			targetModuleName: link.targetModule?.name,
			targetFormUuid: link.targetFormUuid,
			targetFormName: link.targetFormName,
		});
	}
	for (const edge of formEdges) {
		if (
			!connected.has(edge.sourceModule.uuid) &&
			!connected.has(edge.targetModule.uuid)
		) {
			continue;
		}
		const source = moduleWithSelection(
			edge.sourceModule,
			selectionOf(edge.sourceModule, projected),
		);
		const target = moduleWithSelection(
			edge.targetModule,
			selectionOf(edge.targetModule, projected),
		);
		if (
			!formLinkSelectionIsCompatible({
				sourceModule: source,
				targetModule: target,
				sourceLoadsCase: true,
				targetLoadsCase: true,
				hasAuthoredDatums: false,
			})
		) {
			blockers.push({
				kind: "form-link",
				reason: "selection-not-repairable",
				sourceModuleUuid: edge.sourceModule.uuid,
				sourceModuleName: edge.sourceModule.name,
				sourceFormUuid: edge.sourceFormUuid,
				sourceFormName: edge.sourceFormName,
				linkUuid: edge.linkUuid,
				targetModuleUuid: edge.targetModule.uuid,
				targetModuleName: edge.targetModule.name,
				targetFormUuid: edge.targetFormUuid,
				targetFormName: edge.targetFormName,
			});
		}
	}
	if (blockers.length > 0) return { kind: "blocked", blockers };

	const planned = doc.moduleOrder.flatMap((moduleUuid) => {
		if (!connected.has(moduleUuid)) return [];
		const module = doc.modules[moduleUuid];
		if (module === undefined) return [];
		const selection = selectionOf(module, projected);
		const plan = planCaseSelectionChange(module, selection);
		if (
			!plan.ok ||
			(plan.mutations.length === 0 && moduleUuid !== sourceModule.uuid)
		) {
			return [];
		}
		return [{ module, selection, plan }];
	});
	const requiredSet = new Set(
		planned
			.filter((entry) => entry.module.uuid !== sourceModule.uuid)
			.map((entry) => entry.module.uuid),
	);
	const unrecognizedConfirmation = confirmed.find(
		(uuid) => !requiredSet.has(uuid),
	);
	if (unrecognizedConfirmation !== undefined) {
		return {
			kind: "unavailable",
			reason: "not-coordinated-module",
			moduleUuid: unrecognizedConfirmation,
		};
	}

	const mutations: Mutation[] = [];
	const transitions: CaseSelectionTransition[] = [];
	for (const entry of planned) {
		mutations.push(...entry.plan.mutations);
		transitions.push({
			moduleUuid: entry.module.uuid,
			moduleName: entry.module.name,
			selection: entry.selection,
			clearsPersistentTile: entry.plan.clearsPersistentTile,
			reasons: edges
				.filter(
					(edge) =>
						edge.sourceModule.uuid === entry.module.uuid ||
						edge.targetModule.uuid === entry.module.uuid,
				)
				.map(transitionReason),
		});
	}
	const requiredTransitions = transitions.filter(
		(transition) => transition.moduleUuid !== sourceModule.uuid,
	);
	if (
		requiredTransitions.some(
			(transition) => !confirmedSet.has(transition.moduleUuid),
		)
	) {
		return { kind: "needs-coordination", transitions: requiredTransitions };
	}

	return { kind: "ready", mutations, transitions };
}
