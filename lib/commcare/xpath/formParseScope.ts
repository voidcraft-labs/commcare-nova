import type { BlueprintDoc } from "@/lib/domain/blueprint";
import type {
	ExpressionContext,
	LookupDefinitionIndex,
} from "@/lib/domain/expression/context";
import type { FormStructure } from "@/lib/domain/expression/formStructure";
import type {
	Expression,
	ItextUnit,
	SlotContextRef,
	Term,
} from "@/lib/domain/expression/types";
import type { FormNodeProjection } from "./formNodeProjection";
import type { FormSyntax } from "./formSyntax";

export type ResolveFieldPath = (
	segments: readonly string[],
) => string | undefined;

/** What the parser asks while it reads an app made in CommCare HQ, where the
 *  text is what CommCare runs and its local names are HQ's. */
export interface FormReadingHooks {
	/** The function names the text may call. Any other is `unknown-function`. */
	readonly functions: ReadonlySet<string>;
	/** HQ's itext id to the unit it names in this form. */
	itextUnit(id: string): ItextUnit | undefined;
	/** A declared instance id to its `src`; undefined where the form declares none. */
	instanceSource(id: string): string | undefined;
	/** The calculate of a generated sibling the form reader set aside, by absolute path. */
	generatedValue(path: string): string | undefined;
	/** A fold's proposal for this node, or undefined to bind it plainly. */
	fold(
		node: FormSyntax,
		context: ExpressionContext,
		api: FoldApi,
	): Expression | undefined;
	/** False where a case row's `name` step is the property `name`. */
	readonly caseNameAlias: boolean;
}

/** The binder's own operations, which a fold uses to bind the parts of the
 *  shape it recognized. */
export interface FoldApi {
	bind(node: FormSyntax, context: ExpressionContext): Expression;
	term(value: Term, node: FormSyntax): Expression;
	remember<T extends Expression | Term>(value: T, node: FormSyntax): T;
}

/** One evaluating slot and its complete, rows-free identity scope. A prose
 *  slot is the slot of each calculated value its text holds. */
export interface FormParseScope {
	readonly doc: BlueprintDoc;
	readonly slot: SlotContextRef;
	readonly lookup: LookupDefinitionIndex | "unavailable";
	readonly current?: Expression;
	readonly form?: FormStructure;
	/** The raw-snapshot lift and a reading of CommCare HQ's form supply the
	 *  physical names a source gave its nodes. */
	readonly sourceProjection?: FormNodeProjection;
	readonly authoring?: {
		readonly resolveFormExactName?: ResolveFieldPath;
		readonly resolveFormShortName: ResolveFieldPath;
		readonly selectedCaseType?: string;
	};
	/** Present only while reading an app made in CommCare HQ. */
	readonly reading?: FormReadingHooks;
}
