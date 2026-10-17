/**
 * Captures the HQ round-trip emission cutover's frozen pre-step fixtures, in
 * the tree whose schema, reducer and emitter are still the pre-step ones.
 *
 *   node --conditions=react-server --import ./proof/corpus/entropy.mts \
 *     --import tsx scripts/lib/hqRoundTripCutover/__tests__/fixtures/capturePreStep.ts
 *
 * It emits the corpus's fixed floor at the corpus seed, writing only the
 * seventeen fixture documents (`./fixtureDocuments.ts`), exactly as the whole
 * corpus writes them, and keeps for each:
 *
 *   - under `proof/hq-reads/cutover/<document>/legacy/`, the bytes the
 *     pre-step publish sends for the document's minimum configuration
 *     (`create` and `republish`, body and sidecar, the lookup workbook where
 *     there is one), its local archive and its `configurations.json`, with
 *     `proof/hq-reads/cutover/legacy-manifest.json` naming each file's digest;
 *   - under `pre-step/<document>/`, the document's raw carriers as the writer
 *     stores them (`carriers.json`), the Project data a database needs to
 *     hold it (`project.json`) and its `paths.json`;
 *   - under `pre-step/<document>/histories/<name>/`, each history's baseline
 *     snapshot text, each change row's mutations text and the document after
 *     each row, every batch judged by the corpus's own edit admission.
 *
 * Then it writes the hand-built fixtures (`./handBuilt.ts`) and the manifest
 * (`pre-step/manifest.json`). The fixtures are never captured again once the
 * tree's shape changes; a rebase that changes what they hold captures them
 * again here.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { buildCaseTypeMap } from "@/lib/case-store/store";
import { runValidation } from "@/lib/commcare/validator/runner";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import {
	admitMutationBatch,
	encodeAdmittedMutationEnvelope,
} from "@/lib/doc/mutationAdmission";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc, PersistableDoc } from "@/lib/domain";
import { blueprintDocSchema } from "@/lib/domain";
import { caseTypeToJsonSchema } from "@/lib/domain/predicate/jsonSchema";
import { DEFAULT_CORPUS_SEED } from "@/proof/corpus/defaults";
import {
	type CorpusDocument,
	lookupContextOf,
	readExpanderCapture,
	TARGETED_MODULE,
} from "@/proof/corpus/documents";
import { admitEditBatch } from "@/proof/corpus/editBatches";
import {
	ENTROPY_PRELOAD,
	emissionEnv,
	WORKTREE,
} from "@/proof/corpus/emissionProcess";
import { emitCorpus } from "@/proof/corpus/emitCorpus";
import { producerDocuments } from "@/proof/corpus/producers";
import { workforceDocuments } from "@/proof/corpus/workforce";
import { readRawDocument } from "../../oldShape";
import { questionPaths } from "../../questionPaths";
import {
	FIXTURE_DOCUMENTS,
	HISTORIES,
	type HistorySpec,
} from "./fixtureDocuments";
import { HAND_BUILT_FIXTURES } from "./handBuilt";
import {
	carriersOf,
	type FixtureCarriers,
	type FixtureManifest,
	type FixtureProject,
	LEGACY_DIRECTORY,
	PRE_STEP_DIRECTORY,
} from "./preStep";

const VITEST = join(WORKTREE, "node_modules", ".bin", "vitest");

function sha256(bytes: Buffer | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(value, null, "\t")}\n`);
}

/** Format the written fixtures as the repository's formatter writes JSON. */
async function formatFixtures(): Promise<void> {
	const code = await new Promise<number>((resolve, reject) => {
		const child = spawn(
			join(WORKTREE, "node_modules", ".bin", "biome"),
			["format", "--write", PRE_STEP_DIRECTORY],
			{ cwd: WORKTREE, stdio: ["ignore", "ignore", "inherit"] },
		);
		child.on("error", reject);
		child.on("close", (exit) => resolve(exit ?? 1));
	});
	if (code !== 0) {
		throw new Error(`Biome could not format the fixtures (status ${code}).`);
	}
}

