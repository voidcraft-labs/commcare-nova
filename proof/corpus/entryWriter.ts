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
 * A first publish is written as two imports, the shell's `create` and the
 * `content` update that fills it, each sidecar marked with the layout
 * (`./publish.ts::TWO_IMPORT_LAYOUT`); the content, the republish and the
 * edit's update each name the placeholder app id and the fields of HQ's
 * source they were built over (`assumedSource`), with what the peer answered
 * for the lookup tables they push (`assumedResources`) and, for a document a
 * person saved in HQ over, the stops Nova's preflight made and what the
 * resend confirmed (`confirmed`). Beside the two imports of the first
 * publish, `create.ownership.json` and `content.ownership.json` hold the
 * overlay keys each body writes. Beside the exports the directory holds the
 * HQ import file (`import-file.zip`).
 *
 * The first publish reads the document as its source wrote it, records its
 * placements before it sends anything, and sends the document they leave
 * (`./publish.ts::capturePublish`); the emitter applied the same record to
 * D before planning D′ (`./emitCorpus.ts`), and a capture that records
 * anything else stops the emission. So `document.json` is D as stored after
 * its first publish, the republish of D sends that document, and
 * `edit/document.json` is it with the batch.
 *
 * A migration witness whose A is retained (`./inputs.ts::retainedMigrationA`)
 * is captured without a first publish: each configuration's retained files
 * are copied into its `export/<configuration>/` beside the republish Nova
 * sends over them (`./publish.ts::PublishInput.retainedA`), the retained
 * `configurations.json` is the witness's own, and a witness whose migrated
 * document's verdict would refuse one of those configurations stops the
 * emission.
 *
 * D's local archive is compiled once for each configuration the document
 * runs under, with what that project space holds (`./publish.ts::localCcz`):
 * `local.ccz` for a configuration without `USH_EMPTY_CASE_LIST_TEXT`, and
 * `local-empty-list-text.ccz` (`./inputs.ts::EMPTY_LIST_TEXT_ARCHIVE`), the
 * same export of D for a project space that holds the flag, where any
 * configuration holds it. `local-again.ccz`, the second export proof 1
 * compares with `local.ccz`, and `edit/local.ccz` are compiled as
 * `local.ccz` is.
 *
 * Every export is one seeded operation (`./entropy.mts`) of the corpus
 * seed: each update is captured once, in a stream of its own, the first
 * publish, the republish of D and the update to D′ each at its ordinal
 * (`./publish.ts::capturePublish`), and the local archives at theirs; the
 * archive compiled for the flag's project space is `local.ccz`'s export for
 * another project space, under `local.ccz`'s own operation.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TargetFacts } from "@/lib/commcare/targetFacts";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import type { Mutation } from "@/lib/doc/types";
