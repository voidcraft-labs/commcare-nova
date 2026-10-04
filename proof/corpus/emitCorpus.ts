/**
 * Writes the proof corpus: every admitted corpus document with its edit
 * batch, configurations, Nova's publish verdict, the upload bodies Nova's
 * publish sends under each configuration, its local exports and its input
 * manifest, in the layout the checks read (`proof/checks/corpus.py`):
 *
 *   <out>/index.json                  {seed, sample, entropy, shard?, documents, hq, census}
 *   <out>/inputs.json                 each document's input manifest digest (`./inputs.ts`)
 *   <out>/timings.json                what each part took (the one file that
 *                                     differs between two emissions)
 *   <out>/<id>/document.json          D (stored form) with its lookup snapshot,
 *                                     uploaded media, source and wire placement
 *                                     (`wire.modules`, `wire.languages`)
 *   <out>/<id>/configurations.json    {minimum, maximum, singleFlag}, without
 *                                     the privileges HQ derives (`./configurations.ts`)
 *   <out>/<id>/verdict.json           Nova's publish verdict for D
 *   <out>/<id>/expected.json          a targeted document's intent values
 *   <out>/<id>/<name>.xml|.json       a targeted document's own files its
 *                                     expectations read (restores)
 *   <out>/<id>/export/<config>/       create, republish, lookups and media
 *                                     (.body + .json), and outcome.json
 *   <out>/<id>/local.ccz, local-again.ccz
 *   <out>/<id>/edit/batch.json        the batch, its kinds, touched entities
 *                                     and footprint
 *   <out>/<id>/edit/document.json     D′ (the commit gate's nextDoc)
 *   <out>/<id>/edit/verdict.json      Nova's publish verdict for D′
 *   <out>/<id>/edit/export/<config>/  update (with lookups and media), and
 *                                     outcome.json
 *   <out>/<id>/edit/local.ccz
 *   <out>/<id>/inputs.json            the document's input manifest
 *
 * `<config>` is `minimum`, `maximum`, or a single-flag configuration's flag
 * symbol (`./configurations.ts`).
 *
 * A document Nova's publish or local export refuses is not a corpus
 * document: it is left out and named, with the boundary's findings, in the
 * census. A document that fails the strict schema or full validation stops
 * the emission, since every source constructs admitted documents.
 *
 * Each part's census names, per mutation kind, the documents whose written
 * edit batch was drawn for it (`landed`). With `requireEveryKind`, a kind
 * that lands on no fixed document stops the emission before any document
 * is written, naming the kind with what refused it: the corpus draws every
 * mutation kind the reducer defines, and the fixed floor is the part whose
 * batches the sample's size never changes.
 *
 * Admission and edit batches run in this process (the fixed floor's batches
 * are balanced across the floor's producer, workforce and expander
 * documents; a targeted document carries only the edit written for it, if
 * any, so adding one changes no other document's batch); each document's
 * directory is then
 * written by `./entryWriter.ts`, here or, with `jobs` above one, by that
 * many worker processes (`./emitWorker.ts`) splitting the documents.
 *
 * Every file but `timings.json` is the same, byte for byte, on every run
 * at one seed, wherever it runs: each export draws its minted identities
 * from a generator seeded by the corpus seed, its ordinal and its
 * configuration (`./entropy.mts`), and every child process runs with a
 * whitelisted environment (`./emissionProcess.ts`). With `select`, only the
 * selected documents are written, each exactly as the whole corpus writes
 * it: admission and edit batches still run over every document.
 */

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	mediaIds,
	mediaManifest,
} from "@/lib/commcare/__tests__/mediaWireFixtures";
import type { ValidationError } from "@/lib/commcare/validator/errors";
import { runValidation } from "@/lib/commcare/validator/runner";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { type BlueprintDoc, blueprintDocSchema } from "@/lib/domain";
import { type MediaSlotKind, walkAssetRefs } from "@/lib/domain/mediaRefs";
import { mediaAssetIdSchema } from "@/lib/domain/multimedia";
import {
	type CorpusDocument,
	type CorpusSource,
	lookupContextOf,
	storedDocument,
} from "./documents";
import {
	documentsByKind,
	EDIT_KINDS,
	type EditCensus,
	editBatchCorpus,
	formatCensus,
	type KeptEditBatch,
	type MutationKind,
	publishFindings,
	writtenEditBatch,
} from "./editBatches";
import { emissionEnv, NODE_EMISSION_ARGS, WORKTREE } from "./emissionProcess";
import { entropySeeded } from "./entropy.mts";
import {
	entryJob,
	type IndexEntry,
	type PreparedEdit,
	type PreparedEntry,
	type WrittenEntry,
	writeEntry,
	writeJson,
} from "./entryWriter";
import { batchFootprint } from "./footprint";
import { writeCorpusInputs } from "./inputs";
import {
	exportFindings,
	type PublishDocument,
	type UploadedMedia,
} from "./publish";

