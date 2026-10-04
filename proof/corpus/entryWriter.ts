/**
 * Writes one corpus document's directory: its stored form, verdict,
 * configurations, publish captures, local exports, edit and input manifest
 * (`./emitCorpus.ts` lays out the whole). The corpus emitter runs it in its
 * own process, or hands documents to worker processes (`./emitWorker.ts`)
 * as jobs: `entryJob` writes a prepared document as JSON, and
 * `preparedFromJob` reads it back through the same readers Nova's stored
 * state goes through (`./writePublishCaptures.ts::readDocuments`), so a
 * worker writes exactly what the emitter's own process would.
 *
 * Every export is one seeded operation (`./entropy.mts`) of the corpus
 * seed: each configuration's create, republish and update (at the
 * republish's ordinal when it sends exactly the republish, and at its own
 * otherwise: `./publish.ts::capturePublish`), and the three local archives
 * at their own ordinals.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import type { Mutation } from "@/lib/doc/types";
import {
	type BlueprintDoc,
	blueprintDocSchema,
	type PersistableDoc,
} from "@/lib/domain";
import {
	type ConfigurationFlags,
	configurationFlags,
	documentConfigurations,
} from "./configurations";
import {
	type CorpusDocument,
	type CorpusSource,
	checkDocumentFileName,
	type HqSideSaves,
	type ProjectSettings,
} from "./documents";
import type { KeptEditBatch } from "./editBatches";
import {
	type EntropyOperation,
	LOCAL_CONFIGURATION,
	OPERATION_ORDINALS,
} from "./entropy.mts";
import { type Footprint, wireLanguages, wireLayout } from "./footprint";
import { writeDocumentInputs } from "./inputs";
import {
	type CapturedRequest,
	capturePublish,
	localCcz,
	minimumConfiguration,
	type NovaPublishVerdict,
	novaPublishVerdict,
	PLACEHOLDER_APP_ID,
	PROOF_DOMAIN,
	type PublishCapture,
	type PublishConfiguration,
	type PublishDocument,
	type StepOutcome,
} from "./publish";
import { readDocuments } from "./writePublishCaptures";

export interface IndexEntry {
	readonly id: string;
	/** Where the document comes from (`sourceName`); `document.json` holds it in full. */
	readonly source: string;
	/** The sharding group: one per corpus document. */
	readonly group: string;
	/** Whether the document carries an edit batch (`edit/`). */
	readonly edit: boolean;
	/** The configuration directories under `export/`. */
	readonly configurations: readonly string[];
}

/** An edit batch as the writer needs it: the batch, D′ hydrated, D′'s publish and the footprint. */
export interface PreparedEdit {
	readonly batch: Pick<
		KeptEditBatch,
		"seed" | "intendedKind" | "mutations" | "kinds" | "touched" | "hasReaders"
	>;
	readonly nextDoc: BlueprintDoc;
	readonly publish: PublishDocument;
	readonly footprint: Footprint;
}

/** A document ready to write: admitted, with its edit when it keeps one. */
export interface PreparedEntry {
	readonly document: CorpusDocument;
	/** D, hydrated. */
	readonly doc: BlueprintDoc;
	readonly publish: PublishDocument;
	readonly edit?: PreparedEdit;
}

/** What writing one document leaves for the emitter: its index entry and its input manifest's digest. */
export interface WrittenEntry {
	readonly index: IndexEntry;
	readonly source: CorpusSource;
	/** The digest of the document's `inputs.json` (`./inputs.ts`). */
	readonly inputs: string;
	/** How long writing it took, in milliseconds. */
	readonly milliseconds: number;
}

/**
 * A document's source as the index names it: `producer:<family>/<scenario>`,
 * `workforce:<base>`, `expander:<first test>`,
 * `fuzz:<generator>:<seed>:<index>` or `targeted:<rows, separated by "; ">`.
 */
export function sourceName(source: CorpusSource): string {
	switch (source.kind) {
		case "producer":
			return `producer:${source.family}/${source.scenario}`;
		case "workforce":
			return `workforce:${source.base}`;
		case "expander":
			return `expander:${source.tests[0] ?? ""}`;
		case "fuzz":
			return `fuzz:${source.generator}:${source.seed}:${source.index}`;
		case "targeted":
			// A row names itself with commas ("5, reserved substrings").
			return `targeted:${source.rows.join("; ")}`;
	}
}

// ── Files ────────────────────────────────────────────────────────────

function jsonText(value: unknown): string {
	return `${JSON.stringify(value, null, "\t")}\n`;
}

export async function writeJson(path: string, value: unknown): Promise<void> {
	await writeFile(path, jsonText(value));
}