import {
	type BlueprintDoc,
	blueprintDocSchema,
	type PersistableDoc,
} from "@/lib/domain";
import { materializableCaseTypes } from "@/lib/domain/effectiveCaseTypes";
import {
	type ConfigurationFlags,
	type CorpusConfiguration,
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
import {
	EMPTY_LIST_TEXT_ARCHIVE,
	EMPTY_LIST_TEXT_FLAG,
	type RetainedMigrationA,
	retainedConfigurations,
	retainedMigrationA,
	writeDocumentInputs,
} from "./inputs";
import {
	type CapturedRequest,
	type CompatibilityOutcome,
	capturedTargetFacts,
	capturePublish,
	importFile,
	localCcz,
	minimumConfiguration,
	type NovaPublishVerdict,
	novaPublishVerdict,
	PLACEHOLDER_APP_ID,
	PROOF_DOMAIN,
	type PublishCapture,
	type PublishConfiguration,
	type PublishDocument,
	type RepublishCapture,
	type SentImport,
	type StopConfirmation,
	TWO_IMPORT_LAYOUT,
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
	/** The document as stored after its first publish. */
	readonly document: CorpusDocument;
	/** D, hydrated: as stored after its first publish, its placements held. */
	readonly doc: BlueprintDoc;
	/** D's publish: what `document.json` holds, and every publish after the first sends. */
	readonly publish: PublishDocument;
	/**
	 * The document as stored before its first publish, which that publish
	 * reads and records its placements over (`./publish.ts::capturePublish`).
	 */
	readonly firstPublish: PublishDocument;
	/** What the first publish records, which the emitter applied to D. */
	readonly placements: readonly Mutation[];
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
 * `fuzz:<generator>:<seed>:<index>`, `targeted:<rows, separated by "; ">`,
 * or for a migration witness `targeted-migration:<rows, separated by "; ">`.
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
			return source.migrationWitness === true
				? `targeted-migration:${source.rows.join("; ")}`
				: `targeted:${source.rows.join("; ")}`;
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
 * its source, its effective materializable case catalog, and where its
 * modules, forms and languages sit on the wire (`wire.modules`,
 * `wire.languages`: `./footprint.ts`). Python consumes the catalog's derived
 * property types without interpreting the document's writers itself.
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
		catalog: materializableCaseTypes(doc).map(
			({ name, parent_type, relationship, properties }) => ({
				name,
				parent_type,
				relationship,
				properties: properties.map(({ name, data_type, options }) => ({
					name,
					data_type,
					options,
				})),
			}),
		),
	};
}

function verdictJson(verdict: NovaPublishVerdict) {
	return {
		capabilities: verdict.capabilities,
		advisories: verdict.advisories,
		minimumConfiguration: verdict.minimumConfiguration,
		planPrivileges: verdict.planPrivileges,
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
 * One import's files: the import as `<name>.body`, the lookup workbook Nova
 * pushes before it and the media upload it sends after it, each written
 * once per directory (`writeShared`) and named in the import's sidecar
 * (`lookups`, `media`), with the layout marker, the placeholder app id the
 * import names and the fields of HQ's source it was built over.
 */
async function writeStep(
	directory: string,
	name: string,
	step: SentImport & { readonly compatibility: CompatibilityOutcome },
	written: WrittenRequests,
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
		...updateSidecar(step),
	});
}

/**
 * What an update's sidecar names beside its request: the fields of HQ's
 * source and the resources it was built over, and where Nova's preflight
 * stopped it, the stop and what the resend confirmed.
 */
function updateSidecar(
	step: SentImport & { readonly confirmed?: StopConfirmation },
) {
	return {
		layout: TWO_IMPORT_LAYOUT,
		placeholderAppId: PLACEHOLDER_APP_ID,
		assumedSource: step.assumedSource,
		...(step.assumedResources !== undefined && {
			assumedResources: step.assumedResources,
		}),
		...(step.confirmed !== undefined && { confirmed: step.confirmed }),
	};
}

function outcomeJson(
	step:
		| {
				readonly status: string;
				readonly compatibility?: CompatibilityOutcome;
				readonly code?: string;
		  }
		| undefined,
) {
	if (step === undefined) return undefined;
	return {
		status: step.status,
		...(step.compatibility !== undefined && {
			compatibility: step.compatibility,
		}),
		...(step.code !== undefined && { code: step.code }),
	};
}

/**
 * What the project space a document's local archives are made for keeps,
 * after the publish named `update`: one value over every configuration,
 * since a document has one local archive and what the project space keeps
 * does not hang on its flags. Configurations that disagree stop the
 * emission rather than choose one.
 */
function archiveTargetFacts(
	documentId: string,
	captures: ReadonlyMap<string, PublishCapture | RepublishCapture>,
	update: string,
): TargetFacts | null {
	let chosen:
		| { readonly name: string; readonly facts: TargetFacts | null }
		| undefined;
	for (const [name, capture] of captures) {
		const facts = capturedTargetFacts(capture, update);
		if (chosen === undefined) {
			chosen = { name, facts };
		} else if (JSON.stringify(facts) !== JSON.stringify(chosen.facts)) {
			throw new Error(
				`${documentId}'s ${update} leaves its project space keeping ${JSON.stringify(facts)} under the ${name} configuration and ${JSON.stringify(chosen.facts)} under ${chosen.name}. A document has one local archive, made for one project space; look at what the capture peer holds under each configuration.`,
			);
		}
	}
	return chosen?.facts ?? null;
}

