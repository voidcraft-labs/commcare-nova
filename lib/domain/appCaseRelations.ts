import type { PersistableDoc } from "./blueprint";
import {
	type CaseRelation,
	CaseRelationCatalog,
	relationMetadata,
} from "./caseRelations";
import type { RelationPath, RelationStep } from "./expression/types";
import { walkExpression } from "./expression/walk";
import { ownRecordValue } from "./records";
import {
	type ExpressionCarrierRef,
	expressionSlotValues,
} from "./referenceSlots";
import type { Uuid } from "./uuid";

interface OwnedRelation {
	origin: string;
	edge: CaseRelation;
	/** Evidence that the receiving HQ editor can independently change. */
	written?: true;
}

/** Each observation names both ends of an index. A qualifier after an
 * unqualified hop names its result without proving which case wrote it. */
export function carrierCaseRelations(
	doc: PersistableDoc,
	uuid: Uuid,
	moduleCaseType?: string,
): OwnedRelation[] {
	const edges: OwnedRelation[] = [];
	const steps = (origin: string | undefined, via: readonly RelationStep[]) => {
		let source = origin;
		for (const step of via) {
			if (source !== undefined && step.throughCaseType !== undefined)
				edges.push({
					origin: source,
					edge: {
						identifier: step.identifier,
						targetType: step.throughCaseType,
					},
				});
			source = step.throughCaseType;
		}
	};
	const path = (origin: string | undefined, via: RelationPath | undefined) => {
		if (via?.kind === "ancestor") steps(origin, via.via);
		else if (
			origin !== undefined &&
			via?.kind === "subcase" &&
			via.ofCaseType !== undefined
		)
			edges.push({
				origin: via.ofCaseType,
				edge: { identifier: via.identifier, targetType: origin },
			});
	};
	const module = ownRecordValue(doc.modules, uuid);
	const form = ownRecordValue(doc.forms, uuid);
	let entity: ExpressionCarrierRef["entity"];
	if (module !== undefined) {
		entity = "module";
		const parent =
			module.parentCaseModuleUuid === undefined
				? undefined
				: ownRecordValue(doc.modules, module.parentCaseModuleUuid)?.caseType;
		if (module.caseType !== undefined && parent !== undefined)
			edges.push({
				origin: module.caseType,
				edge: { identifier: "parent", targetType: parent },
				written: true,
			});
		for (const column of module.caseListConfig?.columns ?? [])
			if (column.kind !== "calculated" && column.via !== undefined)
				steps(module.caseType, column.via);
		for (const input of module.caseListConfig?.searchInputs ?? [])
			if (input.kind === "simple") path(module.caseType, input.via);
	} else if (form !== undefined) {
		entity = "form";
		for (const operation of form.caseOperations ?? []) {
			const origin =
				operation.action === "own"
					? moduleCaseType
					: (operation.retype ?? operation.caseType);
			for (const link of operation.links ?? [])
				if (origin !== undefined && link.target !== null)
					edges.push({
						origin,
						written: true,
						edge: {
							identifier: link.identifier,
							targetType: link.targetType,
							relationship: link.relationship,
						},
					});
			for (const write of operation.writes ?? [])
				if (write.via !== undefined) steps(origin, write.via);
		}
	} else if (ownRecordValue(doc.fields, uuid) !== undefined) {
		entity = "field";
	} else return edges;
	for (const slot of expressionSlotValues(doc, { entity, uuid }))
		walkExpression(slot.expression, {
			visitTerm(term) {
				if (term.kind === "prop") path(term.caseType, term.via);
			},
		});
	return edges;
}

function visitAppRelations(
	doc: PersistableDoc,
	visit: (one: OwnedRelation) => void,
): void {
	const formTypes = new Map<string, string | undefined>();
	for (const [module, forms] of Object.entries(doc.formOrder))
		for (const form of forms)
			if (!formTypes.has(form))
				formTypes.set(form, ownRecordValue(doc.modules, module)?.caseType);
	for (const owners of [doc.modules, doc.forms, doc.fields])
		for (const uuid of Object.keys(owners))
			for (const one of carrierCaseRelations(
				doc,
				uuid as Uuid,
				formTypes.get(uuid),
			))
				visit(one);
}

export function appCaseRelationCatalog(
	doc: PersistableDoc,
): CaseRelationCatalog {
	const graph = new CaseRelationCatalog(doc.caseTypes ?? []);
	visitAppRelations(doc, ({ origin, edge }) => graph.note(origin, edge));
	return graph;
}

/** HQ supplies the current targets of its own link writers and parent menus.
 * Carry only the destinations that the prior app could not tell HQ. This
 * also removes a prior catalog copy of a writer that has since disappeared. */
export function caseRelationsForReadBack(
	doc: PersistableDoc,
): CaseRelationCatalog {
	const incoming = new CaseRelationCatalog([]);
	const retained = new CaseRelationCatalog(doc.caseTypes ?? []);
	visitAppRelations(doc, ({ origin, edge, written }) => {
		if (written) incoming.note(origin, edge);
		else retained.note(origin, edge);
	});
	const result = new CaseRelationCatalog([]);
	for (const type of doc.caseTypes ?? []) {
		for (const edge of retained.edges(type.name)) {
			const sent = incoming.edges(type.name, edge.identifier);
			if (
				!sent.some(
					(one) =>
						one.targetType === edge.targetType &&
						(edge.relationship === undefined ||
							one.relationship === edge.relationship ||
							(one.relationship === undefined &&
								edge.relationship === "child")),
				)
			)
				result.note(type.name, edge);
		}
	}
	return result;
}

export function caseTypesWithRelations(doc: PersistableDoc) {
	const graph = appCaseRelationCatalog(doc);
	return (doc.caseTypes ?? []).map((type) => {
		const { parent_type, relationship, relations, ...rest } = type;
		const derived = relationMetadata(graph.edges(type.name));
		// The absent relationship on an old default parent already means child.
		if (
			parent_type !== undefined &&
			derived.parent_type === parent_type &&
			relationship === undefined &&
			derived.relationship === "child"
		)
			delete derived.relationship;
		return { ...rest, ...derived };
	});
}
