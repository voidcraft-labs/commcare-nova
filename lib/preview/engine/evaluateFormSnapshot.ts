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
	moduleOpensOnSearch,
	moduleUuidOfForm,
	reachableCaseTypes,
	resolveAppLanguage,
} from "@/lib/domain";
import { projectProseTemplate } from "@/lib/domain/prose";
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
import { searchInputInstanceValues } from "./runtimeBindings";
import { availablePages, pagesToValidate } from "./sectionPaging";
import { formReadsSearchResults } from "./xpathInstances";

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

/** Observe a form against one captured runtime context. No stores are reachable
 * here. The submission is a proposal; it has not passed a storage transaction. */
export async function evaluateFormSnapshot(
	doc: BlueprintDoc,
	input: FormEvaluationInput,
	context: FormEvaluationContext,
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
	const form = engineInput.form;
	const ids = input.caseIds ?? [];
	if (new Set(ids).size !== ids.length)
		throw new FormEvaluationInputError("Select each record once.");
	const needsRecord = form.type === "followup" || form.type === "close";
	if (needsRecord !== ids.length > 0)
		throw new FormEvaluationInputError(
			needsRecord
				? "Select an existing record to evaluate this form."
				: "This form does not load a selected record.",
		);
	if (ids.length > caseSelectionMaximum(module))
		throw new FormEvaluationInputError(
			`This form accepts at most ${caseSelectionMaximum(module)} selected records.`,
		);
	for (const id of ids) {
		const row = context.cases.rows.find((row) => row.case_id === id);
		if (!row || row.case_type !== module.caseType)
			throw new FormEvaluationInputError(
				"A selected record is unavailable to this worker or has a different type.",
			);
	}
	/* A device reaches a form that reads what its search found only through
	 * that search, so without the search's snapshot the form cannot open. */
	if (
		context.searchResults === undefined &&
		moduleOpensOnSearch(module) &&
		formReadsSearchResults(doc, input.formUuid)
	)
		throw new FormEvaluationInputError(
			`${runtimeMessage(language, "searchResultsRefusalTitle")}. ${runtimeMessage(language, "searchResultsRefusalBody")}`,
		);
	const reachable = reachableCaseTypes(module.caseType, doc.caseTypes ?? []);
	const caseData =
		ids.length === 1 && caseSelectionCardinality(module) === "single"
			? caseDatabaseToFormPreloads(context.cases, ids[0], reachable)
			: undefined;
	/* The entry key comes first: the entry's session mints its created cases'
	 * ids from it, and the engine reads them as `session/data`. */
	const entryKey = context.entry?.entryKey ?? randomUUID();
	const session = entrySessionData(doc, input.formUuid, {
		appId: context.session?.appId,
		entryKey,
		boundCases: ids.map((caseId) => {
			const caseName = context.cases.rows.find(
				(row) => row.case_id === caseId,
			)?.case_name;
			return caseName === undefined ? { caseId } : { caseId, caseName };
		}),
		menuSelections: context.session?.menuSelections ?? {},
		...(context.searchResults === undefined
			? {}
			: { searchResults: context.searchResults }),
		caseDatabase: context.cases,
		session: previewSessionValues(context.identity, context.device),
	});
	const engine = new FormEngine(
		engineInput,
		module.caseType,
		caseData,
		context.identity,
		previewLookupData(context.lookup),
		context.cases,
		{
			stagedAsync: true,
			device: context.device,
			sessionData: session.data,
			selectedCases: session.selectedCases,
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
					(input.searchAnswers ?? []).map(({ name, value }) => [name, value]),
				),
			),
		},
	);
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
			.filter((field) => findContainingForm(doc, field.uuid) === input.formUuid)
			.map((field) => [`/data/${computeFieldPath(doc, field.uuid)}`, field]),
	);
	const normalizePath = (path: string) =>
		path.startsWith("/data/") ? path : `/data/${path.replace(/^#form\//, "")}`;
	const fieldAt = (path: string) =>
		fieldsByPath.get(path.replace(/\[\d+\]/g, ""));
	try {
		if (context.entry && context.entry.language === engineInput.language)
			engine.restoreEntryCheckpoint(context.entry.checkpoint);
		else await engine.initializeAsync(evaluate);
		/* The form's pages are the platform's screens (`formScreens`): the
		 * whole form on Web Apps, a section or a group or question on
		 * Android. A forward move validates every earlier screen in order and
		 * stops on the first that fails, as Next does. */
		const oneScreen = engine
			.formScreens()
			.every((screen) => screen.kind === "form");
		const moveForwardTo = async (target: string): Promise<boolean> => {
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
					.getFieldTree()
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
		 * its labeled group or itself on Android, nothing on Web Apps' one
		 * screen. */
		const screenForPath = (path: string) =>
			oneScreen
				? undefined
				: engine
						.formScreens()
						.find(
							(screen) =>
								path === screen.path ||
								path.startsWith(`${screen.path}/`) ||
								path.startsWith(`${screen.path}[`),
						);
		for (const repeat of input.repeats ?? []) {
			const path = normalizePath(repeat.path);
			const field = fieldAt(path);
			if (field?.kind !== "repeat" || field.repeat_mode !== "user_controlled")
				throw new FormEvaluationInputError(
					`Repeat ${repeat.path} is unavailable or its rows are calculated.`,
				);
		}
		if (input.repeats?.length)
			await engine.restoreRepeatCountSnapshotAsync(
				new Map(
					(input.repeats ?? []).map(({ path, count }) => [
						normalizePath(path),
						count,
					]),
				),
				evaluate,
			);
		for (const repeat of input.repeats ?? []) {
			// A requested row CommCare refuses to insert stops this evaluation,
			// as the refused insert stops the running app's action.
			const path = normalizePath(repeat.path);
			const state = engine.getState(path);
			if (
				state.insertRefusal !== undefined &&
				engine.getRepeatCount(path) < repeat.count
			)
				throw new SetvalueRefusal(state.insertRefusal);
		}
		for (const answer of input.answers) {
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
				} else await engine.enterScreenAsync(screen.path, evaluate);
			}
			const field = fieldAt(path);
			if (
				!field ||
				!Object.hasOwn(engine.store.getState(), path) ||
				!engine.effectivelyVisiblePaths().has(path) ||
				isContainer(field) ||
				field.kind === "hidden" ||
				field.kind === "label" ||
				isCaptureFieldKind(field.kind)
			) {
				throw new FormEvaluationInputError(
					`Answer ${answer.path} is not an editable question in this form. Media capture requires the running app.`,
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
		/* Formplayer rebuilds the session before it validates a submission. */
		await engine.prepareSubmitAsync(evaluate);
		const valid = await engine.validateAllAsync(evaluate);
		const relevantPaths = engine.effectivelyVisiblePaths();
		const presentation = projectFormPresentation(
			engine.getFieldTree(),
			{ stateAt: (_field, path) => engine.getState(path) },
			{
				language: engineInput.language,
				/* A sectioned form on Android pages by section; every other
				 * form's page is its current screen (the whole form on Web
				 * Apps). */
				...(!oneScreen &&
				screens.length > 0 &&
				screens.every((screen) => screen.kind === "section")
					? { currentSectionUuid: engine.currentSectionUuid() }
					: { currentScreenPath: currentScreenPath ?? "/data" }),
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
					path: path.replace(/^\/data\//, ""),
					parentPath: parentPath.replace(/^\/data\/?/, ""),
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
					visible: relevant && visible,
					required: relevant && required,
					valid: !relevant || valid,
					...(relevant && errorMessage ? { error: errorMessage } : {}),
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
			...(valid && canSubmit
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
		const dataRefusal = previewDataRefusalOf(error);
		if (dataRefusal !== undefined)
			throw new FormEvaluationInputError(
				dataRefusalSentence(doc, dataRefusal, context, language),
			);
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