async function runExpanderWriter(directory: string): Promise<void> {
	const code = await new Promise<number>((resolve, reject) => {
		const child = spawn(
			VITEST,
			["run", "lib/commcare/__tests__/expander.test.ts", "--project", "unit"],
			{
				cwd: WORKTREE,
				env: emissionEnv({
					NODE_OPTIONS: `--import="${ENTROPY_PRELOAD}"`,
					NOVA_EXPANDER_EVIDENCE_DIR: directory,
				}),
				stdio: ["ignore", "ignore", "inherit"],
			},
		);
		child.on("error", reject);
		child.on("close", (exit) => resolve(exit ?? 1));
	});
	if (code !== 0) {
		throw new Error(
			`The expander corpus's Vitest writer exited with status ${code}, so the fixed floor would be incomplete.`,
		);
	}
}

async function targetedDocuments(): Promise<CorpusDocument[]> {
	const loaded = (await import(
		pathToFileURL(join(WORKTREE, TARGETED_MODULE)).href
	)) as { targetedDocuments: () => Promise<CorpusDocument[]> };
	return loaded.targetedDocuments();
}

/** The stored document of one emitted corpus entry, D or, with `edited`, D′. */
async function emittedDocument(
	corpus: string,
	id: string,
	edited: boolean,
): Promise<{ doc: PersistableDoc; lookup?: unknown; media?: unknown }> {
	const path = join(corpus, id, ...(edited ? ["edit"] : []), "document.json");
	return JSON.parse(await readFile(path, "utf8")) as {
		doc: PersistableDoc;
		lookup?: unknown;
		media?: unknown;
	};
}

function projectOf(emitted: {
	lookup?: unknown;
	media?: unknown;
}): FixtureProject {
	const media = (emitted.media ?? {}) as Record<
		string,
		{ kind: string; mimeType: string; extension: string; base64: string }
	>;
	return {
		...(emitted.lookup !== undefined && { lookup: emitted.lookup }),
		media: Object.fromEntries(
			Object.entries(media).map(([id, asset]) => {
				const bytes = Buffer.from(asset.base64, "base64");
				return [
					id,
					{
						kind: asset.kind,
						mimeType: asset.mimeType,
						extension: asset.extension,
						sizeBytes: bytes.length,
						sha256: sha256(bytes),
					},
				];
			}),
		),
	};
}

/** A corpus document's Project data, as a fixture records it. */
function projectOfCorpus(document: CorpusDocument): FixtureProject {
	return projectOf({
		...(document.lookup !== undefined && {
			lookup: {
				projectId: document.lookup.projectId,
				projectRevision: document.lookup.projectRevision,
				definitions: document.lookup.definitions,
				rowsByTable: Object.fromEntries(document.lookup.rowsByTable),
			},
		}),
		...(document.media !== undefined && {
			media: Object.fromEntries(
				[...document.media].map(([id, asset]) => [
					id,
					{
						kind: asset.kind,
						mimeType: asset.mimeType,
						extension: asset.extension,
						base64: asset.bytes.toString("base64"),
					},
				]),
			),
		}),
	});
}

async function writeDocumentFixture(
	directory: string,
	appId: string,
	doc: PersistableDoc,
	project: FixtureProject,
): Promise<FixtureCarriers> {
	const carriers = carriersOf(doc);
	await writeJsonFile(join(directory, "carriers.json"), carriers);
	await writeJsonFile(join(directory, "project.json"), project);
	await writeJsonFile(
		join(directory, "schemas.json"),
		Object.fromEntries(
			[...buildCaseTypeMap(admitted(doc))].map(([name, caseType]) => [
				name,
				caseTypeToJsonSchema(caseType),
			]),
		),
	);
	await writeJsonFile(
		join(directory, "paths.json"),
		questionPaths(readRawDocument(appId, carriers)),
	);
	return carriers;
}

