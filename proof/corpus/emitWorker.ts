/**
 * A corpus emitter's worker process: writes the documents of one job
 * (`./entryWriter.ts::entryJob`) and records what each left for the emitter.
 *
 *   node --conditions=react-server --import ./proof/corpus/entropy.mts \
 *     --import tsx proof/corpus/emitWorker.ts <job.json> <result.json>
 *
 * Run from the worktree root by `./emitCorpus.ts`; `job.json` holds
 * `{out, seed, entries}`, and `result.json` receives each document's
 * `WrittenEntry`, in the job's order.
 */

import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { preparedFromJob, type WrittenEntry, writeEntry } from "./entryWriter";

async function main(argv: readonly string[]): Promise<void> {
	const [jobPath, resultPath] = argv;
	if (jobPath === undefined || resultPath === undefined) {
		throw new Error(
			"Name the job file and the result file: emitWorker.ts <job.json> <result.json>.",
		);
	}
	const job = JSON.parse(await readFile(jobPath, "utf8")) as {
		out: string;
		seed: number;
		entries: unknown[];
	};
	if (!Number.isSafeInteger(job.seed)) {
		throw new Error(
			`The corpus worker's job ${jobPath} names no whole-number seed, so its exports could not be seeded as the corpus's are.`,
		);
	}
	const written: WrittenEntry[] = [];
	for (const entry of preparedFromJob(job.entries)) {
		written.push(await writeEntry(job.out, entry, job.seed));
	}
	await writeFile(resultPath, JSON.stringify(written));
}

if (
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	main(process.argv.slice(2)).catch((error: unknown) => {
		console.error(
			error instanceof Error ? (error.stack ?? error.message) : error,
		);
		process.exitCode = 1;
	});
}
