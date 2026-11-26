import { randomUUID } from "node:crypto";
import {
	computeFieldPath,
	findContainingForm,
} from "@/lib/doc/mutations/helpers";
import {
	type BlueprintDoc,
	caseSelectionCardinality,
	caseSelectionMaximum,
	isCaptureFieldKind,
	isContainer,
	moduleFormsReadSearch,
	moduleUuidOfForm,
	reachableCaseTypes,
	resolveAppLanguage,
} from "@/lib/domain";
import {
	formEntryRecord,
	ownFormSelectionIndex,
} from "@/lib/domain/advancedEntryDatums";
import { projectProseTemplate } from "@/lib/domain/prose";
import type { PreviewEntryChoice } from "@/lib/session/types";
import { previewPlatformRules } from "../platform";
import {
	dataRefusalCopy,
	refusalCopy,
	runtimeMessage,
} from "../runtimeMessages";
import { createInProcessXPathWorkerFactory } from "../xpath/inProcessWorkerClient";
import { PreviewXPathRuntimeError } from "../xpath/runtimeError";
import { XPathRuntime } from "../xpath/workerClient";
import { deserializeXPathWorkerValue } from "../xpath/workerProjection";
import type { XPathRuntimeError } from "../xpath/workerProtocol";
import { SetvalueRefusal, type SetvalueRefusalDetails } from "./answerCast";
import { caseDatabaseToFormPreloads } from "./caseDataBindingClient";
import { choiceAnswerDiagnosticMessage } from "./choiceAnswerDiagnostic";
import {
	type PreviewDataRefusal,
	previewDataRefusalOf,
	previewDataRefusalSubject,
	workerFailureError,
} from "./dataRefusal";
import { buildEngineInput } from "./engineInput";
import { entrySessionData } from "./entrySessionData";
import { evaluationAnswerValue } from "./formAnswerValue";
import { FormEngine, type FormEngineAsyncEvaluator } from "./formEngine";
import type {
	FormEvaluationContext,
	FormEvaluationFault,
	FormEvaluationInput,
} from "./formEvaluationTypes";
import {
	FormEvaluationInputError,
	type FormRefusalDetails,
	FormRefusedError,
} from "./formEvaluationTypes";
import { projectFormPresentation } from "./formPresentation";
import { previewSessionValues } from "./identity";
import { previewLookupData } from "./lookupEvaluation";
import { openingCaseAssignments } from "./openingCaseAssignments";
import { searchInputInstanceValues } from "./runtimeBindings";
import { availablePages, pagesToValidate } from "./sectionPaging";
import { formSearchReads } from "./xpathInstances";

/** Let FormEngine apply its narrowly scoped wording policy before an uncaught
 * XPath failure becomes the public authoring-input fault. */
class FormEvaluationXPathError extends PreviewXPathRuntimeError {
	constructor(
		failure: XPathRuntimeError,
		readonly fault: FormEvaluationFault,
	) {
		super(failure);
	}
}

/** A refused setvalue as an evaluation reports it, its sentence naming the
 * question, repeat, record and property the way Preview's own copy does. */
function formRefusal(
	doc: BlueprintDoc,
	details: SetvalueRefusalDetails,
	cases: FormEvaluationContext["cases"],
	language: FormEvaluationInput["language"],
): FormRefusalDetails {
	const label = (uuid: string | undefined) => {
		const field = uuid === undefined ? undefined : doc.fields[uuid];
		return field !== undefined && "label" in field && field.label
			? projectProseTemplate(field.label, doc).text
			: undefined;
	};
	const caseName = cases.rows.find(
		(row) => row.case_id === details.caseId,
	)?.case_name;
	const property = (doc.caseTypes ?? [])
		.find((type) => type.name === details.caseType)
		?.properties.find((candidate) => candidate.name === details.property);
	const copy = refusalCopy(language, details, {
		...(caseName ? { caseName } : {}),
		...(property
			? {
					property: property.label
						? projectProseTemplate(property.label, doc).text || property.name
						: property.name,
				}
			: {}),
		...(label(details.fieldUuid) ? { question: label(details.fieldUuid) } : {}),
		...(label(details.repeatUuid) ? { repeat: label(details.repeatUuid) } : {}),
	});
	return {
		...details,
		kind: "form-refused",
		sentence:
			copy.title === undefined ? copy.body : `${copy.title}. ${copy.body}`,
	};
}

