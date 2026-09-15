import "server-only";
import { resolve } from "node:path";
import { Worker } from "node:worker_threads";
import type { BlueprintDoc } from "@/lib/domain";
import type { evaluateFormSnapshot } from "./evaluateFormSnapshot";
import {
	type FormEvaluationContext,
	type FormEvaluationFault,
	type FormEvaluationInput,
	FormEvaluationInputError,
} from "./formEvaluationTypes";

export { FormEvaluationInputError } from "./formEvaluationTypes";

type EvaluationResult = Awaited<ReturnType<typeof evaluateFormSnapshot>>;
type WorkerResult =
	| { ok: true; result: EvaluationResult }
	| {
			ok: false;
			inputError: boolean;
			message: string;
			fault?: FormEvaluationFault;
	  };

/** A read-only form run owns one bounded thread, including FormEngine and its
 * XPath evaluator. Join termination on every outcome before releasing the call. */
export async function evaluateForm(
	doc: BlueprintDoc,
	input: FormEvaluationInput,
	context: FormEvaluationContext,
): Promise<EvaluationResult> {
	const worker = new Worker(
		resolve(process.cwd(), "public/form-evaluation/worker.mjs"),
		{
			workerData: {
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
		return await new Promise<EvaluationResult>((accept, reject) => {
			timer = setTimeout(
				() =>
					reject(
						new FormEvaluationInputError(
							"Evaluation exceeded its 30-second limit.",
						),
					),
				30_000,
			);
			worker.once("error", reject);
			worker.once("exit", (code) =>
				reject(
					new Error(
						`Form evaluation stopped before returning a result (${code}).`,
					),
				),
			);
			worker.once("message", (message: WorkerResult) => {
				if (message.ok) accept(message.result);
				else
					reject(
						message.inputError
							? new FormEvaluationInputError(message.message, message.fault)
							: new Error(message.message),
					);
			});
		});
	} finally {
		clearTimeout(timer);
		await worker.terminate();
	}
}
