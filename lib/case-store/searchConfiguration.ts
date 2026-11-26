import "server-only";
import type { Transaction } from "kysely";
import {
	AppAccessError,
	resolveAppScopeInTransaction,
} from "@/lib/db/appAccess";
import type { AppDatabase } from "@/lib/db/pg";
import { readPreviewSearchFacts } from "@/lib/deployment/previewSearchSettings";
import {
	type PreviewSearchFacts,
	previewSearchPropertyMatchers,
} from "@/lib/preview/searchSettings";
import type { ResolvedSearchConfiguration } from "./nativeSearchCriteria";
import type { PostgresCaseStoreArgs } from "./postgres/store";

/** The store consumes only the effective facts for the requested case types.
 * App Tests freeze the same facts when they capture the source application. */
export function searchConfigurationFromFacts(
	facts: PreviewSearchFacts,
	caseTypes: readonly string[],
): ResolvedSearchConfiguration {
	return {
		maximum: facts.maximum,
		timeZone: facts.timeZone,
		projectSpace: facts.projectSpace,
		revision: facts.revision,
		matcherFor: (key) => previewSearchPropertyMatchers(facts, caseTypes, key),
	};
}

/** Both stores share the physical connection. An app move or revoked
 * membership must win or lose in the same snapshot as this search. */
export function authorizedSearchConfiguration(
	actorUserId: string,
): NonNullable<PostgresCaseStoreArgs["readSearchConfiguration"]> {
	return async (tx, scope, selector, types) => {
		const access = await resolveAppScopeInTransaction(
			tx as unknown as Transaction<AppDatabase>,
			scope.appId,
			actorUserId,
			"view",
		);
		if (access.projectId !== scope.projectId)
			throw new AppAccessError("not_found");
		const facts = await readPreviewSearchFacts(tx, scope, selector.target);
		return searchConfigurationFromFacts(facts, types);
	};
}