/** Data the device holds none of, as an evaluation reports it: the sentence
 * Preview's refusal shows, naming the persona, question and table. */
function dataRefusalSentence(
	doc: BlueprintDoc,
	refusal: PreviewDataRefusal,
	context: FormEvaluationContext,
	language: FormEvaluationInput["language"],
): string {
	const { reason } = refusal;
	const field =
		reason.kind === "empty-choice-table" && reason.fieldUuid !== undefined
			? doc.fields[reason.fieldUuid]
			: undefined;
	const question =
		field !== undefined && "label" in field && field.label
			? projectProseTemplate(field.label, doc).text
			: undefined;
	const personaUuid = context.identity.personaUuid;
	const worker =
		personaUuid === undefined ? undefined : doc.personas?.[personaUuid]?.name;
	const copy = dataRefusalCopy(
		language,
		refusal.stage,
		previewDataRefusalSubject(reason, previewLookupData(context.lookup)),
		{
			...(worker === undefined ? {} : { worker }),
			...(question ? { question } : {}),
		},
	);
	return `${copy.title}. ${copy.body}`;
}

interface AuthorizedOpening {
	readonly includeActivity: boolean;
	readonly entryKey: string;
	readonly session: import("./entrySessionData").EntrySessionData;
}

type ActivityText = {
	key: string;
	title: string | null;
	window: string | null;
};

/** Observe a form against one captured runtime context. No stores are reachable
 * here. The submission is a proposal; it has not passed a storage transaction. */
export async function evaluateFormSnapshot(
	doc: BlueprintDoc,
	input: FormEvaluationInput,
	context: FormEvaluationContext,
) {
	const result = await runFormSnapshot(doc, input, context);
	if ("opening" in result)
		throw new Error("The snapshot returned an activity opening.");
	return result;
}

/** Finish the one authorized opening world before a worker can answer. */
export async function evaluateAuthorizedFormOpeningSnapshot(
	doc: BlueprintDoc,
	input: FormEvaluationInput,
	context: FormEvaluationContext,
	authorized: AuthorizedOpening,
): Promise<{
	readonly activity?: ActivityText;
	readonly caseCreateIds?: Readonly<Record<string, string>>;
}> {
	const result = await runFormSnapshot(doc, input, context, authorized);
	if (!("opening" in result) || result.opening === undefined)
		throw new Error("The form did not return its opening.");
	return result.opening;
}

