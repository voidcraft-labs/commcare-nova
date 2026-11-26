import { createEntryPointProjector } from "@/lib/commcare/entryPointProjection";
import { listIconDestinations } from "@/lib/commcare/listIconAction";
import {
	type BlueprintDoc,
	type Column,
	type EntryPointTarget,
	entryPointTargetLabel,
	type Uuid,
} from "@/lib/domain";

export { entryPointSharesFirstMenuCase } from "@/lib/commcare/validator/rules/formsInMenuAbove";

/** Author-facing selection requirements. Private suite argument names never
 * become addresses on the Builder or shared authoring tool surface. */
export interface EntryPointSelectionRequirement {
	moduleUuid: Uuid;
	caseType: string;
	cardinality: "one" | "multiple";
	maximum: number;
	readonly firstMenuConsumers?: readonly Uuid[];
	readonly destinationConsumers?: readonly Uuid[];
}

export interface EntryPointCreationRequirement {
	readonly name: string;
	readonly operationUuid: Uuid;
	readonly caseType: string;
}
export type EntryPointRequirements =
	| {
			available: true;
			requiredSelections: EntryPointSelectionRequirement[];
			requiredCreations: EntryPointCreationRequirement[];
			availableCreations: EntryPointCreationRequirement[];
	  }
	| { available: false; message: string };

/** Share lowering only within this document read, not across mutable snapshots. */
export function createEntryPointRequirements(doc: BlueprintDoc) {
	const project = createEntryPointProjector(doc);
	return (target: EntryPointTarget): EntryPointRequirements => {
		try {
			const projection = project(target);
			const names = new Map(
				(target.kind === "form"
					? (doc.forms[target.formUuid]?.caseOperations ?? [])
					: []
				).map((row) => [row.uuid, row.id]),
			);
			const creation = (row: {
				operationUuid: Uuid;
				caseType: string;
			}): EntryPointCreationRequirement => ({
				operationUuid: row.operationUuid,
				caseType: row.caseType,
				name: names.get(row.operationUuid) ?? row.caseType,
			});
			return {
				available: true,
				availableCreations: projection.availableCreations.map(creation),
				requiredCreations: projection.requiredCreations.map(creation),
				requiredSelections: projection.requiredSelections.map(
					({
						moduleUuid,
						caseType,
						cardinality,
						maximum,
						firstMenuConsumers,
						destinationConsumers,
					}) => ({
						moduleUuid,
						caseType,
						cardinality,
						maximum,
						...(firstMenuConsumers && { firstMenuConsumers }),
						...(destinationConsumers && { destinationConsumers }),
					}),
				),
			};
		} catch (error) {
			return {
				available: false,
				message:
					error instanceof Error
						? error.message
						: "This entry point cannot be projected.",
			};
		}
	};
}

export function entryPointRequirements(
	doc: BlueprintDoc,
	target: EntryPointTarget,
): EntryPointRequirements {
	return createEntryPointRequirements(doc)(target);
}

/** A form a case list icon may submit, as the Builder offers it. */
export interface ListIconChoice {
	readonly entryPointUuid: Uuid;
	readonly label: string;
}

/** The forms a tap on this column's icon may submit, in deep link order
 * (`lib/commcare/listIconAction.ts::listIconDestinations`). */
export function listIconChoices(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	column: Column,
): readonly ListIconChoice[] {
	const module = doc.modules[moduleUuid];
	if (module === undefined) return [];
	return listIconDestinations(doc, module, column).map((destination) => ({
		entryPointUuid: destination.entryPointUuid,
		label: entryPointTargetLabel(doc, destination.target),
	}));
}
