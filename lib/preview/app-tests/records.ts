import type { AppTestScope } from "@/lib/db/appTests";
import { noMatchesFormOf } from "@/lib/domain";
import { readCases } from "../engine/caseDataBindingHelpers";
import {
	type ServerSearchWorld,
	serverRecordsRead,
} from "../engine/serverSearchRead";
import { noMatchesFormAdmission } from "../noMatchesForm";
import type { AppTestContext } from "./context";
import { AppTestActionError } from "./errors";
import type { AppTestSessionState } from "./types";

/** The session an App Test's server-side search reads. */
export function appTestSearchWorld(
	context: AppTestContext,
	scope: AppTestScope,
	state: AppTestSessionState,
): ServerSearchWorld {
	return {
		doc: context.doc,
		language: context.language,
		appId: scope.appId,
		identity: context.identity,
		deviceCases: state.deviceCases,
		lookup: context.lookup,
		caseTypeSchemas: context.caseTypeSchemas,
		timeZone: context.clock.timeZone,
		restoreScope: context.restoreScope,
		selections: state.selections,
	};
}

/**
 * A records screen's search and the read its Results run, without the page
 * window (`engine/serverSearchRead.ts`). A search's form reads the same read
 * unpaged (`run.ts::appTestSearchResults`).
 */
export async function prepareAppTestRecords(
	context: AppTestContext,
	scope: AppTestScope,
	state: AppTestSessionState,
	answers?: readonly { name: string; value: string }[],
) {
	const screen = state.screen;
	if (screen.kind !== "records")
		throw new AppTestActionError("Open a record list first.");
	const registeredCaseId =
		answers === undefined ? screen.registeredCaseId : undefined;
	const { search, searched, read, refusal } = await serverRecordsRead(
		appTestSearchWorld(context, scope, state),
		{
			moduleUuid: screen.moduleUuid,
			submitted: screen.searchAnswers,
			entry: screen.searchEntry,
			answers,
			registeredCaseId,
		},
		(reason) =>
			new AppTestActionError(
				reason === "parent-required"
					? "Select the required parent record first."
					: "This menu has no record list.",
			),
	);
	const next = {
		...state,
		screen: {
			...screen,
			searchAnswers: search.submitted,
			searchEntry: { draft: search.draft, errors: search.errors },
			registeredCaseId,
			offset: answers === undefined ? screen.offset : 0,
		},
	};
	return { state: next, search, searched, read, refusal };
}

export async function appTestRecords(
	context: AppTestContext,
	scope: AppTestScope,
	state: AppTestSessionState,
	answers?: readonly { name: string; value: string }[],
) {
	const prepared = await prepareAppTestRecords(context, scope, state, answers);
	const { state: next, search, searched, read, refusal } = prepared;
	const screen = next.screen;
	const result =
		refusal !== undefined
			? ({
					kind: "invalid-search",
					message: refusal,
					repair: "settings",
				} as const)
			: read === undefined
				? undefined
				: await readCases(context.store, {
						...read,
						page: { offset: screen.offset ?? 0, limit: 50 },
					});
	const candidate = noMatchesFormOf(context.doc, screen.moduleUuid);
	// Each action serializes a completed read, so its launch and search share
	// this one attempt. No caller can provide a stale or privileged launch.
	const admission = noMatchesFormAdmission({
		form: candidate,
		moduleUuid: screen.moduleUuid,
		launch: search.hasSubmitted
			? { moduleUuid: screen.moduleUuid, attempt: 0 }
			: undefined,
		searchState:
			search.hasSubmitted &&
			(result?.kind === "empty" || result?.kind === "rows")
				? {
						kind: "completed",
						attempt: 0,
						submission: "app-test-read",
						answers: Object.fromEntries(
							(search.submitted ?? []).map(({ name, value }) => [name, value]),
						),
						matchCount: result.kind === "empty" ? 0 : result.rows.length,
					}
				: undefined,
	});
	return {
		state: next,
		search,
		searched,
		result,
		registration: admission.kind === "admitted" ? candidate : undefined,
	};
}