export type { IndexEntry } from "./entryWriter";

const WORKER = join(WORKTREE, "proof", "corpus", "emitWorker.ts");

export interface EmitInput {
	readonly out: string;
	/** The seed of the fuzz sample, of every edit batch and of every export's minted identities. */
	readonly seed: number;
	/** The size of the fuzz sample the caller drew. */
	readonly sample: number;
	/** The fixed floor: the producers', workforce, expander and targeted documents. */
	readonly fixed: readonly CorpusDocument[];
	/** The fuzz sample. */
	readonly sampled: readonly CorpusDocument[];
	/**
	 * The documents to write, when not all: every document is still admitted
	 * and given its edit batch, so each selected one is written exactly as
	 * the whole corpus writes it.
	 */
	readonly select?: {
		readonly label: string;
		readonly includes: (id: string) => boolean;
	};
	/** Worker processes that write the documents' directories; one (the default) writes them here. */
	readonly jobs?: number;
	/**
	 * Stop, before writing any document, when some mutation kind the reducer
	 * defines lands on no fixed document (no fixed document's written edit
	 * batch is drawn for it). The lane's emission (`./emit.ts`) sets it; a
	 * caller emitting a handful of documents leaves it off.
	 */
	readonly requireEveryKind?: boolean;
	/** HQ's self-check apps already written under `<out>/hq/`, listed in the index. */
	readonly hq?: readonly HqIndexEntry[];
	/** Further timings the caller measured (the Vitest writers, the HQ side), in seconds. */
	readonly timings?: Readonly<Record<string, number>>;
	readonly log?: (line: string) => void;
}

/** One HQ self-check app under `<out>/hq/<id>/`, as `python -m proof.corpus.hq` lists it. */
export interface HqIndexEntry {
	readonly id: string;
	readonly source: Readonly<Record<string, unknown>>;
	readonly group: string;
	/** `app.json` (an app as HQ's import receives it) or `app.ccz` (an HQ-built archive). */
	readonly file: "app.json" | "app.ccz";
}

/** A document left out of the corpus, and why. */
export interface RefusedDocument {
	readonly id: string;
	readonly source: CorpusSource;
	/** What refused it: Nova's publish checks, its direct HQ upload, or its local export. */
	readonly by: "publish" | "hq-upload" | "ccz";
	readonly codes: readonly string[];
	/** For an edit left out, the kind its batch was drawn for. */
	readonly kind?: MutationKind;
}

export interface PartCensus {
	readonly documents: number;
	readonly emitted: number;
	/** Emitted documents by source (`producer:<family>`, `workforce`, `expander`, `fuzz:<generator>`, `targeted`). */
	readonly bySource: Readonly<Record<string, number>>;
	readonly refused: readonly RefusedDocument[];
	/** Documents whose edit batch Nova's publish or local export refuses, so they carry none. */
	readonly editsRefused: readonly RefusedDocument[];
	/** Documents the edit generator kept no batch for (a targeted document is given none, so it is not listed). */
	readonly withoutEdit: readonly string[];
	readonly edits: EditCensus;
	/**
	 * Per mutation kind, the documents whose written edit batch was drawn for
	 * it: the generator's admissions (`edits`) less the edits Nova's publish
	 * or local export refuses (`editsRefused`).
	 */
	readonly landed: Readonly<Record<MutationKind, readonly string[]>>;
}

