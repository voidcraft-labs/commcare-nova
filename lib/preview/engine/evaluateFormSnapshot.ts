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
	const entryKey = randomUUID();
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
				{ path, expression: source, code: result.error.code },
			);
		return result.nodesetValues === undefined
			? deserializeXPathWorkerValue(result.value)
			: { kind: "nodeset-values", values: result.nodesetValues };
	}) as FormEngineAsyncEvaluator;
	const fieldsByPath = new Map(
		Object.values(doc.fields)
			.filter((field) => findContainingForm(doc, field.uuid) === input.formUuid)
			.map((field) => [`/data/${computeFieldPath(doc, field.uuid)}`, field]),
	);
	const normalizePath = (path: string) =>
		path.startsWith("/data/") ? path : `/data/${path.replace(/^#form\//, "")}`;
	const fieldAt = (path: string) =>
		fieldsByPath.get(path.replace(/\[\d+\]/g, ""));
	try {
		await engine.initializeAsync(evaluate);
		for (const repeat of input.repeats ?? []) {
			const path = normalizePath(repeat.path);
			const field = fieldAt(path);
			if (field?.kind !== "repeat" || field.repeat_mode !== "user_controlled")
				throw new FormEvaluationInputError(
					`Repeat ${repeat.path} is unavailable or its rows are calculated.`,
				);
		}
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
		const fields = Object.entries(engine.store.getState()).map(
			([path, state]) => {
				const {
					value,
					visible,
					required,
					valid,
					errorMessage,
					resolvedLabel,
					resolvedHint,
					resolvedHelp,
					choices,
					repeatCount,
				} = state;
				return {
					path: path.replace(/^\/data\//, ""),
					value,
					visible,
					required,
					valid,
					...(errorMessage ? { error: errorMessage } : {}),
					...(resolvedLabel === undefined ? {} : { label: resolvedLabel }),
					...(resolvedHint === undefined ? {} : { hint: resolvedHint }),
					...(resolvedHelp === undefined ? {} : { help: resolvedHelp }),
					...(choices === undefined ? {} : { choices }),
					...(repeatCount === undefined ? {} : { repeatCount }),
				};
			},
		);
		return {
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
