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
	moduleUuidOfForm,
	reachableCaseTypes,
} from "@/lib/domain";
import { projectProseTemplate } from "@/lib/domain/prose";
import { createInProcessXPathWorkerFactory } from "../xpath/inProcessWorkerClient";
import { XPathRuntime } from "../xpath/workerClient";
import { deserializeXPathWorkerValue } from "../xpath/workerProjection";
import { caseDatabaseToFormPreloads } from "./caseDataBindingClient";
import { buildEngineInput } from "./engineInput";
import { FormEngine, type FormEngineAsyncEvaluator } from "./formEngine";
import type {
	FormEvaluationContext,
	FormEvaluationInput,
} from "./formEvaluationTypes";
import { FormEvaluationInputError } from "./formEvaluationTypes";
import { previewLookupData } from "./lookupEvaluation";
import { searchInputInstanceValues } from "./runtimeBindings";

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
	const reachable = reachableCaseTypes(module.caseType, doc.caseTypes ?? []);
	const caseData =
		ids.length === 1 && caseSelectionCardinality(module) === "single"
			? caseDatabaseToFormPreloads(context.cases, ids[0], reachable)
			: undefined;
	const engine = new FormEngine(
		engineInput,
		module.caseType,
		caseData,
		context.identity,
		previewLookupData(context.lookup),
		context.cases,
		{
			stagedAsync: true,
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
	const entryKey = context.entry?.entryKey ?? randomUUID();
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
				instances: engine.workerInstances(source, path, world, stateOverrides),
			},
			{ signal },
		);
		if (!result.ok)
			throw new FormEvaluationInputError(
				"An expression could not be evaluated.",
				{
					path,
					expression: source,
					code: result.error.code,
					...(result.error.reason ? { reason: result.error.reason } : {}),
				},
			);
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
		if (context.entry) engine.restoreEntryCheckpoint(context.entry.checkpoint);
		else await engine.initializeAsync(evaluate);
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
		for (const answer of input.answers) {
			const path = normalizePath(answer.path);
			const field = fieldAt(path);
			if (
				!field ||
				!Object.hasOwn(engine.store.getState(), path) ||
				!engine.effectivelyVisiblePaths().has(path) ||
				isContainer(field) ||
				field.kind === "hidden" ||
				field.kind === "label" ||
				isCaptureFieldKind(field.kind)
			)
				throw new FormEvaluationInputError(
					`Answer ${answer.path} is not an editable question in this form. Media capture requires the running app.`,
				);
			await engine.setValueAsync(path, answer.value, evaluate);
		}
		const valid = await engine.validateAllAsync(evaluate);
		const relevantPaths = engine.effectivelyVisiblePaths();
		const fields = Object.entries(engine.store.getState()).map(
			([path, state]) => {
				const relevant = relevantPaths.has(path);
				const field = fieldAt(path);
				const kind = field?.kind;
				const {
					value,
					required,
					valid,
					errorMessage,
					resolvedLabel,
					resolvedHint,
					resolvedHelp,
					choices,
					repeatCount,
				} = state;
				const text = (
					slot: "label" | "hint" | "help",
					resolved: string | undefined,
				) => {
					if (resolved !== undefined) return resolved;
					const prose =
						field && slot in field
							? field[slot as keyof typeof field]
							: undefined;
					return typeof prose === "object" && prose !== null && "parts" in prose
						? projectProseTemplate(prose, doc).text
						: undefined;
				};
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
				return {
					path: path.replace(/^\/data\//, ""),
					kind,
					value,
					visible: relevant && kind !== "hidden",
					required: relevant && required,
					valid: !relevant || valid,
					...(relevant && errorMessage ? { error: errorMessage } : {}),
					label: text("label", resolvedLabel),
					hint: text("hint", resolvedHint),
					help: text("help", resolvedHelp),
					...(options === undefined ? {} : { choices: options }),
					...(repeatCount === undefined ? {} : { repeatCount }),
				};
			},
		);
		return {
			...(context.captureEntry
				? { entry: { entryKey, checkpoint: engine.entryCheckpoint() } }
				: {}),
			valid,
			fields,
			...(valid
				? {
						submission: engine.computeSubmissionMutation({
							caseIds: ids,
							entryKey,
						}),
					}
				: {}),
		};
	} finally {
		runtime.dispose();
	}
}