export interface CorpusIndex {
	readonly seed: number;
	readonly sample: number;
	/**
	 * Whether each export's minted identities were drawn from its seeded
	 * generator (`./entropy.mts`), or as Nova draws them
	 * (`PROOF_ENTROPY=real`), which no two runs repeat.
	 */
	readonly entropy: "seeded" | "real";
	/** The selection written, when not every document was (`EmitInput.select`). */
	readonly selection?: string;
	readonly documents: readonly IndexEntry[];
	readonly hq: readonly HqIndexEntry[];
	readonly census: {
		readonly fixed: PartCensus;
		readonly sample: PartCensus;
	};
}

/** What each part of an emission took, written beside the index as `timings.json`. */
export interface CorpusTimings {
	/** Emitting the fixed floor: admission, edit batches, captures, exports and files. */
	readonly fixedSeconds: number;
	/** Emitting the sample, likewise. */
	readonly sampleSeconds: number;
	/**
	 * Per sampled document: its admission, its share of the sample's edit
	 * batches and its captures, exports and files, however many worker
	 * processes shared the writing.
	 */
	readonly perSampledDocumentSeconds: Readonly<Record<string, number>>;
	readonly jobs: number;
	readonly [part: string]: unknown;
}

export interface EmittedCorpus {
	readonly index: CorpusIndex;
	readonly timings: CorpusTimings;
}

/** The fixed floor carries no written edit batch drawn for some mutation kinds. */
export class UnlandedKindsError extends Error {
	constructor(
		readonly kinds: readonly MutationKind[],
		message: string,
	) {
		super(message);
		this.name = "UnlandedKindsError";
	}
}

// ── Admission ────────────────────────────────────────────────────────

/** The document as Nova's load boundary reads it; throws unless it is admitted. */
function admittedDoc(document: CorpusDocument): BlueprintDoc {
	const parsed = blueprintDocSchema.safeParse(document.doc);
	if (!parsed.success) {
		throw new Error(
			`Corpus document ${document.id} does not parse under Nova's strict blueprint schema: ${parsed.error.message}. Every corpus source constructs admitted documents, so its source changed.`,
		);
	}
	const doc = hydratePersistedBlueprint(parsed.data);
	const findings = runValidation(doc, lookupContextOf(document.lookup));
	if (findings.length > 0) {
		throw new Error(
			`Corpus document ${document.id} parses but full validation reports ${codes(findings).join(", ")}. Every corpus source constructs admitted documents, so its source changed.`,
		);
	}
	return doc;
}

function codes(findings: readonly ValidationError[]): string[] {
	return [...new Set(findings.map((finding) => finding.code))].sort();
}

function publishDocument(
	document: CorpusDocument,
	compiledAtSeq: number,
	doc = document.doc,
	media = document.media,
): PublishDocument {
	return {
		id: document.id,
		doc,
		compiledAtSeq,
		...(document.lookup !== undefined && { lookup: document.lookup }),
		...(media !== undefined && { media }),
	};
}

/** Why Nova's publish or local export refuses the document, or `undefined` when both take it. */
async function refusal(
	source: PublishDocument,
	doc: BlueprintDoc,
): Promise<Pick<RefusedDocument, "by" | "codes"> | undefined> {
	const publish = publishFindings(doc, source.lookup);
	if (publish.length > 0) return { by: "publish", codes: codes(publish) };
	for (const mode of ["hq-upload", "ccz"] as const) {
		const findings = await exportFindings(source, mode);
		if (findings.length > 0) return { by: mode, codes: codes(findings) };
	}
	return undefined;
}

/**
 * The upload an edit's new media slot holds: one real, decodable file per
 * kind, from the media family's fixture (`mediaWireFixtures.ts::mediaManifest`).
 */
const EDIT_UPLOADS: Readonly<Record<MediaSlotKind, UploadedMedia>> = (() => {
	const manifest = mediaManifest();
	const upload = (id: string): UploadedMedia => {
		const asset = manifest.get(id as never);
		if (asset?.bytes === undefined) {
			throw new Error(`The media fixture has no bytes for ${id}.`);
		}
		return {
			kind: asset.kind,
			mimeType: asset.mimeType,
			extension: asset.extension,
			bytes: Buffer.from(asset.bytes),
		};
	};
	return {
		image: upload(mediaIds.label),
		audio: upload(mediaIds.audio),
		video: upload(mediaIds.video),
	};
})();

/**
 * The uploads D′ references: D's own, and for each asset an edit newly
 * attached (the edit generator mints its id), the fixture upload of its
 * slot's kind, as the Project would hold after the edit's upload.
 */