async function runFormSnapshot(
	doc: BlueprintDoc,
	input: FormEvaluationInput,
	context: FormEvaluationContext,
	authorized?: AuthorizedOpening,
) {
	const moduleUuid = moduleUuidOfForm(doc, input.formUuid);
	const module = moduleUuid ? doc.modules[moduleUuid] : undefined;
	const engineInput = buildEngineInput(
		doc,
		input.formUuid,
		input.language ?? null,
	);
	if (!module || !engineInput)
		throw new FormEvaluationInputError("Form not found.");
	/* What the evaluation says in its own words is in the language the form
	 * runs in: the one asked for when the app has it, else the app's default. */
	const language = resolveAppLanguage(doc.localization, input.language);
	/* A form that keeps its own opening choices is opened the way a worker
	 * opens it: each choice made from a list holds the record named for it,
	 * and its own record is the case the form opens on. A continued App Test
	 * entry carries its choices already. */
	const opening =
		authorized === undefined && context.session?.entryChoices === undefined
			? openingRecordChoices(doc, input, context)
			: undefined;
	const ids = opening?.ownCaseIds ?? input.caseIds ?? [];
	if (new Set(ids).size !== ids.length)
		throw new FormEvaluationInputError("Select each record once.");
	const record = formEntryRecord(doc, input.formUuid);
	const needsRecord = record.requiresCase;
	if (opening === undefined && needsRecord !== ids.length > 0)
		throw new FormEvaluationInputError(
			needsRecord
				? "Select an existing record to evaluate this form."
				: "This form does not load a selected record.",
		);
	if (ids.length > caseSelectionMaximum(record.menu ?? {}))
		throw new FormEvaluationInputError(
			`This form accepts at most ${caseSelectionMaximum(record.menu ?? {})} selected records.`,
		);
	for (const id of ids) {
		const row = context.cases.rows.find((row) => row.case_id === id);
		if (!row || row.case_type !== record.caseType)
			throw new FormEvaluationInputError(
				"A selected record is unavailable to this worker or has a different type.",
			);
	}
	/* A device reaches a form that reads what its search found only through
	 * that search, so without the search's snapshot the form cannot open. */
	const needed = formSearchReads(doc, input.formUuid, module.uuid);
	for (const [supplier, reads] of needed) {
		if (supplier === module.uuid) continue;
		const supplied = context.searches?.find(
			(search) => search.menu === supplier,
		);
		if (!supplied || (reads.readsResults && !supplied.results))
			throw new FormEvaluationInputError(
				`This form reads the search in "${doc.modules[supplier].name}". Start an app test and choose a record through that search first.`,
			);
	}
	if (
		context.searchResults === undefined &&
		moduleFormsReadSearch(module) &&
		needed.get(module.uuid)?.readsResults === true
	)
		throw new FormEvaluationInputError(
			`${runtimeMessage(language, "searchResultsRefusalTitle")}. ${runtimeMessage(language, "searchResultsRefusalBody")}`,
		);
	const reachable = reachableCaseTypes(
		record.contentCaseType,
		doc.caseTypes ?? [],
	);
	const caseData =
		ids.length === 1 && caseSelectionCardinality(record.menu ?? {}) === "single"
			? caseDatabaseToFormPreloads(context.cases, ids[0], reachable)
			: undefined;
	/* The entry key comes first: the entry's session mints its created cases'
	 * ids from it, and the engine reads them as `session/data`. */
	const entryKey =
		authorized?.entryKey ?? context.entry?.entryKey ?? randomUUID();
	const session =
		authorized?.session ??
		entrySessionData(doc, input.formUuid, {
			appId: context.session?.appId,
			entryChoices: opening?.entryChoices ?? context.session?.entryChoices,
			heldEntryValues: context.session?.heldEntryValues,
			lookupData: previewLookupData(context.lookup),
			entryKey,
			boundCases: ids.map((caseId) => {
				const caseName = context.cases.rows.find(
					(row) => row.case_id === caseId,
				)?.case_name;
				return caseName === undefined ? { caseId } : { caseId, caseName };
			}),
			menuSelections: context.session?.menuSelections ?? {},
			searches: context.searches,
			...(context.searchResults === undefined
				? {}
				: { searchResults: context.searchResults }),
			caseDatabase: context.cases,
			session: previewSessionValues(context.identity, context.device),
		});
	/* A choice no record was named for stops the entry where a worker would
	 * pick from its list, so the form would open with none of its records. */
	if (session.nextSelection !== undefined)
		throw new FormEvaluationInputError(
			`This form opens with “${session.nextSelection.name}”, a record the worker chooses from a list. Name a record for it in openingRecords.`,
		);
	/* The engine refuses a form as it opens where Core does (a case block
	 * reading worker information the worker lacks, an owner moved to no
	 * place), so that refusal is the form's, worded as Preview words it. */
	const dataRefusalInputError = (error: unknown) => {
		const dataRefusal = previewDataRefusalOf(error);
		return dataRefusal === undefined
			? error
			: new FormEvaluationInputError(
					dataRefusalSentence(doc, dataRefusal, context, language),
				);
	};
	let engine: FormEngine;
	try {
		engine = new FormEngine(
			{
				...engineInput,
				openingAssignments: openingCaseAssignments(
					doc,
					input.formUuid,
					session.reachedCaseIds,
					context.cases,
				),
			},
			record.caseType,
			caseData,
			context.identity,
			previewLookupData(context.lookup),
			context.cases,
			{
				stagedAsync: true,
				captureOpeningCaseIds: authorized !== undefined || context.captureEntry,
				device: context.device,
				sessionData: session.data,
				selectedCases: session.selectedCases,
				...(session.searches === undefined
					? {}
					: { searches: session.searches }),
				...(session.searchResults === undefined
					? {}
					: { searchResults: session.searchResults }),
				...(context.entry && context.entry.language !== engineInput.language
					? {
							restoredEntry: {
								checkpoint: context.entry.checkpoint,
								preserveAllValues: true,
							},
						}
					: {}),
				searchAnswers: searchInputInstanceValues(
					module.caseListConfig?.searchInputs ?? [],
					new Map(
						(context.searchAnswers ?? input.searchAnswers ?? []).map(
							({ name, value }) => [name, value],
						),
					),
				),
			},
		);
	} catch (error) {
		throw dataRefusalInputError(error);
	}
	const runtime = new XPathRuntime({
		workerFactory: createInProcessXPathWorkerFactory(),
	});
	const world = engine.createWorkerWorld(entryKey);
	const signal = AbortSignal.timeout(30_000);
	const evaluate = (async (
		source,
		path,
		resultMode = "scalar",
		stateOverrides,
	) => {
		const result = await runtime.request(
			{
				entryKey,
				revision: 0,
				profile: "form",
				source,
				resultMode,
				instances: engine.workerInstances(path, world, stateOverrides),
				dayNumberEpoch: engine.dayNumberEpoch,
			},
			{ signal },
		);
		if (!result.ok && result.refusal !== undefined)
			throw workerFailureError(result);
		if (!result.ok)
			throw new FormEvaluationXPathError(result.error, {
				path,
				expression: source,
				code: result.error.code,
				...(result.error.reason ? { reason: result.error.reason } : {}),
			});
		return result.nodesetValues === undefined
			? deserializeXPathWorkerValue(result.value)
			: { kind: "nodeset-values", values: result.nodesetValues };
	}) as FormEngineAsyncEvaluator;
	const fieldsByPath = new Map(
		Object.values(engineInput.fields)
			.filter(
				(field) => findContainingForm(doc, field.uuid) === engineInput.formUuid,
			)
			.map((field) => [
				`${engine.rootPath}/${computeFieldPath(doc, field.uuid)}`,
				field,
			]),
	);
	const normalizePath = (path: string) =>
		path.startsWith(`${engine.rootPath}/`)
			? path
			: `${engine.rootPath}/${path.replace(/^#form\//, "")}`;
	const fieldAt = (path: string) =>
		fieldsByPath.get(path.replace(/\[\d+\]/g, ""));
	const checkChoiceAnswers = () => {
		const issue = engine.choiceAnswerDiagnostic();
		if (issue !== undefined)
			throw new FormEvaluationInputError(
				`Nova Preview check: ${choiceAnswerDiagnosticMessage(issue, previewPlatformRules(context.device.platform))}`,
			);
	};
	try {
		if (context.entry && context.entry.language === engineInput.language)
			engine.restoreEntryCheckpoint(context.entry.checkpoint);
		else await engine.initializeAsync(evaluate);

		if (authorized !== undefined) {
			const key = authorized.includeActivity
				? await engine.readBehaviorText("activityKeyText", evaluate)
				: null;
			return {
				opening: {
					caseCreateIds: engine.initialCreateIds(),
					activity:
						key === null
							? undefined
							: {
									key,
									title: await engine.readBehaviorText(
										"activityTitleText",
										evaluate,
									),
									window: await engine.readBehaviorText(
										"activityWindowText",
										evaluate,
									),
								},
				},
			};
		}
		checkChoiceAnswers();
		/* The form's pages are the platform's screens (`formScreens`): the
		 * whole form on Web Apps, a section or a group or question on
		 * Android. A forward move validates every earlier screen in order and
		 * stops on the first that fails, as Next does. */
		const oneScreen = engine
			.formScreens()
			.every((screen) => screen.kind === "form");
		const leaveFor = async (target: string) => {
			if (target !== engine.currentScreenPath())
				await engine.saveScreenDatesAsync(evaluate);
		};
		const moveForwardTo = async (target: string): Promise<boolean> => {
			await leaveFor(target);
			for (const screen of pagesToValidate(
				availablePages(engine.formScreens()),
				engine.currentScreenPath() ?? "",
				target,
			)) {
				await engine.enterScreenAsync(screen.path, evaluate);
				if (!(await engine.validateScreenAsync(screen.path, evaluate)))
					return false;
			}
			await engine.enterScreenAsync(target, evaluate);
			return true;
		};
		if (input.sectionUuid) {
			const sectionUuid = input.sectionUuid;
			if (oneScreen) {
				/* Web Apps draws every section on its one screen, so naming one
				 * changes nothing; a uuid that is no section of the form refuses
				 * as it does on Android. */
				const named = engine
					.getControlTree()
					.some(
						(node) =>
							node.field.kind === "section" && node.field.uuid === sectionUuid,
					);
				if (!named)
					throw new FormEvaluationInputError("That section is unavailable.");
			} else {
				const target = availablePages(engine.formScreens()).find(
					(screen) => screen.kind === "section" && screen.uuid === sectionUuid,
				);
				if (target === undefined)
					throw new FormEvaluationInputError("That section is unavailable.");
				await moveForwardTo(target.path);
			}
		}
		if (input.screenPath) {
			const screenPath = input.screenPath;
			if (
				!availablePages(engine.formScreens()).some(
					(screen) => screen.path === screenPath,
				)
			)
				throw new FormEvaluationInputError("That page is unavailable.");
			await moveForwardTo(screenPath);
		}
		/* The screen a question is on: its section on a sectioned form,
		 * its group shown on one screen or itself on Android, nothing on Web Apps' one
		 * screen. */
		const screenForPath = (path: string) =>
			oneScreen
				? undefined
				: engine
						.formScreens()
						.find((screen) => engine.containsControl(screen.path, path));
		for (const repeat of [...(input.repeats ?? [])].sort(
			(a, b) => a.path.split("/").length - b.path.split("/").length,
		)) {
			const path = normalizePath(repeat.path);
			const field = fieldAt(path);
			if (field?.kind !== "repeat" || field.repeat_mode !== "user_controlled")
				throw new FormEvaluationInputError(
					`Repeat ${repeat.path} is unavailable or its rows are calculated.`,
				);
			if (!engine.materializePaths(path).includes(path))
				throw new FormEvaluationInputError(
					`Repeat ${repeat.path} needs its containing entry first.`,
				);
			const checkAccess = async (action: "add" | "remove") => {
				if (
					!(await engine.workerCanEditRepeatAsync(
						path,
						field.uuid,
						action,
						evaluate,
					))
				)
					throw new FormEvaluationInputError(
						`Open the page with repeat ${repeat.path} before changing its entries.`,
					);
			};
			while (engine.getRepeatCount(path) < repeat.count) {
				await checkAccess("add");
				if ((await engine.addRepeatAsync(path, evaluate)) === undefined) {
					const refusal = engine.getState(path).insertRefusal;
					if (refusal) throw new SetvalueRefusal(refusal);
					throw new FormEvaluationInputError(
						`Repeat ${repeat.path} could not add an entry.`,
					);
				}
			}
			while (engine.getRepeatCount(path) > repeat.count) {
				await checkAccess("remove");
				await engine.removeRepeatAsync(
					path,
					engine.getRepeatCount(path) - 1,
					evaluate,
				);
			}
		}
		for (const answer of input.answers) {
			checkChoiceAnswers();
			const path = normalizePath(answer.path);
			const screen = screenForPath(path);
			if (screen && screen.path !== engine.currentScreenPath()) {
				if (context.captureEntry && screen.kind === "section")
					throw new FormEvaluationInputError(
						"Open that section before answering its questions.",
					);
				if (context.captureEntry) {
					/* An Android screen of one group or question: answering it
					 * enters it, validating earlier screens as a forward turn
					 * does. */
					if (!(await moveForwardTo(screen.path)))
						throw new FormEvaluationInputError(
							"A question before this one needs an answer first. You can answer it, then try again.",
						);
				} else {
					await leaveFor(screen.path);
					await engine.enterScreenAsync(screen.path, evaluate);
				}
			}
			const field = fieldAt(path);
			if (field && !engine.materializePaths(path).includes(path)) {
				throw new FormEvaluationInputError(
					`Answer ${answer.path} needs an entry in its repeating group. Add that entry before answering its questions.`,
				);
			}
			if (
				!field ||
				!Object.hasOwn(engine.store.getState(), path) ||
				!engine.workerRelevantPaths().has(path) ||
				isContainer(field) ||
				field.kind === "hidden" ||
				(field.kind === "label" &&
					(!field.askForConfirmation ||
						previewPlatformRules(context.device.platform)
							.messageConfirmation !== "checkbox")) ||
				isCaptureFieldKind(field.kind)
			) {
				throw new FormEvaluationInputError(
					`Answer ${answer.path} is not an editable question in this form. Media capture requires the running app.`,
				);
			}
			if (
				field.kind === "label" &&
				answer.value !== "OK" &&
				answer.value !== ""
			) {
				throw new FormEvaluationInputError(
					"Use OK to check the message or an empty answer to clear it.",
				);
			}
			await engine.setValueAsync(
				path,
				evaluationAnswerValue(field.kind, answer.path, answer.value),
				evaluate,
			);
		}
		// Standalone checks follow supplied answer order and then remaining pages.
		// Retained journeys advance only through explicit page turns.
		if (!context.captureEntry)
			for (const screen of availablePages(engine.formScreens())) {
				await leaveFor(screen.path);
				await engine.enterScreenAsync(screen.path, evaluate);
			}
		const currentScreenPath = engine.currentScreenPath();
		const screens = engine.formScreens().map((screen) => ({
			...screen,
			current: oneScreen || screen.path === currentScreenPath,
		}));
		/* The form's sections: on Web Apps each is on the one screen, so each
		 * is current; on Android each section is its own screen. */
		const sections = engine.sectionScreens().map((page) => {
			const field = engineInput.fields[page.uuid];
			return {
				...page,
				current: oneScreen || page.path === currentScreenPath,
				label:
					field?.kind === "section" && field.label
						? projectProseTemplate(field.label, doc).text
						: "",
			};
		});
		const visibleScreens = screens.filter(
			(screen) => screen.hasVisibleQuestions || screen.needsEntry,
		);
		const canSubmit =
			!context.captureEntry ||
			visibleScreens.length === 0 ||
			visibleScreens.at(-1)?.current === true;
		const submitting =
			!context.captureEntry || (context.submitEntry === true && canSubmit);
		// A standalone form check proposes a submission. A retained test only
		// commits the current entry when the worker chooses Submit on its last page.
		let valid: boolean;
		if (submitting) {
			await engine.saveScreenDatesAsync(evaluate);
			await engine.prepareSubmitAsync(evaluate);
			checkChoiceAnswers();
			valid = await engine.validateAllAsync(evaluate);
		} else {
			valid = await engine.observeValidationAsync(evaluate);
		}
		const relevantPaths = engine.effectivelyVisiblePaths();
		const workerRelevant = engine.workerRelevantPaths();
		const presentation = projectFormPresentation(
			engine.getControlTree(),
			{ stateAt: (_field, path) => engine.getState(path), workerRelevant },
			{
				language: engineInput.language,
				containsControl: engine.containsControl,
				rootPath: engine.rootPath,
				/* A sectioned form on Android pages by section; every other
				 * form's page is its current screen (the whole form on Web
				 * Apps). */
				...(!oneScreen &&
				screens.length > 0 &&
				screens.every((screen) => screen.kind === "section")
					? { currentSectionUuid: engine.currentSectionUuid() }
					: { currentScreenPath: currentScreenPath ?? engine.rootPath }),
				availableSectionUuids: new Set(
					sections
						.filter(
							(section) => section.hasVisibleQuestions || section.needsEntry,
						)
						.map((section) => section.uuid),
				),
				text: (prose) => projectProseTemplate(prose, doc).text,
			},
		);
		const fields = presentation.fields.map(
			({
				path,
				state,
				field,
				parentPath,
				depth,
				sectionUuid,
				onCurrentPage,
				visible,
				position,
				label,
				hint,
				help,
			}) => {
				const relevant = relevantPaths.has(path);
				const kind = field.kind;
				const { value, required, valid, errorMessage, choices, repeatCount } =
					state;
				const options =
					choices ??
					(field &&
					(field.kind === "single_select" || field.kind === "multi_select") &&
					field.optionsSource.kind === "inline"
						? field.optionsSource.options.map((option) => ({
								key: option.uuid,
								value: option.value,
								label:
									state.resolvedOptionLabels?.[option.uuid] ??
									projectProseTemplate(option.label, doc).text,
							}))
						: undefined);
				const observedAnswer: {
					value?: typeof value;
					retainedValue?: typeof value;
				} = relevant ? { value } : { retainedValue: value };
				return {
					path: path.slice(engine.rootPath.length + 1),
					parentPath: parentPath.slice(engine.rootPath.length + 1),
					depth,
					...(position === undefined ? {} : { position }),
					...(sectionUuid === undefined ? {} : { sectionUuid }),
					onCurrentPage,
					kind,
					// A retained answer on an excluded question is not a usable
					// expression/submission value. Hidden calculated fields, unlike
					// non-relevant questions, still participate in the form.
					participates: relevant,
					...observedAnswer,
					...(relevant && state.androidPickerDay
						? { displayedDay: state.androidPickerDay }
						: {}),
					visible: relevant && visible,
					required: workerRelevant.has(path) && required,
					valid: !workerRelevant.has(path) || valid,
					...(workerRelevant.has(path) && errorMessage
						? { error: errorMessage }
						: {}),
					label,
					hint,
					help,
					...(options === undefined ? {} : { choices: options }),
					...(repeatCount === undefined ? {} : { repeatCount }),
					...(state.insertRefusal === undefined
						? {}
						: {
								insertRefused: formRefusal(
									doc,
									state.insertRefusal,
									context.cases,
									language,
								).sentence,
							}),
					...(kind === "geopoint"
						? {
								interaction: "location-picker" as const,
								testInput:
									"Supply coordinates as {latitude, longitude, altitude?, accuracy?}. This does not exercise GPS capture or map services.",
							}
						: {}),
				};
			},
		);
		return {
			...(context.captureEntry
				? {
						entry: {
							entryKey,
							language: engineInput.language,
							checkpoint: engine.entryCheckpoint(),
						},
					}
				: {}),
			valid,
			fields,
			presentation: {
				...(presentation.currentSectionUuid === undefined
					? {}
					: { currentSectionUuid: presentation.currentSectionUuid }),
				...(currentScreenPath === undefined ? {} : { currentScreenPath }),
				nodes: presentation.nodes,
			},
			platform: context.device.platform,
			sections,
			screens,
			canSubmit,
			...(submitting && valid && canSubmit
				? {
						submission: engine.computeSubmissionMutation({
							caseIds: ids,
							entryKey,
						}),
					}
				: {}),
		};
	} catch (error) {
		if (error instanceof SetvalueRefusal)
			throw new FormRefusedError(
				formRefusal(doc, error.details, context.cases, language),
			);
		if (previewDataRefusalOf(error) !== undefined)
			throw dataRefusalInputError(error);
		if (error instanceof FormEvaluationXPathError)
			throw new FormEvaluationInputError(
				"An expression could not be evaluated.",
				error.fault,
			);
		throw error;
	} finally {
		runtime.dispose();
	}
}