/**
 * A second local archive of a document whose first one was made: the same
 * declaration, so the download rule makes this one too.
 */
async function requiredLocalCcz(
	source: Parameters<typeof localCcz>[0],
	operation: EntropyOperation,
	options: Parameters<typeof localCcz>[3],
): Promise<Buffer> {
	const archive = await localCcz(source, PROOF_DOMAIN, operation, options);
	if (archive === null) {
		throw new Error(
			`The download rule refused a second local archive of ${source.id}, whose first it made: both read the same declaration.`,
		);
	}
	return archive;
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
 * What a project space lacks for Nova's publish of a document, by its
 * verdict, in the words `proof/checks/corpus.py::verdict_lacks` uses: each
 * required flag it does not hold, `case search` where a capability needs it
 * off there, `sync cases on form entry off` where the verdict requires the
 * setting off and the configuration has it on, `CommCare Supply off`
 * where the verdict requires CommCare Supply off and the configuration has
 * it on, and `<flag> off` for each flag its `flagsOff` names that the
 * configuration holds.
 */
function verdictLacks(
	verdict: NovaPublishVerdict,
	configuration: CorpusConfiguration,
): string[] {
	const minimum = verdict.minimumConfiguration;
	const lacking = minimum.flags
		.filter((flag) => !configuration.flags.includes(flag))
		.sort();
	if (minimum.caseSearchEnabled && !configuration.caseSearchEnabled) {
		lacking.push("case search");
	}
	if (
		minimum.syncCasesOnFormEntry === false &&
		configuration.syncCasesOnFormEntry
	) {
		lacking.push("sync cases on form entry off");
	}
	if (minimum.commtrackEnabled === false && configuration.commtrack) {
		lacking.push("CommCare Supply off");
	}
	lacking.push(
		...(minimum.flagsOff ?? [])
			.filter((flag) => configuration.flags.includes(flag))
			.sort()
			.map((flag) => `${flag} off`),
	);
	return lacking;
}

/**
 * Each configuration a migration witness's retained A was published under,
 * as Nova's publish reads it, after refusing one Nova's publish of the
 * migrated document (D or D′) would refuse: a witness republishes over the
 * project space its A was published to.
 */
function witnessConfigurations(
	document: CorpusDocument,
	retained: RetainedMigrationA,
	verdicts: readonly NovaPublishVerdict[],
): [string, ConfigurationFlags][] {
	return retainedConfigurations(retained).map(([name, configuration]) => {
		const lacking = [
			...new Set(
				verdicts.flatMap((verdict) => verdictLacks(verdict, configuration)),
			),
		];
		if (lacking.length > 0) {
			throw new Error(
				`${document.id} is a migration witness whose retained A was published under ${name}, and Nova's publish of the migrated document would refuse that project space (it lacks ${lacking.join(", ")}). A witness republishes over the project space its A was published to; give the migrated document content that project space accepts.`,
			);
		}
		return [
			name,
			{
				flags: configuration.flags,
				caseSearchEnabled: configuration.caseSearchEnabled,
			},
		];
	});
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

	const verdict = novaPublishVerdict(entry.doc, publish);
	const editVerdict =
		edit === undefined
			? undefined
			: novaPublishVerdict(edit.nextDoc, edit.publish);
	const least = minimumConfiguration(
		editVerdict === undefined ? [verdict] : [verdict, editVerdict],
	);
	/* The corpus's one sync-on refusal: a document whose project space syncs
	 * cases on form entry while Nova's publish asks that it be off (for D or
	 * D′) stands in a configuration Nova refuses. */
	if (
		document.projectSettings?.syncCasesOnFormEntry === true &&
		[verdict, editVerdict].some(
			(item) => item?.minimumConfiguration.syncCasesOnFormEntry === false,
		)
	) {
		throw new Error(
			`${document.id} turns sync on form entry on, and Nova's publish asks the person to confirm it is off for this document, so its configuration is one Nova refuses; a check runs only against a target Nova's publish accepts (decision 19).`,
		);
	}
	/* Likewise CommCare Supply: a document whose project space has it on
	 * while Nova's publish asks that it be off (for D or D′). */
	if (
		document.projectSettings?.commtrack === true &&
		[verdict, editVerdict].some(
			(item) => item?.minimumConfiguration.commtrackEnabled === false,
		)
	) {
		throw new Error(
			`${document.id} turns CommCare Supply on, and Nova's publish asks the person to confirm it is off for this document, so its configuration is one Nova refuses; a check runs only against a target Nova's publish accepts (decision 19).`,
		);
	}
	/* A migration witness with its A retained republishes over that A, under
	 * the configurations it was published to. */
	const witness =
		document.source.kind === "targeted" &&
		document.source.migrationWitness === true;
	const retained = witness ? await retainedMigrationA(document.id) : undefined;
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
	if (retained !== undefined) {
		await writeFile(
			join(root, "configurations.json"),
			retained.configurationsBytes,
		);
	} else {
		await writeJson(
			join(root, "configurations.json"),
			documentConfigurations({
				...flags,
				namedPrivileges: document.privileges ?? [],
				...(document.projectSettings?.syncCasesOnFormEntry !== undefined && {
					syncCasesOnFormEntry: document.projectSettings.syncCasesOnFormEntry,
				}),
				...(document.projectSettings?.commtrack !== undefined && {
					commtrack: document.projectSettings.commtrack,
				}),
			}),
		);
	}
	/* And each flag Nova's publish requires off (for D or D′): no
	 * configuration of the document may turn one on. */
	const flagsOff = new Set(
		[verdict, editVerdict].flatMap(
			(item) => item?.minimumConfiguration.flagsOff ?? [],
		),
	);
	if (retained === undefined) {
		for (const [name, configuration] of configurationFlags(flags)) {
			const on = configuration.flags.filter((flag) => flagsOff.has(flag));
			if (on.length > 0) {
				throw new Error(
					`${document.id} turns ${on.join(", ")} on in its ${name} configuration, and Nova's publish requires ${on.length === 1 ? "that flag" : "those flags"} off for this document, so its configuration is one Nova refuses; a check runs only against a target Nova's publish accepts (decision 19).`,
				);
			}
		}
	}
	const named =
		retained === undefined
			? configurationFlags(flags)
			: witnessConfigurations(
					document,
					retained,
					editVerdict === undefined ? [verdict] : [verdict, editVerdict],
				);
	const captures = new Map<string, PublishCapture | RepublishCapture>();
	for (const [name, configuration] of named) {
		const input = {
			create: entry.firstPublish,
			updates: [
				{ name: "republish", document: publish },
				...(edit !== undefined
					? [{ name: "update", document: edit.publish }]
					: []),
			],
			configuration: publishConfiguration(name, configuration),
			seed,
			...(document.hqSide !== undefined && { hqSide: document.hqSide }),
		};
		const retainedA = retained?.exports.get(name)?.publish;
		const capture =
			retainedA === undefined
				? await capturePublish(input)
				: await capturePublish({ ...input, retainedA });
		const steps = [
			...(capture.status === "republished" ? [] : [capture.create]),
			...(capture.status === "refused" ? [] : Object.values(capture.updates)),
		];
		const refused = steps.find(
			(step): step is Extract<typeof step, { status: "refused" }> =>
				step.status === "refused",
		);
		if (refused !== undefined) {
			throw new Error(
				`Nova's publish refused corpus document ${document.id} under its ${name} configuration (${JSON.stringify(refused.compatibility)}), which holds every flag its verdict requires. The verdict and Nova's project-space check disagree; look at projectSpaceCompatibilityProbePlan.`,
			);
		}
		const stopped = steps.find(
			(step): step is Extract<typeof step, { status: "stopped" }> =>
				step.status === "stopped",
		);
		/* `capturePublish` returns a stop only where `hq-side.json` states it,
		 * with the code it names, or where a confirmed publish stopped again. */
		if (stopped !== undefined && document.hqSide?.republish !== "stops") {
			throw new Error(
				`Nova's publish of corpus document ${document.id} under its ${name} configuration stopped with ${stopped.code} after a person confirmed every change and table it listed (${JSON.stringify(stopped)}). A confirmed publish proceeds; look at what the confirmation names against what the stop listed.`,
			);
		}
		/* D was stored with the record applied before its edit was planned
		 * (`./emitCorpus.ts`), so the first publish must record exactly that. */
		if (
			capture.status !== "refused" &&
			JSON.stringify(capture.placements) !== JSON.stringify(entry.placements)
		) {
			throw new Error(
				`Nova's first publish of ${document.id} under its ${name} configuration recorded the placements ${JSON.stringify(capture.placements)}, and the corpus stored D with ${JSON.stringify(entry.placements)} before planning its edit. Both are what the document's emission derives (firstPublishRecord), so the document the capture read is not the one the corpus recorded over; look at what each was given.`,
			);
		}
		captures.set(name, capture);
	}

	for (const [name] of named) {
		const capture = captures.get(name);
		if (capture?.status === "republished") {
			const exported = retained?.exports.get(name);
			if (exported === undefined) {
				throw new Error(
					`${document.id} was republished under ${name} over a retained A that holds no first publish there.`,
				);
			}
			const directory = join(root, "export", name);
			await mkdir(directory, { recursive: true });
			/* A's files as retained, beside the captured republish, which
			 * names a workbook or media upload A sent by A's file. */
			for (const [file, bytes] of exported.files) {
				await writeFile(join(directory, file), bytes);
			}
			const written: WrittenRequests = new Map();
			const { workbook, media } = exported.publish;
			if (exported.named.lookups !== undefined && workbook !== undefined) {
				written.set(
					"lookups",
					new Map([[exported.named.lookups, workbook.body]]),
				);
			}
			if (exported.named.media !== undefined && media !== undefined) {
				written.set("media", new Map([[exported.named.media, media.body]]));
			}
			const republish = capture.updates.republish;
			if (republish?.status === "sent") {
				await writeStep(directory, "republish", republish, written);
			}
			await writeJson(join(directory, "outcome.json"), {
				create: { status: "sent", compatibility: exported.compatibility },
				republish: outcomeJson(republish),
			});
			continue;
		}
		if (capture?.status !== "sent") continue;
		const directory = join(root, "export", name);
		await mkdir(directory, { recursive: true });
		const written: WrittenRequests = new Map();
		const { compatibility, create, content } = capture.create;
		/* The shell pushes nothing before it and sends no media after it. */
		await writeRequest(directory, "create", create.importApp, {
			compatibility,
			layout: TWO_IMPORT_LAYOUT,
		});
		await writeJson(join(directory, "create.ownership.json"), create.ownership);
		await writeStep(
			directory,
			"content",
			{ compatibility, ...content },
			written,
		);
		/* The overlay keys each body of the first publish writes, which the
		 * retained HQ reads copy beside HQ's answers to that publish
		 * (`proof/hq/test_retained_reads.py`), and which a migration witness's
		 * A is keyed on (`inputs.json`, `proof/observe/unit.py::input_files`). */
		await writeJson(
			join(directory, "content.ownership.json"),
			content.ownership,
		);
		const republish = capture.updates.republish;
		if (republish?.status === "sent") {
			await writeStep(directory, "republish", republish, written);
		}
		await writeJson(join(directory, "outcome.json"), {
			create: outcomeJson(capture.create),
			republish: outcomeJson(republish),
		});
	}

	/* A `.ccz` installs an app on Android and nothing else, so Nova's own
	 * download refuses one for a document that does not declare it
	 * (`not-declared-for-android`), and the corpus writes no local archive
	 * of it: a Web Apps worker meets HQ's build. */
	/* Each archive is made for the project space as the publish before it
	 * left it: D's for the republish, D′'s for its update, each with what the
	 * project space keeps (`SentImport.targetFacts`). */
	const targetFacts = archiveTargetFacts(document.id, captures, "republish");
	const localArchive = await localCcz(
		publish,
		PROOF_DOMAIN,
		local(OPERATION_ORDINALS.local),
		{ targetFacts },
	);
	if (localArchive !== null) {
		await writeFile(join(root, "local.ccz"), localArchive);
		await writeFile(
			join(root, "local-again.ccz"),
			await requiredLocalCcz(publish, local(OPERATION_ORDINALS.localAgain), {
				targetFacts,
			}),
		);
		if (
			named.some(([, configuration]) =>
				configuration.flags.includes(EMPTY_LIST_TEXT_FLAG),
			)
		) {
			await writeFile(
				join(root, EMPTY_LIST_TEXT_ARCHIVE),
				await requiredLocalCcz(publish, local(OPERATION_ORDINALS.local), {
					emptyCaseListText: true,
					targetFacts,
				}),
			);
		}
	}
	await writeFile(
		join(root, "import-file.zip"),
		await importFile(publish, PROOF_DOMAIN),
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
				capture === undefined || capture.status === "refused"
					? undefined
					: capture.updates.update;
			if (capture === undefined || update?.status !== "sent") continue;
			const directory = join(editRoot, "export", name);
			await mkdir(directory, { recursive: true });
			await writeStep(directory, "update", update, new Map());
			await writeJson(join(directory, "outcome.json"), {
				create:
					capture.status === "republished"
						? {
								status: "sent",
								compatibility: retained?.exports.get(name)?.compatibility,
							}
						: outcomeJson(capture.create),
				update: outcomeJson(update),
			});
		}
		/* D′ may change the declaration, so its archive follows its own. */
		const editArchive = await localCcz(
			edit.publish,
			PROOF_DOMAIN,
			local(OPERATION_ORDINALS.editLocal),
			{ targetFacts: archiveTargetFacts(document.id, captures, "update") },
		);
		if (editArchive !== null) {
			await writeFile(join(editRoot, "local.ccz"), editArchive);
		}
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
		inputs: await writeDocumentInputs(root, document.id, configurations, {
			migrationWitness: witness,
		}),
		milliseconds: performance.now() - started,
	};
}

// ── Jobs for worker processes ────────────────────────────────────────

/** A prepared document as a worker receives it, in JSON. */
export function entryJob(entry: PreparedEntry): unknown {
	const { document, publish, edit } = entry;
	return {
		id: document.id,
		placements: entry.placements,
		...(entry.placements.length > 0 && {
			firstPublishDoc: entry.firstPublish.doc,
		}),
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
			placements: Mutation[];
			firstPublishDoc?: PersistableDoc;
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
		const recorded = {
			firstPublish:
				raw.firstPublishDoc === undefined
					? publish
					: { ...publish, doc: raw.firstPublishDoc },
			placements: raw.placements,
		};
		if (edited === undefined) return { document, doc, publish, ...recorded };
		if (raw.batch === undefined || raw.footprint === undefined) {
			throw new Error(
				`The corpus worker received ${publish.id}'s edited document without its batch and footprint.`,
			);
		}
		return {
			document,
			doc,
			publish,
			...recorded,
			edit: {
				batch: raw.batch,
				nextDoc: hydrate(edited.doc, `${publish.id}'s edited document`),
				publish: { ...edited, id: publish.id },
				footprint: raw.footprint,
			},
		};
	});
}
