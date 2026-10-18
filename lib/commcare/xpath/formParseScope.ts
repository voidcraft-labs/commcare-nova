import type { BlueprintDoc } from "@/lib/domain/blueprint";
import type { LookupDefinitionIndex } from "@/lib/domain/expression/context";
import type { FormStructure } from "@/lib/domain/expression/formStructure";
import type {
	Expression,
	ExpressionSlotRef,
} from "@/lib/domain/expression/types";
import type { FormNodeProjection } from "./formNodeProjection";

export type ResolveFieldPath = (
	segments: readonly string[],
) => string | undefined;

/** One evaluating slot and its complete, rows-free identity scope. */
export interface FormParseScope {
	readonly doc: BlueprintDoc;
	readonly slot: ExpressionSlotRef;
	readonly lookup: LookupDefinitionIndex | "unavailable";
	readonly current?: Expression;
	readonly form?: FormStructure;
	/** Only the raw-snapshot lift supplies an old physical name projection. */
	readonly sourceProjection?: FormNodeProjection;
	readonly authoring?: {
		readonly resolveFormExactName?: ResolveFieldPath;
		readonly resolveFormShortName: ResolveFieldPath;
		readonly selectedCaseType?: string;
	};
}