function editedMedia(
	document: CorpusDocument,
	nextDoc: BlueprintDoc,
): ReadonlyMap<string, UploadedMedia> | undefined {
	const media = new Map(document.media ?? []);
	for (const ref of walkAssetRefs(nextDoc)) {
		if (!mediaAssetIdSchema.safeParse(ref.assetId).success) continue;
		if (!media.has(ref.assetId)) {
			media.set(ref.assetId, EDIT_UPLOADS[ref.slotKind]);
		}
	}
	return media.size === 0 ? undefined : media;
}

/**
 * The edit written for a targeted document (`CorpusDocument.edit`) as its
 * batch, D′ held to the admission every corpus document's D is; none for
 * a document without one.
 */
function targetedBatch(
	document: CorpusDocument,
	doc: BlueprintDoc,
	seed: number,
): KeptEditBatch | undefined {
	if (document.edit === undefined) return undefined;
	const nextDoc = admittedDoc({
		...document,
		id: `${document.id}'s written edit`,
		doc: document.edit.nextDoc,
	});
	return writtenEditBatch(
		document.id,
		seed,
		doc,
		document.edit.mutations,
		nextDoc,
	);
}

// ── Writing ──────────────────────────────────────────────────────────

/** Run one worker process over one job, and read what it wrote. */
async function runWorker(
	scratch: string,
	index: number,
	out: string,
	seed: number,
	entries: readonly PreparedEntry[],
): Promise<WrittenEntry[]> {
	const jobPath = join(scratch, `job-${index}.json`);
	const resultPath = join(scratch, `result-${index}.json`);
	await writeFile(
		jobPath,
		JSON.stringify({
			out,
			seed,
			entries: entries.map((entry) => entryJob(entry)),
		}),
	);
	const { code, signal, output } = await new Promise<{
		code: number | null;
		signal: NodeJS.Signals | null;
		output: string;
	}>((settle, reject) => {
		const child = spawn(
			process.execPath,
			[...NODE_EMISSION_ARGS, WORKER, jobPath, resultPath],
			{ cwd: WORKTREE, env: emissionEnv(), stdio: ["ignore", "pipe", "pipe"] },
		);
		let text = "";
		const keep = (chunk: Buffer) => {
			text = (text + chunk.toString("utf8")).slice(-20_000);
		};
		child.stdout.on("data", keep);
		child.stderr.on("data", keep);
		child.on("error", reject);
		child.on("close", (exit, stopped) =>
			settle({ code: exit, signal: stopped, output: text }),
		);
	});
	if (code !== 0) {
		// A process the system stops (out of memory, say) writes nothing of
		// its own, so the signal is what says why.
		const ended =
			signal !== null
				? `was stopped by ${signal}${signal === "SIGKILL" ? " (unless someone stopped it, the machine or its container ran out of memory)" : ""}`
				: `exited with status ${code}`;
		throw new Error(
			`A corpus worker process (job ${index}, ${entries.length} documents from ${entries[0]?.document.id}) ${ended}. Its output ends:\n${output}`,
		);
	}
	return JSON.parse(await readFile(resultPath, "utf8")) as WrittenEntry[];
}

/**
 * The fewest documents a worker process is started for: each one loads
 * Nova's modules before it writes, which costs about as much as writing
 * several documents.
 */
const DOCUMENTS_PER_WORKER = 8;

/**
 * Write every prepared document's directory, here or split across up to
 * `jobs` worker processes (documents dealt out in turn, so each takes a
 * similar mix). Every worker is joined before this returns; the results
 * keep the documents' order.
 */
