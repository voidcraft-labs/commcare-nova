import type { AppTestScope } from "@/lib/db/appTests";
import { validateCaptureSubmissionProjection } from "../engine/captureSubmissionValidation";
import {
	buildSubmissionOperationProgram,
	submissionEnvelopeArgs,
} from "../engine/caseDataBindingHelpers";
import {
	overlayCaseDatabasePatch,
	submissionWorkerValues,
} from "../engine/caseDatabasePatch";
import { evaluateForm, evaluatePostSubmission } from "../engine/evaluateForm";
import { noMatchesPostSubmit } from "../noMatchesForm";
import type { AppTestContext } from "./context";
import { enterAppTestMenu } from "./navigation";
import type { AppTestState } from "./types";

export async function submitAppTest(
	context: AppTestContext,
	scope: AppTestScope & {
		blueprintSeq: number;
		blueprintDigest: string;
		role: string;
	},
	state: AppTestState,
) {
	const screen = state.screen;
	if (screen.kind !== "form" || !screen.entry)
		throw new Error("Open and answer a form before submitting it.");
	const evaluated = await evaluateForm(
		context.doc,
		{
			formUuid: screen.formUuid,
			caseIds: screen.caseIds,
			answers: [],
			searchAnswers: screen.searchAnswers,
		},
		{
			identity: context.identity,
			cases: screen.entryCases,
			lookup: context.lookup,
			entry: screen.entry,
			captureEntry: true,
		},
	);
	if (!evaluated.valid || !evaluated.submission)
		return {
			state: { ...state, screen: { ...screen, entry: evaluated.entry } },
			identity: context.identity,
			effects: undefined,
			validation: evaluated.fields,
		};
	const mutation = evaluated.submission;
	const projection = validateCaptureSubmissionProjection(mutation);
	if (projection.attachmentRefs.length > 0)
		throw new Error(
			"Media capture needs a check in the running app. This test cannot submit attachment bytes.",
		);
	const built = await buildSubmissionOperationProgram({
		appId: scope.appId,
		committedApp: { blueprint: context.doc, mutation_seq: scope.blueprintSeq },
		blueprintDigest: scope.blueprintDigest,
		identity: context.identity,
		viewerTimeZone: context.clock.timeZone,
		lookupScope: {
			projectId: scope.projectId,
			actorId: scope.actorUserId,
			role: scope.role,
		},
		lookupTableSchemas: new Map(
			context.lookup.definitions.map((table) => [
				table.id,
				new Map(table.columns.map((column) => [column.id, column.dataType])),
			]),
		),
		mutation,
		projection,
	});
	const result = await context.store.applySubmission(
		submissionEnvelopeArgs(mutation, scope.appId, built),
	);
	if (!result.caseDatabasePatch)
		throw new Error("The submission did not return its saved record state.");
	const cases = overlayCaseDatabasePatch(
		screen.entryCases,
		result.caseDatabasePatch,
	);
	const identity = {
		...context.identity,
		usercase: submissionWorkerValues(
			result.caseDatabasePatch,
			context.identity.ownerId,
			context.identity.usercase,
		),
	};
	try {
		const registrationReturn =
			mutation.kind === "registration"
				? noMatchesPostSubmit(context.doc.forms[screen.formUuid])
				: undefined;
		if (registrationReturn) {
			return {
				state: {
					...state,
					deviceCases: cases,
					history: [],
					screen:
						registrationReturn === "app_home"
							? { kind: "home" as const }
							: {
									kind: "records" as const,
									moduleUuid: screen.moduleUuid,
									searchAnswers: screen.searchAnswers,
									registeredCaseId: result.primaryCaseIds[0],
								},
				},
				identity,
				effects: result,
				validation: undefined,
			};
		}
		const next = await evaluatePostSubmission(
			context.doc,
			{
				formUuid: screen.formUuid,
				mutation,
				result,
				selections: state.selections,
			},
			{ identity, cases, lookup: context.lookup },
		);
		let nextState: AppTestState = {
			...state,
			selections: next.selections,
			deviceCases: cases,
		};
		switch (next.route.kind) {
			case "unresolvable":
				throw new Error(next.route.reason);
			case "post-submit":
				if (next.route.destination === "app_home")
					nextState = { ...nextState, screen: { kind: "home" }, history: [] };
				else if (next.route.destination === "previous")
					nextState = {
						...nextState,
						screen:
							state.history.at(-1) ??
							enterAppTestMenu(
								{ ...context, identity },
								nextState,
								screen.moduleUuid,
							),
						history: state.history.slice(0, -1),
					};
				else
					nextState = {
						...nextState,
						screen: enterAppTestMenu(
							{ ...context, identity },
							nextState,
							screen.moduleUuid,
						),
					};
				break;
			case "module":
				nextState = {
					...nextState,
					screen: enterAppTestMenu(
						{ ...context, identity },
						nextState,
						next.route.moduleUuid,
					),
					history: [...state.history, screen],
				};
				break;
			case "form": {
				const ids =
					next.collection?.cases.map((row) => row.caseId) ??
					(next.route.carried.kind === "carried"
						? [next.route.carried.caseId]
						: []);
				nextState = {
					...nextState,
					screen: {
						kind: "form",
						moduleUuid: next.route.moduleUuid,
						formUuid: next.route.formUuid,
						caseIds: ids,
						entryCases: cases,
					},
					history: [...state.history, screen],
				};
				break;
			}
		}
		// Like EngineController activation, returning to a form starts a new
		// entry. The back stack records destinations, never resumable answers.
		if (nextState.screen.kind === "form")
			nextState = {
				...nextState,
				screen: { ...nextState.screen, entry: undefined, entryCases: cases },
			};
		return {
			state: nextState,
			identity,
			effects: result,
			validation: undefined,
		};
	} catch (error) {
		// Production saves first and reports a next-screen failure afterward.
		// Preserve that distinction rather than rolling back a successful save.
		return {
			state: {
				...state,
				deviceCases: cases,
				screen: {
					kind: "after-submit" as const,
					moduleUuid: screen.moduleUuid,
					message:
						error instanceof Error
							? error.message
							: "The next task could not be opened.",
				},
			},
			effects: result,
			identity,
			validation: undefined,
		};
	}
}