/**
 * The entry choices and own record of a form that keeps its own opening
 * choices, from `input.openingRecords`: each names a choice the worker
 * makes from a list and a record of that list's type the worker can see.
 * Undefined for a form that keeps its menu's choice, which `caseIds` binds.
 */
function openingRecordChoices(
	doc: BlueprintDoc,
	input: FormEvaluationInput,
	context: FormEvaluationContext,
):
	| {
			readonly entryChoices: readonly PreviewEntryChoice[];
			readonly ownCaseIds: readonly string[];
	  }
	| undefined {
	const explicit = doc.forms[input.formUuid]?.caseSelections;
	const named = input.openingRecords ?? [];
	if (explicit === undefined) {
		if (named.length > 0)
			throw new FormEvaluationInputError(
				"This form opens with its menu’s record. Select it with caseIds instead of openingRecords.",
			);
		return undefined;
	}
	if (input.caseIds?.length)
		throw new FormEvaluationInputError(
			"This form chooses its own opening records. Name each one in openingRecords instead of caseIds.",
		);
	const entryChoices: PreviewEntryChoice[] = [];
	for (const { name, caseId } of named) {
		const matches = explicit.filter(
			(row) => row.source.kind === "choose" && row.name === name,
		);
		if (matches.length !== 1)
			throw new FormEvaluationInputError(
				matches.length === 0
					? `“${name}” isn’t an opening record this form chooses from a list. Get the form to see its opening records.`
					: `This form has more than one opening record named “${name}”. Give each its own name to evaluate it.`,
			);
		const [row] = matches;
		if (entryChoices.some((choice) => choice.selectionUuid === row.uuid))
			throw new FormEvaluationInputError(`Name one record for “${name}”.`);
		const found = context.cases.rows.find((r) => r.case_id === caseId);
		if (!found || found.case_type !== row.caseType)
			throw new FormEvaluationInputError(
				`The record named for “${name}” is unavailable to this worker or isn’t a ${row.caseType} record.`,
			);
		entryChoices.push({
			selectionUuid: row.uuid,
			caseId,
			...(found.case_name !== null && { caseName: found.case_name }),
		});
	}
	const ownIndex = ownFormSelectionIndex(doc, input.formUuid);
	const own =
		ownIndex === undefined
			? undefined
			: entryChoices.find(
					(choice) => choice.selectionUuid === explicit[ownIndex]?.uuid,
				);
	return { entryChoices, ownCaseIds: own ? [own.caseId] : [] };
}
