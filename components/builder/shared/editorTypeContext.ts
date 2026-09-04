// components/builder/shared/editorTypeContext.ts
//
// The ONE place an editor's vocabulary becomes a `TypeContext`.
//
// It lives in its own dependency-free module: every import here is
// type-only: because both halves of the editor need it: the React
// context (`editorContext.tsx`, which re-exports it) and the pure
// cascade-reseed helpers (`cards/reseed.ts`) a card runs inside an event
// handler. Reseed reaching into `editorContext.tsx` would close a cycle
// through `editorSchemas.ts`'s card registry, so the shared function
// sits below both instead.
//
// The axes have OPPOSITE polarity at the checker, which is why "build it
// here" is a rule rather than a convenience: an absent `userPropertySlugs`
// is permissive (an unknown worker property resolves as text), while an
// absent `formFields` is fatal (every form answer resolves to nothing).
// A surface that assembled its own literal and forgot `formFields` would
// silently resolve a form-answer subject to `undefined`, widen every
// dependent slot's accept-set to everything, skip the cascade reseed, and
// commit a type-incorrect comparison the gate then refuses.

import type { CaseType, UserProperty } from "@/lib/domain";
import type { TypeContext } from "@/lib/domain/predicate";
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
 * either one straight to `buildEditorTypeContext`.
 */
export interface EditorTypeVocabulary {
	readonly caseTypes: readonly CaseType[];
	readonly currentCaseType: string;
	readonly knownInputs: readonly EditorSearchInputDecl[];
	readonly userProperties?: readonly UserProperty[];
	readonly formFields?: readonly EditorFormFieldDecl[];
	readonly operationScope?: OperationValueScope | undefined;
	readonly ownerValues?: boolean;
	readonly lookupTables?: readonly EditorLookupTableDecl[];
	readonly tableScope?: EditorLookupTableScope;
	/** See `PredicateEditContext.patternMatching`. */
	readonly patternMatching?: true;
}

/**
 * The `TypeContext` an editor scope resolves against: the same inputs
 * the commit gate's validator composes, so the offered-set and the
 * accept-set cannot drift.
 */
export function buildEditorTypeContext(
	args: EditorTypeVocabulary,
): TypeContext {
	const {
		userProperties = EMPTY_USER_PROPERTIES,
		formFields = EMPTY_FORM_FIELDS,
		operationScope,
		ownerValues = false,
		lookupTables = [],
		tableScope,
		patternMatching,
	} = args;
	return {
		caseTypes: [...args.caseTypes],
		knownInputs: [...args.knownInputs],
		currentCaseType: args.currentCaseType,
		userPropertySlugs: new Map(
			userProperties.map((property) => [property.uuid, property.slug]),
		),
		formFields: new Map(
			formFields.map((field) => [field.uuid, field.dataType]),
		),
		lookupTables: new Map(
			lookupTables.map((table) => [
				table.id,
				new Map(table.columns.map((column) => [column.id, column.dataType])),
			]),
		),
		...(tableScope !== undefined && {
			tableScope: {
				tableId: tableScope.tableId,
				columns: new Map(
					tableScope.columns.map((column) => [column.id, column.dataType]),
				),
			},
		}),
		...(operationScope !== undefined && {
			operationIds: new Set(
				operationScope.creates.map((create) => create.uuid),
			),
		}),
		...(ownerValues && { ownerValues: true }),
		...(patternMatching === true && { patternMatching: true }),
	};
}