/** A publish's inputs in the stored-state form `readDocuments` reads: lookup rows by table, media as base64. */
function storedInputs(publish: PublishDocument) {
	return {
		doc: publish.doc,
		compiledAtSeq: publish.compiledAtSeq,
		...(publish.lookup !== undefined && {
			lookup: {
				projectId: publish.lookup.projectId,
				projectRevision: publish.lookup.projectRevision,
				definitions: publish.lookup.definitions,
				rowsByTable: Object.fromEntries(publish.lookup.rowsByTable),
			},
		}),
		...(publish.media !== undefined && {
			media: Object.fromEntries(
				[...publish.media].map(([assetId, asset]) => [
					assetId,
					{
						kind: asset.kind,
						mimeType: asset.mimeType,
						extension: asset.extension,
						base64: asset.bytes.toString("base64"),
					},
				]),
			),
		}),
	};
}

/**
 * A document as `document.json` holds it: the inputs `./publish.ts` takes,
 * its source, and where its modules, forms and languages sit on the wire
 * (`wire.modules`, `wire.languages`: `./footprint.ts`).
 */
function documentJson(
	id: string,
	source: CorpusSource,
	publish: PublishDocument,
	doc: BlueprintDoc,
) {
	return {
		id,
		source,
		...storedInputs(publish),
		wire: { modules: wireLayout(doc), languages: wireLanguages(doc) },
	};
}

function verdictJson(verdict: NovaPublishVerdict) {
	return {
		capabilities: verdict.capabilities,
		advisories: verdict.advisories,
		minimumConfiguration: verdict.minimumConfiguration,
	};
}

/**
 * One captured request: its body as `<name>.body`, and a sidecar
 * `<name>.json` naming its method, path, content type and fields. The
 * sidecar names nothing about its own file, so two requests that send the
 * same thing have byte-identical sidecars whatever they are called.
 */
async function writeRequest(
	directory: string,
	name: string,
	request: CapturedRequest,
	extra: Record<string, unknown> = {},
): Promise<void> {
	await writeFile(join(directory, `${name}.body`), request.body);
	await writeJson(join(directory, `${name}.json`), {
		method: request.method,
		path: request.path,
		contentType: request.contentType,
		fields: request.fields,
		...extra,
	});
}

/**
 * The requests a directory already holds besides the imports, by kind
 * (`lookups`, `media`): each body by the file name it was written under.
 */
type WrittenRequests = Map<string, Map<string, Buffer>>;

/**
 * One request a publish sends beside its import, written once per
 * directory: as `<kind>.body` the first time the directory receives one of
 * its kind; a later request of the same bytes names that file, and a
 * different one gets `<name>-<kind>.body`. Returns the body's file name.
 */
async function writeShared(
	directory: string,
	name: string,
	kind: string,
	request: CapturedRequest,
	written: WrittenRequests,
): Promise<string> {
	const held = written.get(kind) ?? new Map<string, Buffer>();
	written.set(kind, held);
	const same = [...held].find(([, body]) => body.equals(request.body));
	if (same !== undefined) return same[0];
	const base = held.size === 0 ? kind : `${name}-${kind}`;
	await writeRequest(directory, base, request);
	held.set(`${base}.body`, request.body);
	return `${base}.body`;
}

/**
 * One publish's files: its import as `<name>.body`, the lookup workbook
 * Nova pushes before it and the media upload it sends after it, each
 * written once per directory (`writeShared`) and named in the import's
 * sidecar (`lookups`, `media`).
 */
async function writeStep(
	directory: string,
	name: string,
	step: Extract<StepOutcome, { status: "sent" }>,
	written: WrittenRequests,
	extra: Record<string, unknown> = {},
): Promise<void> {
	const lookupFile =
		step.lookup === undefined
			? undefined
			: await writeShared(directory, name, "lookups", step.lookup, written);
	const mediaFile =
		step.media === undefined
			? undefined
			: await writeShared(directory, name, "media", step.media, written);
	await writeRequest(directory, name, step.importApp, {
		compatibility: step.compatibility,
		...(lookupFile !== undefined && { lookups: lookupFile }),
		...(mediaFile !== undefined && { media: mediaFile }),
		...extra,
	});
}

function outcomeJson(step: StepOutcome | undefined) {
	if (step === undefined) return undefined;
	return {
		status: step.status,
		compatibility: step.compatibility,
	};
}

function publishConfiguration(
	id: string,
	configuration: ConfigurationFlags,
): PublishConfiguration {
	return {
		id,
		flags: configuration.flags,
		caseSearchEnabled: configuration.caseSearchEnabled,
		domain: PROOF_DOMAIN,
	};
}

/**
 * Every Nova entity in a footprint, as one sorted list: the entities it
 * reaches, the modules (a synthetic one by its derived uuid) and the forms.
 */
