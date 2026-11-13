/**
 * The corpus's emission CLI: every document the proof lane checks, written
 * in the layout `./emitCorpus.ts` describes.
 *
 * Run from the worktree root, with Nova's `node_modules` (CI runs it in the
 * `proof-corpus` job; the lane runs it inside the proof image when no corpus is
 * named, through `proof/checks/corpus.py`):
 *
 *   node --conditions=react-server --import ./proof/corpus/entropy.mts \
 *     --import tsx proof/corpus/emit.ts --out <dir> [--sample <n>] \
 *     [--seed <n>] [--jobs <n>] [--shard <i>/<n>]
 *
 * `--conditions=react-server` resolves `server-only` to its empty module;
 * Nova's HQ client and media modules import it. The entropy preload seeds
 * every export's minted identities (`./entropy.mts`), so the corpus is the
 * same, byte for byte, on every run at one seed. It runs, in order:
 *
 * 1. the two Vitest writers, in one Vitest run: the admitted expander corpus
 *    (`lib/commcare/__tests__/expander.test.ts`, captured by
 *    `expanderEvidence.ts`) and the fuzz sample of `--sample` documents at
 *    `--seed` (`./__tests__/fuzzSample.test.ts`);
 * 2. the producers' documents (`./producers.ts`), the workforce documents
 *    built over them (`./workforce.ts`) and the targeted documents
 *    (`proof/targeted/index.ts`, when it exists), then every document's edit
 *    batch, captures, exports and input manifest (`./emitCorpus.ts`).
 *
 * Nothing in the emission starts HQ: the privileges a document's content
 * needs are derived in the lane, where HQ runs
 * (`proof/checks/configurations.py::privileges_for`).
 *
 * `--jobs` (by default the machine's parallelism, at most four) is how many
 * worker processes write the documents' directories. `--shard i/n` writes
 * only every n-th document from the i-th (in the order the sources list
 * them), each exactly as the whole corpus writes it. It prints the census
 * of the fixed floor (producers, workforce, expander and targeted
 * documents) and of the sample, and what each part took, writing the census
 * to `index.json` and the timings to `timings.json`. It fails, before
 * writing any document, when the fixed floor leaves out a document or an
 * edit `./left-out.json` does not name, or takes one it names, naming each
 * (`./emitCorpus.ts::leftOutDifferences`), and when some mutation kind lands
 * on no fixed document, naming the kind and what refused it.
 */

import "./entropy.mts";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import {
	DEFAULT_ADVANCED_SAMPLE_SIZE,
	DEFAULT_CORPUS_SEED,
	DEFAULT_EXPRESSION_SAMPLE_SIZE,
	DEFAULT_SAMPLE_SIZE,
} from "./defaults";
import {
	type CorpusDocument,
	readExpanderCapture,
	readFuzzSample,
	TARGETED_MODULE,
} from "./documents";
import { ENTROPY_PRELOAD, emissionEnv, WORKTREE } from "./emissionProcess";
import { emitCorpus, type LeftOut, leftOutSchema } from "./emitCorpus";
import { producerDocuments } from "./producers";
import { workforceDocuments } from "./workforce";

const VITEST = join(WORKTREE, "node_modules", ".bin", "vitest");
/** What the fixed floor leaves out (`./emitCorpus.ts::leftOutDifferences`). */
const LEFT_OUT = join(WORKTREE, "proof", "corpus", "left-out.json");

/** A child's exit, with the tail of what it wrote. */
interface Finished {
	readonly code: number;
	readonly output: string;
}

