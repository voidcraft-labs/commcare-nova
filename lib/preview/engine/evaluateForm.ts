import "server-only";
import { resolve } from "node:path";
import { Worker } from "node:worker_threads";
import type { BlueprintDoc } from "@/lib/domain";
import type { evaluateFormSnapshot } from "./evaluateFormSnapshot";
import {
	EvaluationDeadlineError,
	remainingEvaluationTime,
} from "./evaluationDeadline";
import {
	type FormEvaluationContext,
	type FormEvaluationFault,
	type FormEvaluationInput,
	FormEvaluationInputError,
	type FormRefusalDetails,
	FormRefusedError,
} from "./formEvaluationTypes";
import type {
	evaluatePostSubmissionSnapshot,
	PostSubmissionEvaluationInput,
} from "./postSubmissionEvaluation";
import type {
	evaluateSearchSnapshot,
	SearchEvaluationInput,
} from "./searchEvaluation";

export {
	FormEvaluationInputError,
	FormRefusedError,
} from "./formEvaluationTypes";

type EvaluationResult = Awaited<ReturnType<typeof evaluateFormSnapshot>>;
type WorkerResult<T> =
	| { ok: true; result: T }
	| {
			ok: false;
			inputError: boolean;
			message: string;
			error?: Error;
			fault?: FormEvaluationFault;
			refusal?: FormRefusalDetails;
	  };

/** A read-only form run owns one bounded thread, including FormEngine and its
 * XPath evaluator. Join termination on every outcome before releasing the call. */
export async function evaluateForm(
	doc: BlueprintDoc,
	input: FormEvaluationInput,
	context: FormEvaluationContext,
): Promise<EvaluationResult> {
	return evaluateInWorker<EvaluationResult>("form", doc, input, context);
}

export async function evaluateSearch(
	doc: BlueprintDoc,
	input: SearchEvaluationInput,
	context: FormEvaluationContext,
) {
	return evaluateInWorker<Awaited<ReturnType<typeof evaluateSearchSnapshot>>>(
		"search",
		doc,
		input,
		context,
	);
}

export async function evaluatePostSubmission(
	doc: BlueprintDoc,
	input: PostSubmissionEvaluationInput,
	context: FormEvaluationContext,
) {
	return evaluateInWorker<
		Awaited<ReturnType<typeof evaluatePostSubmissionSnapshot>>
	>("after-submit", doc, input, context);
}

async function evaluateInWorker<T>(
	kind: "form" | "search" | "after-submit",
	doc: BlueprintDoc,
	input:
		| FormEvaluationInput
		| SearchEvaluationInput
		| PostSubmissionEvaluationInput,
	context: FormEvaluationContext,
): Promise<T> {
	remainingEvaluationTime();
	const worker = new Worker(
		resolve(process.cwd(), "public/form-evaluation/worker.mjs"),
		{
			workerData: {
				kind,
				doc,
				input,
				context: {
					...context,
					lookup: {
						projectRevision: context.lookup.projectRevision,
						definitions: context.lookup.definitions,
						rowsByTable: context.lookup.rowsByTable,
					},
				},
			},
			resourceLimits: { maxOldGenerationSizeMb: 128 },
		},
	);
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const remaining = remainingEvaluationTime();
		const limitedByCall = remaining <= 30_000;
		return await new Promise<T>((accept, reject) => {
			timer = setTimeout(
				() =>
					reject(
						limitedByCall
							? new EvaluationDeadlineError()
							: new FormEvaluationInputError(
									"Evaluation exceeded its 30-second limit.",
								),
					),
				Math.min(30_000, remaining),
			);
			worker.once("error", reject);
			worker.once("exit", (code) =>
				reject(
					new Error(
						`Form evaluation stopped before returning a result (${code}).`,
					),
				),
			);
			worker.once("message", (message: WorkerResult<T>) => {
				if (message.ok) {
					try {
						remainingEvaluationTime();
						accept(message.result);
					} catch (error) {
						reject(error);
					}
				} else
					reject(
						message.refusal !== undefined
							? new FormRefusedError(message.refusal)
							: message.inputError
								? new FormEvaluationInputError(message.message, message.fault)
								: (message.error ?? new Error(message.message)),
					);
			});
		});
	} finally {
		clearTimeout(timer);
		await worker.terminate();
	}
}
