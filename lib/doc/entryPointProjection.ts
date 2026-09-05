import { createEntryPointProjector } from "@/lib/commcare/entryPointProjection";
import type { BlueprintDoc, EntryPointTarget, Uuid } from "@/lib/domain";

/** Author-facing selection requirements. Private suite argument names never
 * become addresses on the Builder or shared authoring tool surface. */
export interface EntryPointSelectionRequirement {
	moduleUuid: Uuid;
	caseType: string;
	cardinality: "one" | "multiple";
	maximum: number;
}

export type EntryPointRequirements =
	| { available: true; requiredSelections: EntryPointSelectionRequirement[] }
	| { available: false; message: string };

/** Share lowering only within this document read, not across mutable snapshots. */
export function createEntryPointRequirements(doc: BlueprintDoc) {
	const project = createEntryPointProjector(doc);
	return (target: EntryPointTarget): EntryPointRequirements => {
		try {
			return {
				available: true,
				requiredSelections: project(target).requiredSelections.map(
					({ moduleUuid, caseType, cardinality, maximum }) => ({
						moduleUuid,
						caseType,
						cardinality,
						maximum,
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