async function writeEntries(
	out: string,
	prepared: readonly PreparedEntry[],
	jobs: number,
	seed: number,
): Promise<WrittenEntry[]> {
	const count = Math.min(
		jobs,
		Math.ceil(prepared.length / DOCUMENTS_PER_WORKER),
	);
	if (count <= 1) {
		const written: WrittenEntry[] = [];
		for (const entry of prepared) {
			written.push(await writeEntry(out, entry, seed));
		}
		return written;
	}
	const scratch = await mkdtemp(join(tmpdir(), "nova-corpus-jobs-"));
	try {
		const shares = Array.from({ length: count }, (_, job) =>
			prepared.filter((_, index) => index % count === job),
		);
		const settled = await Promise.allSettled(
			shares.map((share, job) => runWorker(scratch, job, out, seed, share)),
		);
		const failures = settled.flatMap((result) =>
			result.status === "rejected" ? [result.reason] : [],
		);
		if (failures.length > 0) {
			throw failures[0] instanceof Error
				? failures[0]
				: new Error(String(failures[0]));
		}
		const byId = new Map(
			settled.flatMap((result) =>
				result.status === "fulfilled"
					? result.value.map((entry) => [entry.index.id, entry] as const)
					: [],
			),
		);
		return prepared.map(({ document }) => {
			const entry = byId.get(document.id);
			if (entry === undefined) {
				throw new Error(
					`No corpus worker wrote ${document.id}, though one was given it.`,
				);
			}
			return entry;
		});
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

// ── The corpus ───────────────────────────────────────────────────────

function sourceKey(source: CorpusSource): string {
	switch (source.kind) {
		case "producer":
			return `producer:${source.family}`;
		case "workforce":
			return "workforce";
		case "expander":
			return "expander";
		case "fuzz":
			return `fuzz:${source.generator}`;
		case "targeted":
			return "targeted";
	}
}

interface PartResult {
	readonly written: WrittenEntry[];
	readonly census: PartCensus;
	readonly perDocumentSeconds: Map<string, number>;
	readonly seconds: number;
}

/**
 * Admit, edit, capture and write one part of the corpus. The fixed floor's
 * edit batches are balanced across it (`editBatchCorpus`'s fixed list); a
 * sampled document's batch is its own.
 */
async function emitPart(
	input: EmitInput,
	documents: readonly CorpusDocument[],
	part: "fixed" | "sample",
): Promise<PartResult> {
	const started = performance.now();
	const perDocument = new Map<string, number>();
	const refused: RefusedDocument[] = [];
	const admitted: { document: CorpusDocument; doc: BlueprintDoc }[] = [];
	for (const document of documents) {
		const t = performance.now();
		const doc = admittedDoc(document);
		const why = await refusal(publishDocument(document, 1), doc);
		if (why === undefined) admitted.push({ document, doc });
		else refused.push({ id: document.id, source: document.source, ...why });
		perDocument.set(document.id, performance.now() - t);
	}

	// A targeted document's symptom is fixed by what it holds, so it carries
	// no generated edit (only the one written for it, `targetedBatch`), and
	// the floor's batches are balanced without it.
	const editInputs = admitted
		.filter(({ document }) => document.source.kind !== "targeted")
		.map(({ document }) => ({
			id: document.id,
			doc: document.doc,
			...(document.lookup !== undefined && { lookup: document.lookup }),
		}));
	const t = performance.now();
	const { outcomes, census: edits } = editBatchCorpus(
		part === "fixed"
			? { fixed: editInputs, sampled: [] }
			: { fixed: [], sampled: editInputs },
		input.seed,
	);
	const editShare = (performance.now() - t) / Math.max(admitted.length, 1);
	const batchOf = new Map(
		outcomes.flatMap((outcome) =>
			outcome.batch === undefined
				? []
				: [[outcome.documentId, outcome.batch] as const],
		),
	);

	const editsRefused: RefusedDocument[] = [];
	const withoutEdit: string[] = [];
	const prepared: PreparedEntry[] = [];
	for (const { document, doc } of admitted) {
		const t = performance.now();
		const batch =
			batchOf.get(document.id) ?? targetedBatch(document, doc, input.seed);
		let edit: PreparedEdit | undefined;
		if (batch === undefined) {
			if (document.source.kind !== "targeted") withoutEdit.push(document.id);
		} else {
			const editPublish = publishDocument(
				document,
				2,
				storedDocument(batch.nextDoc),
				editedMedia(document, batch.nextDoc),
			);
			const why = await refusal(editPublish, batch.nextDoc);
			if (why === undefined) {
				edit = {
					batch,
					nextDoc: batch.nextDoc,
					publish: editPublish,
					footprint: batchFootprint(
						doc,
						batch.nextDoc,
						batch.mutations,
						document.lookup,
					),
				};
			} else {
				editsRefused.push({
					id: document.id,
					source: document.source,
					...why,
					kind: batch.intendedKind,
				});
			}
		}
		prepared.push({
			document,
			doc,
			publish: publishDocument(document, 1),
			...(edit !== undefined && { edit }),
		});
		perDocument.set(
			document.id,
			(perDocument.get(document.id) ?? 0) + performance.now() - t + editShare,
		);
	}

	const landed = documentsByKind(
		prepared.flatMap(({ document, edit }) =>
			edit === undefined
				? []
				: [{ documentId: document.id, intendedKind: edit.batch.intendedKind }],
		),
	);
	if (part === "fixed" && input.requireEveryKind === true) {
		const unlanded = EDIT_KINDS.filter((kind) => landed[kind].length === 0);
		if (unlanded.length > 0) {
			throw new UnlandedKindsError(
				unlanded,
				unlandedKindsMessage(unlanded, edits, editsRefused),
			);
		}
	}

	const selected =
		input.select === undefined
			? prepared
			: prepared.filter(({ document }) => input.select?.includes(document.id));
	const written = await writeEntries(
		input.out,
		selected,
		input.jobs ?? 1,
		input.seed,
	);
	for (const entry of written) {
		perDocument.set(
			entry.index.id,
			(perDocument.get(entry.index.id) ?? 0) + entry.milliseconds,
		);
	}

	const bySource: Record<string, number> = {};
	for (const { source } of written) {
		const key = sourceKey(source);
		bySource[key] = (bySource[key] ?? 0) + 1;
	}
	return {
		written,
		perDocumentSeconds: new Map(
			[...perDocument].map(([id, ms]) => [id, round(ms / 1000)]),
		),
		seconds: round((performance.now() - started) / 1000),
		census: {
			documents: documents.length,
			emitted: written.length,
			bySource,
			refused,
			editsRefused,
			withoutEdit,
			edits,
			landed,
		},
	};
}

/**
 * Why the fixed floor carries no batch of each of `kinds`: where the kind
 * could be drawn, what refused it, and which drawn batches Nova's publish or
 * local export then refused.
 */
function unlandedKindsMessage(
	kinds: readonly MutationKind[],
	edits: EditCensus,
	editsRefused: readonly RefusedDocument[],
): string {
	const lines = kinds.map((kind) => {
		const census = edits.kinds[kind];
		const refusals = Object.entries(census.refused)
			.sort((a, b) => b[1] - a[1])
			.map(([code, count]) => `${code}×${count}`);
		const dropped = editsRefused
			.filter((refused) => refused.kind === kind)
			.map(
				(refused) =>
					`${refused.id} (Nova's ${refused.by === "ccz" ? "local export" : "publish"} refuses the edited document: ${refused.codes.join(", ")})`,
			);
		// A try where the kind proposed nothing judged nothing; a fixed
		// document it proposes on but was never judged on took another
		// kind's batch first.
		const targets = census.fixedTargets;
		const judged = census.tried - census.inapplicable;
		const unjudged = targets - judged;
		const offered = `${targets} fixed ${targets === 1 ? "document gives" : "documents give"} it something to edit`;
		const where =
			targets === 0
				? "no fixed document gives it anything to edit"
				: judged === 0
					? `${offered}, and ${targets === 1 ? "it carries" : "each carries"} another kind's batch`
					: [
							`${offered}; Nova judged it on ${judged}`,
							unjudged > 0
								? ` (the other ${unjudged} ${unjudged === 1 ? "carries" : "carry"} another kind's batch)`
								: "",
							refusals.length > 0
								? ` and refused it (${refusals.join(" ")})`
								: "",
						].join("");
		return [
			`  ${kind}: ${where}`,
			dropped.length > 0 ? `; drawn but left out: ${dropped.join("; ")}` : "",
		].join("");
	});
	return [
		`The corpus's fixed floor carries no edit batch drawn for ${kinds.join(", ")}, so proofs 1 and 5 would never see ${kinds.length === 1 ? "that edit" : "those edits"}.`,
		...lines,
		"A kind no fixed document gives anything to edit needs a fixed document that holds what it edits (./workforce.ts adds the worker, organization and automation entities no producer holds). A kind whose documents all carry other batches needs more such documents, and a refused kind needs its refusals looked at.",
	].join("\n");
}

function round(seconds: number): number {
	return Math.round(seconds * 1000) / 1000;
}

/**
 * How many mutation kinds a written edit batch was drawn for, and, for the
 * fixed floor (which must hold them all), which none was.
 */
function landedLine(
	landed: Readonly<Record<MutationKind, readonly string[]>>,
	listMissing: boolean,
): string {
	const missing = EDIT_KINDS.filter((kind) => landed[kind].length === 0);
	return [
		`  ${EDIT_KINDS.length - missing.length} of ${EDIT_KINDS.length} mutation kinds land on a written edit batch`,
		listMissing && missing.length > 0
			? ` (none for ${missing.join(", ")})`
			: "",
	].join("");
}

/** A part's census as lines for the log. */
export function formatPartCensus(
	name: string,
	census: PartCensus,
	part: "fixed" | "sample",
): string {
	const lines = [
		`${name}: ${census.emitted} of ${census.documents} documents emitted`,
		...Object.entries(census.bySource)
			.sort((a, b) => (a[0] < b[0] ? -1 : 1))
			.map(([source, count]) => `  ${source} ${count}`),
		...census.refused.map(
			(r) =>
				`  left out ${r.id}: Nova's ${r.by === "ccz" ? "local export" : "publish"} refuses it (${r.codes.join(", ")})`,
		),
		...census.editsRefused.map(
			(r) =>
				`  no edit for ${r.id}: Nova's ${r.by === "ccz" ? "local export" : "publish"} refuses the document its ${r.kind ?? "edit"} batch leaves (${r.codes.join(", ")})`,
		),
		...(census.withoutEdit.length > 0
			? [`  no kept edit batch: ${census.withoutEdit.join(", ")}`]
			: []),
		landedLine(census.landed, part === "fixed"),
		formatCensus(census.edits),
	];
	return lines.join("\n");
}

/**
 * Emit the corpus into `input.out` and write `index.json`, `inputs.json`
 * and `timings.json`. Returns the index and the timings. Each corpus
 * document's directory is replaced; anything else in the directory (HQ's
 * self-check apps under `hq/`) is left alone.
 */
export async function emitCorpus(input: EmitInput): Promise<EmittedCorpus> {
	const log = input.log ?? (() => {});
	const ids = new Set<string>();
	for (const document of [...input.fixed, ...input.sampled]) {
		if (ids.has(document.id)) {
			throw new Error(
				`Two corpus documents share the id ${document.id}; each names its own directory.`,
			);
		}
		if (
			document.id === "hq" ||
			!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(document.id)
		) {
			throw new Error(
				`The corpus document id ${JSON.stringify(document.id)} cannot name a directory beside hq/: use letters, digits, dots, dashes and underscores.`,
			);
		}
		ids.add(document.id);
	}
	await mkdir(input.out, { recursive: true });
	const jobs = Math.max(1, input.jobs ?? 1);

	const fixed = await emitPart(input, input.fixed, "fixed");
	log(formatPartCensus("Fixed floor", fixed.census, "fixed"));
	log(`Fixed floor emitted in ${fixed.seconds} s (${jobs} writer processes).`);
	const sample = await emitPart(input, input.sampled, "sample");
	log(formatPartCensus("Fuzz sample", sample.census, "sample"));
	log(`Fuzz sample emitted in ${sample.seconds} s (${jobs} writer processes).`);

	const all = [...fixed.written, ...sample.written];
	const index: CorpusIndex = {
		seed: input.seed,
		sample: input.sample,
		entropy: entropySeeded() ? "seeded" : "real",
		...(input.select !== undefined && { selection: input.select.label }),
		documents: all.map((entry) => entry.index),
		hq: input.hq ?? [],
		census: { fixed: fixed.census, sample: sample.census },
	};
	const timings: CorpusTimings = {
		...input.timings,
		fixedSeconds: fixed.seconds,
		sampleSeconds: sample.seconds,
		perSampledDocumentSeconds: Object.fromEntries(sample.perDocumentSeconds),
		jobs,
	};
	await writeCorpusInputs(
		input.out,
		all.map((entry) => ({ id: entry.index.id, inputs: entry.inputs })),
	);
	await writeJson(join(input.out, "timings.json"), timings);
	await writeJson(join(input.out, "index.json"), index);
	return { index, timings };
}