function admitted(doc: PersistableDoc): BlueprintDoc {
	return hydratePersistedBlueprint(blueprintDocSchema.parse(doc));
}

/** Write one history: the baseline at sequence 1, then one change row per batch. */
async function writeHistory(
	directory: string,
	documentId: string,
	start: PersistableDoc,
	lookup: unknown,
	history: HistorySpec,
): Promise<void> {
	const root = join(directory, "histories", history.name);
	await writeJsonFile(join(root, "baseline.json"), {
		seq: 1,
		snapshotText: JSON.stringify(start),
	});
	let current = start;
	const rows: { seq: number; batchId: string; mutationsText: string }[] = [];
	const batches = history.batches(admitted(current));
	for (const [index, build] of batches.entries()) {
		const mutations: readonly Mutation[] = build(admitted(current));
		const verdict = admitEditBatch(
			{
				id: `${documentId} history ${history.name}`,
				doc: current,
				...(lookup !== undefined && {
					lookup: lookup as never,
				}),
			},
			mutations,
		);
		if (!verdict.ok) {
			throw new Error(
				`History ${history.name} of ${documentId}: batch ${index + 1} was refused (${verdict.codes.join(", ")}${verdict.error === undefined ? "" : `: ${verdict.error}`}).`,
			);
		}
		const seq = index + 2;
		rows.push({
			seq,
			batchId: `history:${history.name}:${seq}`,
			mutationsText: encodeAdmittedMutationEnvelope(
				admitMutationBatch(verdict.mutations),
			).json,
		});
		current = toPersistableDoc(verdict.nextDoc);
		await writeDocumentFixture(
			join(root, `after-${seq}`),
			documentId,
			current,
			{},
		);
	}
	await writeJsonFile(join(root, "rows.json"), rows);
}

