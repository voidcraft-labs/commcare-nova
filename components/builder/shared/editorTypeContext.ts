// Presentation catalogs name the choices on screen. Admission always uses
// the actual slot context supplied by the document hook; catalogs never
// reconstruct or widen it. This leaf is shared by React and pure reseeding
// helpers so an event handler uses the same context as the mounted editor.

import type { CaseType, UserProperty } from "@/lib/domain";
import type { ExpressionContext } from "@/lib/domain/expression";
import type { OperationValueScope } from "./expressionEditorSchemas";
import type { EditorFormFieldDecl } from "./formFieldPresentation";
import type {
	EditorLookupTableDecl,
	EditorLookupTableScope,
} from "./lookupTablePresentation";
import type { EditorSearchInputDecl } from "./searchInputPresentation";

/** Shared empty lists so a surface without form answers or a custom
 *  worker catalog keeps one stable identity across renders (the context
 *  memo and the type-context memo both depend on them). */
export const EMPTY_FORM_FIELDS: readonly EditorFormFieldDecl[] = [];
export const EMPTY_USER_PROPERTIES: readonly UserProperty[] = [];

/**
 * Everything an editor scope knows about what its slots may read. Both
 * editor context shapes (`PredicateEditContext` /
 * `ExpressionEditContext`) satisfy it structurally, so a card can hand
 * either one straight to `editorExpressionContext`.
 */
export interface EditorTypeVocabulary {
	readonly expressionContext: ExpressionContext;
	readonly caseTypes: readonly CaseType[];
	readonly currentCaseType: string;
	readonly knownInputs: readonly EditorSearchInputDecl[];
	readonly userProperties?: readonly UserProperty[];
	readonly formFields?: readonly EditorFormFieldDecl[];
	readonly formCaseTypes?: ReadonlySet<string>;
	readonly operationScope?: OperationValueScope | undefined;
	readonly ownerValues?: boolean;
	readonly lookupTables?: readonly EditorLookupTableDecl[];
	readonly tableScope?: EditorLookupTableScope;
	/** See `PredicateEditContext.patternMatching`. */
	readonly patternMatching?: true;
}

/**
 * Read the context already resolved from the owning document slot. Keeping
 * this accessor free of presentation logic prevents a narrowed menu catalog
 * from changing what the checker knows about the saved expression.
 */
export function editorExpressionContext(
	args: EditorTypeVocabulary,
): ExpressionContext {
	return args.expressionContext;
}
