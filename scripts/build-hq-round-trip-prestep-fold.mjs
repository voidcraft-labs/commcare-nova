/**
 * Builds the HQ round-trip emission cutover's frozen pre-step fold:
 * `lib/db/canonicalMutationFold.ts::foldCanonicalAppChangeSuffixBounded`, as
 * the tree that holds the pre-step reducer and schema has it, bundled into one
 * self-contained ES module beside its inputs list.
 *
 *   node scripts/build-hq-round-trip-prestep-fold.mjs
 *
 * writes `scripts/lib/hqRoundTripCutover/prestep/prestepFold.generated.mjs`
 * and `prestepFold.inputs.json` (every input esbuild's metafile names, with
 * its SHA-256). The generated file is never edited by hand: a change to it is
 * a rebuild from the pre-step tree, and its digest test names the result.
 */

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url));
const PRESTEP_DIRECTORY = "scripts/lib/hqRoundTripCutover/prestep";
export const PRESTEP_FOLD_ENTRY = `${PRESTEP_DIRECTORY}/prestepFold.entry.ts`;
export const PRESTEP_FOLD_OUTPUT = `${PRESTEP_DIRECTORY}/prestepFold.generated.mjs`;
export const PRESTEP_FOLD_INPUTS = `${PRESTEP_DIRECTORY}/prestepFold.inputs.json`;

const HEADER = [
	"// biome-ignore-all lint: immutable generated cutover artifact",
	"// biome-ignore-all format: immutable generated cutover artifact",
	"/** IMMUTABLE HQ ROUND-TRIP EMISSION CUTOVER ARTIFACT. The pre-step canonical app-change fold (foldCanonicalAppChangeSuffixBounded), built once from the tree whose reducer wrote production's history. It is never edited by hand. */",
	"",
].join("\n");

/**
 * Bundle the entry with the maintenance bundles' options (`Dockerfile` stage
 * `maintenance-build`), in ESM, and return the module text and its inputs,
 * each a repository-relative path with the SHA-256 of its bytes.
 */
export async function buildPrestepFold() {
	const result = await build({
		absWorkingDir: REPOSITORY_ROOT,
		entryPoints: [PRESTEP_FOLD_ENTRY],
		bundle: true,
		platform: "node",
		target: "node24",
		format: "esm",
		conditions: ["react-server"],
		tsconfig: "tsconfig.json",
		metafile: true,
		write: false,
		logLevel: "silent",
	});
	const [output] = result.outputFiles;
	if (output === undefined || result.outputFiles.length !== 1) {
		throw new Error(
			`The pre-step fold should bundle to exactly one file; esbuild wrote ${result.outputFiles.length}.`,
		);
	}
	const inputs = [];
	for (const path of Object.keys(result.metafile.inputs).sort()) {
		const bytes = await readFile(new URL(path, pathToFileURL(REPOSITORY_ROOT)));
		inputs.push({
			path,
			sha256: createHash("sha256").update(bytes).digest("hex"),
		});
	}
	return { code: `${HEADER}${output.text}`, inputs };
}

if (
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	const { code, inputs } = await buildPrestepFold();
	await writeFile(
		new URL(PRESTEP_FOLD_OUTPUT, pathToFileURL(REPOSITORY_ROOT)),
		code,
	);
	await writeFile(
		new URL(PRESTEP_FOLD_INPUTS, pathToFileURL(REPOSITORY_ROOT)),
		`${JSON.stringify(inputs, null, "\t")}\n`,
	);
	console.log(
		`Wrote ${PRESTEP_FOLD_OUTPUT} (${Buffer.byteLength(code)} bytes, ${inputs.length} inputs).`,
	);
}