function footprintEntities(footprint: Footprint): string[] {
	return [
		...new Set([
			...footprint.entities,
			...footprint.modules,
			...footprint.forms,
		]),
	].sort();
}

/**
 * Write one prepared document's directory under `out`, replacing whatever
 * was there, with every export seeded from the corpus seed `seed`.
 */
export async function writeEntry(
	out: string,
	entry: PreparedEntry,
	seed: number,
): Promise<WrittenEntry> {
	const started = performance.now();
	const local = (ordinal: number): EntropyOperation => ({
		seed,
		ordinal,
		configuration: LOCAL_CONFIGURATION,
	});
	const { document, publish, edit } = entry;
	const singleFlags = document.singleFlags ?? [];
	const root = join(out, document.id);
	await rm(root, { recursive: true, force: true });
	await mkdir(root, { recursive: true });

	const verdict = novaPublishVerdict(entry.doc);
	const editVerdict =
		edit === undefined ? undefined : novaPublishVerdict(edit.nextDoc);
	const least = minimumConfiguration(
		editVerdict === undefined ? [verdict] : [verdict, editVerdict],
	);
	await writeJson(
		join(root, "document.json"),
		documentJson(document.id, document.source, publish, entry.doc),
	);
	await writeJson(join(root, "verdict.json"), verdictJson(verdict));
	if (document.expected !== undefined) {
		await writeJson(join(root, "expected.json"), document.expected);
	}
	if (document.hqSide !== undefined) {
		await writeJson(join(root, "hq-side.json"), document.hqSide);
	}
	for (const [name, content] of Object.entries(document.files ?? {})) {
		checkDocumentFileName(document.id, name);
		await writeFile(join(root, name), content);
	}

	const flags = {
		flags: least.flags,
		caseSearchEnabled: least.caseSearchEnabled,
		singleFlags,
	};
	await writeJson(
		join(root, "configurations.json"),
		documentConfigurations({
			...flags,
			namedPrivileges: document.privileges ?? [],
			...(document.projectSettings?.syncCasesOnFormEntry !== undefined && {
				syncCasesOnFormEntry: document.projectSettings.syncCasesOnFormEntry,
			}),
		}),
	);
	const named = configurationFlags(flags);
	const captures = new Map<string, PublishCapture>();
	for (const [name, configuration] of named) {
		const capture = await capturePublish({
			create: publish,
			updates: [
				{ name: "republish", document: publish },
				...(edit !== undefined
					? [{ name: "update", document: edit.publish }]
					: []),
			],
			configuration: publishConfiguration(name, configuration),
			seed,
		});
		const refused = [
			capture.create,
			...(capture.status === "sent" ? Object.values(capture.updates) : []),
		].find((step) => step.status === "refused");
		if (refused !== undefined) {
			throw new Error(
				`Nova's publish refused corpus document ${document.id} under its ${name} configuration (${JSON.stringify(refused.compatibility)}), which holds every flag its verdict requires. The verdict and Nova's project-space check disagree; look at projectSpaceCompatibilityProbePlan.`,
			);
		}
		captures.set(name, capture);
	}

	for (const [name] of named) {
		const capture = captures.get(name);
		if (capture?.status !== "sent") continue;
		const directory = join(root, "export", name);
		await mkdir(directory, { recursive: true });
		const written: WrittenRequests = new Map();
		await writeStep(directory, "create", capture.create, written);
		const republish = capture.updates.republish;
		if (republish?.status === "sent") {
			await writeStep(directory, "republish", republish, written, {
				placeholderAppId: PLACEHOLDER_APP_ID,
				assumedSourceProfile: capture.assumedSourceProfile,
			});
		}
		await writeJson(join(directory, "outcome.json"), {
			create: outcomeJson(capture.create),
			republish: outcomeJson(republish),
		});
	}

	await writeFile(
		join(root, "local.ccz"),
		await localCcz(publish, PROOF_DOMAIN, local(OPERATION_ORDINALS.local)),
	);
	await writeFile(
		join(root, "local-again.ccz"),
		await localCcz(publish, PROOF_DOMAIN, local(OPERATION_ORDINALS.localAgain)),
	);

	if (edit !== undefined && editVerdict !== undefined) {
		const editRoot = join(root, "edit");
		await mkdir(editRoot, { recursive: true });
		await writeJson(join(editRoot, "batch.json"), {
			seed: edit.batch.seed,
			intendedKind: edit.batch.intendedKind,
			mutations: edit.batch.mutations,
			kinds: edit.batch.kinds,
			touched: edit.batch.touched,
			hasReaders: edit.batch.hasReaders,
			footprint: footprintEntities(edit.footprint),
			footprintParts: edit.footprint,
		});
		await writeJson(
			join(editRoot, "document.json"),
			documentJson(document.id, document.source, edit.publish, edit.nextDoc),
		);
		await writeJson(join(editRoot, "verdict.json"), verdictJson(editVerdict));
		for (const [name] of named) {
			const capture = captures.get(name);
			const update =
				capture?.status === "sent" ? capture.updates.update : undefined;
			if (capture?.status !== "sent" || update?.status !== "sent") continue;
			const directory = join(editRoot, "export", name);
			await mkdir(directory, { recursive: true });
			await writeStep(directory, "update", update, new Map(), {
				placeholderAppId: PLACEHOLDER_APP_ID,
				assumedSourceProfile: capture.assumedSourceProfile,
			});
			await writeJson(join(directory, "outcome.json"), {
				create: outcomeJson(capture.create),
				update: outcomeJson(update),
			});
		}
		await writeFile(
			join(editRoot, "local.ccz"),
			await localCcz(
				edit.publish,
				PROOF_DOMAIN,
				local(OPERATION_ORDINALS.editLocal),
			),
		);
	}

	const configurations = named.map(([name]) => name);
	return {
		index: {
			id: document.id,
			source: sourceName(document.source),
			group: document.id,
			edit: edit !== undefined,
			configurations,
		},
		source: document.source,
		inputs: await writeDocumentInputs(root, document.id, configurations),
		milliseconds: performance.now() - started,
	};
}