/** Run a child to completion from the worktree root, keeping the tail of its output. */
function run(
	command: string,
	args: readonly string[],
	env: NodeJS.ProcessEnv,
): Promise<Finished> {
	return new Promise((resolveRun, reject) => {
		const child = spawn(command, [...args], {
			cwd: WORKTREE,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		const keep = (chunk: Buffer) => {
			output = (output + chunk.toString("utf8")).slice(-20_000);
		};
		child.stdout.on("data", keep);
		child.stderr.on("data", keep);
		child.on("error", reject);
		child.on("close", (code, signal) =>
			resolveRun({ code: code ?? (signal !== null ? 1 : 0), output }),
		);
	});
}

function seconds(since: number): number {
	return Math.round((performance.now() - since) / 10) / 100;
}

async function runVitestWriters(
	scratch: string,
	sample: number,
	seed: number,
): Promise<{ expander: string; sample: string }> {
	const expander = join(scratch, "expander");
	const sampleDir = join(scratch, "sample");
	const finished = await run(
		VITEST,
		[
			"run",
			"lib/commcare/__tests__/expander.test.ts",
			"proof/corpus/__tests__/fuzzSample.test.ts",
			"--project",
			"unit",
		],
		emissionEnv({
			// Vitest's own workers load the preload too.
			NODE_OPTIONS: `--import="${ENTROPY_PRELOAD}"`,
			NOVA_EXPANDER_EVIDENCE_DIR: expander,
			NOVA_CORPUS_SAMPLE_DIR: sampleDir,
			NOVA_CORPUS_SAMPLE_SIZE: String(sample),
			NOVA_CORPUS_SAMPLE_SEED: String(seed),
		}),
	);
	if (finished.code !== 0) {
		throw new Error(
			`The corpus's Vitest writers (the expander corpus and the fuzz sample) exited with status ${finished.code}, so the corpus would be incomplete. Their output ends:\n${finished.output}`,
		);
	}
	return { expander, sample: sampleDir };
}

/** The committed `left-out.json`, read by its schema. */
async function readLeftOut(): Promise<LeftOut> {
	const parsed = leftOutSchema.safeParse(
		JSON.parse(await readFile(LEFT_OUT, "utf8")),
	);
	if (!parsed.success) {
		throw new Error(
			`${LEFT_OUT} is not the list of what the fixed corpus leaves out ({documents: [{id, by, codes}], edits: [{id, by, codes, kind}]}, each list in id order): ${parsed.error.message}`,
		);
	}
	return parsed.data;
}

/**
 * Remove what an earlier emission into `out` wrote (its indexed documents,
 * `index.json`, `inputs.json` and `timings.json`), so no document of an
 * earlier corpus outlives it. Anything else in `out` is left alone.
 */
async function clearPreviousCorpus(out: string): Promise<void> {
	let previous: unknown;
	try {
		previous = JSON.parse(await readFile(join(out, "index.json"), "utf8"));
	} catch {
		return;
	}
	const ids = z
		.object({ documents: z.array(z.object({ id: z.string() })) })
		.safeParse(previous);
	if (!ids.success) return;
	for (const { id } of ids.data.documents) {
		if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
			await rm(join(out, id), { recursive: true, force: true });
		}
	}
	for (const file of ["index.json", "inputs.json", "timings.json"]) {
		await rm(join(out, file), { force: true });
	}
}

/**
 * The targeted documents (`documents.ts::TARGETED_MODULE`), when the
 * module that defines them exists in this checkout.
 */
async function targetedDocuments(): Promise<CorpusDocument[]> {
	const path = join(WORKTREE, TARGETED_MODULE);
	if (!existsSync(path)) return [];
	const loaded: unknown = await import(pathToFileURL(path).href);
	const define = (loaded as { targetedDocuments?: unknown }).targetedDocuments;
	if (typeof define !== "function") {
		throw new Error(
			`${TARGETED_MODULE} exports no targetedDocuments function, so the corpus cannot read the targeted documents.`,
		);
	}
	const documents = (await define()) as CorpusDocument[];
	for (const document of documents) {
		if (
			document.source?.kind !== "targeted" ||
			document.expected === undefined
		) {
			throw new Error(
				`${TARGETED_MODULE} gave the document ${JSON.stringify(document.id)} without a targeted source and its expected values.`,
			);
		}
	}
	return documents;
}

function wholeNumber(
	value: string | undefined,
	name: string,
	fallback: number,
) {
	if (value === undefined) return fallback;
	const number = Number(value);
	if (!Number.isSafeInteger(number) || number < 0) {
		throw new Error(
			`--${name} takes a whole number; got ${JSON.stringify(value)}.`,
		);
	}
	return number;
}

/** `--shard i/n`: the i-th of n shards, counting from one. */
function shardOf(value: string | undefined) {
	if (value === undefined) return undefined;
	const [index, count] = value.split("/").map(Number);
	if (
		index === undefined ||
		count === undefined ||
		!Number.isSafeInteger(index) ||
		!Number.isSafeInteger(count) ||
		count < 1 ||
		index < 1 ||
		index > count
	) {
		throw new Error(
			`--shard takes i/n, the i-th of n shards counting from 1; got ${JSON.stringify(value)}.`,
		);
	}
	return { index, count };
}

async function main(argv: readonly string[]): Promise<void> {
	// Every clock reading in this process is in UTC, as in its children.
	process.env.TZ = "UTC";
	const { values } = parseArgs({
		args: [...argv],
		options: {
			out: { type: "string" },
			sample: { type: "string" },
			seed: { type: "string" },
			jobs: { type: "string" },
			shard: { type: "string" },
		},
		strict: true,
	});
	if (values.out === undefined) {
		throw new Error(
			"Name the directory to write the corpus into: --out <dir> [--sample <n>] [--seed <n>] [--jobs <n>] [--shard <i>/<n>].",
		);
	}
	const shard = shardOf(values.shard);
	const out = resolve(values.out);
	const sample = wholeNumber(values.sample, "sample", DEFAULT_SAMPLE_SIZE);
	const seed = wholeNumber(values.seed, "seed", DEFAULT_CORPUS_SEED);
	const jobs = Math.max(
		1,
		wholeNumber(values.jobs, "jobs", Math.min(4, availableParallelism())),
	);
	const leftOut = await readLeftOut();
	await clearPreviousCorpus(out);
	const scratch = await mkdtemp(join(tmpdir(), "nova-corpus-"));
	try {
		const started = performance.now();
		const writers = await runVitestWriters(scratch, sample, seed);
		const vitestWritersSeconds = seconds(started);
		console.log(
			`Vitest writers (expander corpus, fuzz sample of ${sample} + ${DEFAULT_EXPRESSION_SAMPLE_SIZE} expressions + ${DEFAULT_ADVANCED_SAMPLE_SIZE} advanced at seed ${seed}) took ${vitestWritersSeconds} s.`,
		);

		const producers = producerDocuments();
		const fixed = [
			...producers,
			...workforceDocuments(producers),
			...(await readExpanderCapture(writers.expander)),
			...(await targetedDocuments()),
		];
		const sampled = await readFuzzSample(writers.sample);
		const position = new Map(
			[...fixed, ...sampled].map((document, at) => [document.id, at]),
		);
		const { index, timings } = await emitCorpus({
			out,
			seed,
			sample: sampled.length,
			fixed,
			sampled,
			...(shard !== undefined && {
				select: {
					label: `${shard.index}/${shard.count}`,
					includes: (id: string) =>
						(position.get(id) ?? -1) % shard.count === shard.index - 1,
				},
			}),
			requireEveryKind: true,
			leftOut,
			jobs,
			timings: { vitestWritersSeconds },
			log: (line) => console.log(line),
		});
		const perSample = Object.values(timings.perSampledDocumentSeconds);
		const mean =
			perSample.length === 0
				? 0
				: perSample.reduce((sum, value) => sum + value, 0) / perSample.length;
		console.log(
			`Corpus: ${index.documents.length} documents${shard === undefined ? "" : ` (shard ${shard.index}/${shard.count})`} in ${out}, ${index.entropy} entropy, in ${seconds(started)} s ` +
				`(fixed floor ${timings.fixedSeconds} s, sample ${timings.sampleSeconds} s, ${mean.toFixed(3)} s per sampled document).`,
		);
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

if (
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	main(process.argv.slice(2)).catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	});
}
