import type { AppTestScope } from "@/lib/db/appTests";
import type { Uuid } from "@/lib/domain";
import { afterSubmitFrameLanding, appHomeLanding } from "../afterSubmitRouting";
import {
	afterSubmitPath,
	completeAfterSubmit,
	completeAfterSubmitWithOwnFrame,
} from "../afterSubmitStack";
import {
	alwaysOfferedRegistrationReturn,
	caseListRegistrationPostSubmit,
	registeredCaseOnDevice,
	selectionsAfterRegistrationReturn,
} from "../caseListRegistration";
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
import type { FormEvaluationContext } from "../engine/formEvaluationTypes";
import { submittedEntryPath } from "../engine/formLinkEvaluation";
import type { AppTestContext } from "./context";
import { AppTestActionError, expectedAppTestRefusal } from "./errors";
import { enterAppTestMenu } from "./navigation";
import type { AppTestAfterSubmitRoute, AppTestSessionState } from "./types";

export async function submitAppTest(
	context: AppTestContext,
	scope: AppTestScope & {
		blueprintSeq: number;
		blueprintDigest: string;
		role: string;
	},
	state: AppTestSessionState,
	/** The entry's world as the session's form evaluations read it
	 * (`run.ts::appTestFormContext`): its cases with the worker's places, and
	 * what the module's search returned. The after-submit links read it too. */
	formContext: FormEvaluationContext,
) {
	const screen = state.screen;
	if (screen.kind !== "form" || !screen.entry)
		throw new AppTestActionError(
			"Open and answer a form before submitting it.",
		);
	const evaluated = await evaluateForm(
		context.doc,
		{
			formUuid: screen.formUuid,
			language: context.language,
			caseIds: screen.caseIds,
			answers: [],
			searchAnswers: screen.searchAnswers,
		},
		formContext,
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
		throw new AppTestActionError(
			"Media capture needs a check in the running app. This test cannot submit attachment bytes.",
		);
	const built = await buildSubmissionOperationProgram({
		appId: scope.appId,
		committedApp: { blueprint: context.doc, mutation_seq: scope.blueprintSeq },
		blueprintDigest: scope.blueprintDigest,
		identity: context.identity,
		device: context.device,
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
		/* The places of the test's own snapshot, which the form read. An
		 * owner moved to a place is a read of places (`appReadsPlaces`), so a
		 * form that moves one always opened with them. */
		workerPlaceIds: (formContext.cases.locations ?? []).map(
			(place) => place.id,
		),
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
	// A linked task sees the submitting entry plus its own committed effects.
	// The session catalog also retains unrelated records learned by later Sync.
	const deviceCases = overlayCaseDatabasePatch(
		state.deviceCases,
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
	/* The path of the entry this submission completes: its menus, the cases
	 * its entry selected (the form's own from the screen, an inline chooser's
	 * included), and its form. The stack keeps what is pending only while
	 * this path begins with the last landing. */
	const submittedPath = submittedEntryPath({
		doc: context.doc,
		moduleUuid: screen.moduleUuid,
		formUuid: screen.formUuid,
		caseIdsOf: (moduleUuid) =>
			moduleUuid === screen.moduleUuid
				? screen.caseIds
				: (state.selections[moduleUuid]?.cases.map((row) => row.caseId) ?? []),
	});
	try {
		const registrationReturn =
			mutation.kind === "registration"
				? caseListRegistrationPostSubmit(context.doc, screen.formUuid)
				: undefined;
		if (registrationReturn) {
			/* The return frame is pushed and opens like any other frame, so
			 * what was pending stays only while the worker is still on its
			 * path. */
			const afterSubmitStack = completeAfterSubmitWithOwnFrame(
				state.afterSubmitStack,
				submittedPath,
				registrationReturn === "firstMenu"
					? []
					: afterSubmitPath(context.doc, { moduleUuid: screen.moduleUuid }, []),
				context.rules.afterSubmitFrames,
			);
			return {
				state: {
					...state,
					deviceCases,
					afterSubmitStack,
					history: [],
					screen:
						registrationReturn === "firstMenu"
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
		/* A form the record list always offers, opened from its Register
		 * action, returns where that list's frame lands, as the browser's form
		 * does (`alwaysOfferedRegistrationReturn`); its own after-submit, or
		 * an opening any other way, routes as any form does. */
		const launch = screen.caseListRegistrationLaunch;
		const hostCaseType =
			launch === undefined
				? undefined
				: context.doc.modules[launch.hostModuleUuid]?.caseType;
		const createdCase =
			mutation.kind === "registration" &&
			launch !== undefined &&
			result.primaryCaseIds[0] !== undefined
				? registeredCaseOnDevice(
						result.caseDatabasePatch,
						result.primaryCaseIds[0],
						hostCaseType,
					)
				: undefined;
		const registrationLanding = alwaysOfferedRegistrationReturn(
			context.doc,
			screen.formUuid,
			launch,
			createdCase?.caseId,
		);
		if (registrationLanding !== undefined && launch !== undefined) {
			const selections = selectionsAfterRegistrationReturn(
				state.selections,
				registrationLanding,
				launch.hostModuleUuid,
				hostCaseType ?? "",
				createdCase,
			);
			const landingScreen = registrationLanding.screen;
			const afterSubmitStack = completeAfterSubmitWithOwnFrame(
				state.afterSubmitStack,
				submittedPath,
				landingScreen.kind === "first-menu"
					? []
					: afterSubmitPath(
							context.doc,
							{ moduleUuid: landingScreen.moduleUuid },
							Object.entries(selections).map(([moduleUuid, selection]) => ({
								moduleUuid: moduleUuid as Uuid,
								caseIds: selection.cases.map((row) => row.caseId),
							})),
						),
				context.rules.afterSubmitFrames,
			);
			const returned: AppTestSessionState = {
				...state,
				selections,
				deviceCases,
				afterSubmitStack,
				history: [],
			};
			return {
				state: {
					...returned,
					screen:
						landingScreen.kind === "first-menu"
							? { kind: "home" as const }
							: enterAppTestMenu(
									{ ...context, identity },
									returned,
									landingScreen.moduleUuid,
								),
				},
				identity,
				effects: result,
				validation: undefined,
			};
		}
		const pushed = await evaluatePostSubmission(
			context.doc,
			{
				formUuid: screen.formUuid,
				mutation,
				result,
				selections: state.selections,
			},
			{
				identity,
				device: context.device,
				// The places travel with the device's cases; the session state
				// keeps the cases alone, as it does before the submission.
				cases: formContext.cases.locations
					? { ...cases, locations: formContext.cases.locations }
					: cases,
				lookup: context.lookup,
				session: { appId: scope.appId, menuSelections: state.selections },
				...(formContext.searchResults === undefined
					? {}
					: { searchResults: formContext.searchResults }),
			},
		);
		/* The session's platform decides which pushed frame runs: Android
		 * runs the top one and keeps the rest pending, Web Apps opens the top
		 * one alone (`afterSubmitStack.ts`). */
		const completed = completeAfterSubmit(
			state.afterSubmitStack,
			submittedPath,
			pushed.frames.map((frame) => ({
				route: frame,
				landing: afterSubmitFrameLanding({
					doc: context.doc,
					route: frame.route,
					collection: frame.collection,
					sourceModuleUuid: screen.moduleUuid,
					selections: frame.selections,
				}),
			})),
			context.rules.afterSubmitFrames,
		);
		/* Nothing left to run is the app home: the app's first screen in Web
		 * Apps and the phone's home screen on Android (`postSubmitAppHome`). */
		const next: AppTestAfterSubmitRoute = completed.next ?? {
			route: { kind: "post-submit", destination: "app_home" },
			selections: state.selections,
			collection: undefined,
		};
		/* The back stack records destinations; Back opens a fresh entry,
		 * which takes its own search results. */
		const { searchResults: _taken, ...retiredScreen } = screen;
		let nextState: AppTestSessionState = {
			...state,
			selections: next.selections,
			deviceCases,
			afterSubmitStack: completed.state,
		};
		switch (next.route.kind) {
			case "previous-task": {
				const destination = next.route.task.destination;
				nextState = {
					...nextState,
					screen:
						destination.kind === "home"
							? { kind: "home" }
							: destination.kind === "menu"
								? {
										kind: "menu",
										moduleUuid: destination.moduleUuid,
										taskCases: cases,
									}
								: {
										kind: "records",
										moduleUuid: destination.selectingModuleUuids[0],
										formUuid:
											destination.selectingModuleUuids[0] ===
											destination.moduleUuid
												? destination.formUuid
												: undefined,
										returnModules: destination.selectingModuleUuids.slice(1),
										retainedFormTarget: {
											moduleUuid: destination.moduleUuid,
											formUuid: destination.formUuid,
										},
										taskCases: cases,
									},
				};
				break;
			}
			case "unresolvable":
				throw new AppTestActionError(next.route.reason);
			case "post-submit":
				switch (next.route.destination) {
					/* `app_home` opens the app's first screen in Web Apps and the
					 * phone's home screen on Android; `firstMenu` opens the app's
					 * first screen on both. */
					case "app_home":
						nextState = {
							...nextState,
							screen:
								appHomeLanding(context.rules) === "device-home"
									? { kind: "device-home" }
									: { kind: "home" },
							history: [],
						};
						break;
					case "firstMenu":
						nextState = { ...nextState, screen: { kind: "home" }, history: [] };
						break;
					case "previous":
						throw new AppTestActionError(
							"The preceding task was not resolved from the saved entry.",
						);
					case "parentMenu": {
						const parentUuid =
							context.doc.modules[screen.moduleUuid]?.parentModuleUuid;
						if (parentUuid === undefined)
							throw new AppTestActionError(
								"The parent module this form returns to is not in the app.",
							);
						nextState = {
							...nextState,
							screen: enterAppTestMenu(
								{ ...context, identity },
								nextState,
								parentUuid,
							),
						};
						break;
					}
					case "module":
						nextState = {
							...nextState,
							screen: enterAppTestMenu(
								{ ...context, identity },
								nextState,
								screen.moduleUuid,
							),
						};
						break;
				}
				break;
			case "module":
				nextState = {
					...nextState,
					screen: enterAppTestMenu(
						{ ...context, identity },
						nextState,
						next.route.moduleUuid,
					),
					history: [...state.history, retiredScreen],
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
					history: [...state.history, retiredScreen],
				};
				break;
			}
		}
		// Like EngineController activation, returning to a form starts a new
		// entry. The back stack records destinations, never resumable answers.
		if (nextState.screen.kind === "form")
			nextState = {
				...nextState,
				screen: {
					...nextState.screen,
					entry: undefined,
					entryCases: cases,
					searchResults: undefined,
				},
			};
		return {
			state: nextState,
			identity,
			effects: result,
			validation: undefined,
		};
	} catch (error) {
		if (!expectedAppTestRefusal(error)) throw error;
		// Production saves first and reports a next-screen failure afterward.
		// Preserve that distinction rather than rolling back a successful save.
		return {
			state: {
				...state,
				deviceCases,
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
