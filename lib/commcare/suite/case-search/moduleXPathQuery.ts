/**
 * A module's `_xpath_query` composition as every consumer of the emission
 * reads it: each source typed in its own slot's context
 * (`xpathQuery.ts::composeXPathQueryClauses`), and each case chosen before the
 * module's case list step printed under the id the step holds
 * (`formLinkProjection.ts::caseListStepDatumId`). The local suite, HQ JSON
 * and the project-space check thread the same two pieces themselves; this is
 * the one call for a reader that holds only the document, such as Preview's
 * search-input validation.
 */
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { moduleExpressionContexts } from "../../expressionContext";
import { caseListStepDatumId } from "../../formLinkProjection";
import {
	identityLookupWireNaming,
	type LookupWireNaming,
} from "../../lookup/naming";
import {
	buildRuntimeCsqlPromptValidations,
	type ComposedXPathQuery,
	composeXPathQueryEmission,
} from "./xpathQuery";

export function composeModuleXPathQueryEmission(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	options: {
		readonly lookupNaming?: LookupWireNaming;
		readonly searchInputInstanceId?: `search-input:${string}`;
	} = {},
): ComposedXPathQuery | undefined {
	const mod = doc.modules[moduleUuid];
	if (mod?.caseListConfig === undefined) return undefined;
	return composeXPathQueryEmission(
		mod.caseListConfig,
		mod.caseType,
		moduleExpressionContexts(doc, moduleUuid, options.lookupNaming),
		options.lookupNaming,
		options.searchInputInstanceId,
		caseListStepDatumId(doc, moduleUuid),
	);
}

/**
 * The names of the Search fields whose answers the module's search guards
 * itself (`xpathQuery.ts::buildRuntimeCsqlPromptValidations`), which share the
 * field's one check (`searchPrompts.ts::buildValidation`). Which field a guard
 * names reads no table's name, so every table is named by its id. It throws
 * where the search can't be composed, as the composition does.
 */
export function searchGuardedFieldNames(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
): ReadonlySet<string> {
	return new Set(
		buildRuntimeCsqlPromptValidations(
			composeModuleXPathQueryEmission(doc, moduleUuid, {
				lookupNaming: identityLookupWireNaming(),
			}),
		).keys(),
	);
}