// ── Jobs for worker processes ────────────────────────────────────────

/** A prepared document as a worker receives it, in JSON. */
export function entryJob(entry: PreparedEntry): unknown {
	const { document, publish, edit } = entry;
	return {
		id: document.id,
		source: document.source,
		...(document.expected !== undefined && { expected: document.expected }),
		...(document.files !== undefined && { files: document.files }),
		...(document.singleFlags !== undefined && {
			singleFlags: document.singleFlags,
		}),
		...(document.privileges !== undefined && {
			privileges: document.privileges,
		}),
		...(document.projectSettings !== undefined && {
			projectSettings: document.projectSettings,
		}),
		...(document.hqSide !== undefined && { hqSide: document.hqSide }),
		...storedInputs(publish),
		...(edit !== undefined && {
			edited: storedInputs(edit.publish),
			batch: {
				seed: edit.batch.seed,
				intendedKind: edit.batch.intendedKind,
				mutations: edit.batch.mutations,
				kinds: edit.batch.kinds,
				touched: edit.batch.touched,
				hasReaders: edit.batch.hasReaders,
			},
			footprint: edit.footprint,
		}),
	};
}

function hydrate(doc: PersistableDoc, what: string): BlueprintDoc {
	const parsed = blueprintDocSchema.safeParse(doc);
	if (!parsed.success) {
		throw new Error(
			`The corpus worker received ${what}, which does not parse under Nova's strict blueprint schema: ${parsed.error.message}`,
		);
	}
	return hydratePersistedBlueprint(parsed.data);
}

/** The prepared documents a worker's job holds, read back as the emitter prepared them. */
export function preparedFromJob(job: readonly unknown[]): PreparedEntry[] {
	const stored = readDocuments(job);
	return stored.map(({ document: publish, edited }, index) => {
		const raw = job[index] as {
			source: CorpusSource;
			expected?: unknown;
			files?: Readonly<Record<string, string>>;
			singleFlags?: readonly string[];
			privileges?: readonly string[];
			projectSettings?: ProjectSettings;
			hqSide?: HqSideSaves;
			batch?: PreparedEdit["batch"] & { mutations: Mutation[] };
			footprint?: Footprint;
		};
		const document: CorpusDocument = {
			id: publish.id,
			source: raw.source,
			doc: publish.doc,
			...(publish.lookup !== undefined && { lookup: publish.lookup }),
			...(publish.media !== undefined && { media: publish.media }),
			...(raw.expected !== undefined && { expected: raw.expected }),
			...(raw.files !== undefined && { files: raw.files }),
			...(raw.singleFlags !== undefined && { singleFlags: raw.singleFlags }),
			...(raw.privileges !== undefined && { privileges: raw.privileges }),
			...(raw.projectSettings !== undefined && {
				projectSettings: raw.projectSettings,
			}),
			...(raw.hqSide !== undefined && { hqSide: raw.hqSide }),
		};
		const doc = hydrate(publish.doc, `the document ${publish.id}`);
		if (edited === undefined) return { document, doc, publish };
		if (raw.batch === undefined || raw.footprint === undefined) {
			throw new Error(
				`The corpus worker received ${publish.id}'s edited document without its batch and footprint.`,
			);
		}
		return {
			document,
			doc,
			publish,
			edit: {
				batch: raw.batch,
				nextDoc: hydrate(edited.doc, `${publish.id}'s edited document`),
				publish: { ...edited, id: publish.id },
				footprint: raw.footprint,
			},
		};
	});
}