async function main(): Promise<void> {
	process.env.TZ = "UTC";
	const scratch = await mkdtemp(join(tmpdir(), "nova-prestep-capture-"));
	try {
		const expander = join(scratch, "expander");
		await runExpanderWriter(expander);
		const producers = producerDocuments();
		const fixed = [
			...producers,
			...workforceDocuments(producers),
			...(await readExpanderCapture(expander)),
			...(await targetedDocuments()),
		];
		const wanted = new Set(FIXTURE_DOCUMENTS.map((fixture) => fixture.id));
		const corpus = join(scratch, "corpus");
		await emitCorpus({
			out: corpus,
			seed: DEFAULT_CORPUS_SEED,
			sample: 0,
			fixed,
			sampled: [],
			select: { label: "cutover fixtures", includes: (id) => wanted.has(id) },
			requireEveryKind: true,
			jobs: 1,
			log: (line) => console.log(line),
		});

		const legacyManifest: Record<string, string> = {};
		const manifest: FixtureManifest = { fixtures: [] };
		for (const fixture of FIXTURE_DOCUMENTS) {
			const source = join(corpus, fixture.id);
			const legacy = join(LEGACY_DIRECTORY, fixture.id, "legacy");
			await rm(legacy, { recursive: true, force: true });
			await mkdir(legacy, { recursive: true });
			const files: [string, string][] = [
				[join(source, "export", "minimum", "create.body"), "create.body"],
				[join(source, "export", "minimum", "create.json"), "create.json"],
				[join(source, "export", "minimum", "republish.body"), "republish.body"],
				[join(source, "export", "minimum", "republish.json"), "republish.json"],
				[join(source, "local.ccz"), "local.ccz"],
				[join(source, "configurations.json"), "configurations.json"],
			];
			for (const name of ["lookups.body", "lookups.json"]) {
				try {
					await readFile(join(source, "export", "minimum", name));
					files.push([join(source, "export", "minimum", name), name]);
				} catch {
					// The capture writes a workbook only for a document with tables.
				}
			}
			for (const [from, name] of files) {
				const bytes = await readFile(from);
				await writeFile(join(legacy, name), bytes);
				legacyManifest[relative(LEGACY_DIRECTORY, join(legacy, name))] =
					sha256(bytes);
			}

			const emitted = await emittedDocument(corpus, fixture.id, fixture.edited);
			const directory = join(PRE_STEP_DIRECTORY, fixture.id);
			await rm(directory, { recursive: true, force: true });
			const carriers = await writeDocumentFixture(
				directory,
				fixture.id,
				emitted.doc,
				projectOf(emitted),
			);
			for (const history of HISTORIES.filter(
				(entry) => entry.document === fixture.id,
			)) {
				await writeHistory(
					directory,
					fixture.id,
					emitted.doc,
					emitted.lookup,
					history,
				);
			}
			manifest.fixtures.push({
				id: fixture.id,
				kind: "corpus",
				digest: sha256(JSON.stringify(carriers)),
				steps: fixture.witnesses.steps,
				blockers: fixture.witnesses.blockers,
				reasons: fixture.witnesses.reasons,
			});
		}
		const bases = new Map(fixed.map((document) => [document.id, document]));
		const base = (id: string): BlueprintDoc => {
			const document = bases.get(id);
			if (document === undefined) {
				throw new Error(`No corpus document ${id} to build a fixture from.`);
			}
			return admitted(document.doc);
		};
		for (const fixture of HAND_BUILT_FIXTURES) {
			const doc = toPersistableDoc(fixture.build(base));
			const source =
				fixture.projectFrom === undefined
					? undefined
					: bases.get(fixture.projectFrom);
			const project =
				fixture.project ??
				(source === undefined ? {} : projectOfCorpus(source));
			const parsed = blueprintDocSchema.safeParse(doc);
			if (!parsed.success) {
				throw new Error(
					`Hand-built fixture ${fixture.id} does not parse under the pre-step schema: ${parsed.error.message}`,
				);
			}
			const findings = runValidation(
				hydratePersistedBlueprint(parsed.data),
				lookupContextOf(project.lookup as never),
			);
			if (findings.length > 0) {
				throw new Error(
					`Hand-built fixture ${fixture.id} fails the pre-step gate (${[...new Set(findings.map((finding) => `${finding.code}: ${finding.message}`))].join("; ")}).`,
				);
			}
			const directory = join(PRE_STEP_DIRECTORY, fixture.id);
			await rm(directory, { recursive: true, force: true });
			const carriers = await writeDocumentFixture(
				directory,
				fixture.id,
				doc,
				project,
			);
			if (fixture.storedSchemas !== undefined) {
				const derived = JSON.parse(
					await readFile(join(directory, "schemas.json"), "utf8"),
				) as Record<string, unknown>;
				await writeJsonFile(
					join(directory, "schemas.json"),
					fixture.storedSchemas(derived),
				);
			}
			manifest.fixtures.push({
				id: fixture.id,
				kind: "hand-built",
				digest: sha256(JSON.stringify(carriers)),
				steps: fixture.witnesses.steps,
				blockers: fixture.witnesses.blockers,
				reasons: fixture.witnesses.reasons,
			});
		}
		await writeJsonFile(
			join(LEGACY_DIRECTORY, "legacy-manifest.json"),
			Object.fromEntries(
				Object.entries(legacyManifest).sort(([a], [b]) => (a < b ? -1 : 1)),
			),
		);
		await writeJsonFile(join(PRE_STEP_DIRECTORY, "manifest.json"), manifest);
		await formatFixtures();
		console.log(
			`Captured ${FIXTURE_DOCUMENTS.length} corpus fixtures, ${HISTORIES.length} histories and ${HAND_BUILT_FIXTURES.length} hand-built fixtures.`,
		);
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

main().catch((error: unknown) => {
	console.error(
		error instanceof Error ? (error.stack ?? error.message) : error,
	);
	process.exitCode = 1;
});
