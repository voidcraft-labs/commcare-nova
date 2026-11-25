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
 * resend confirmed (`confirmed`). Every import's sidecar names the capture
 * peer's save counter around it (`saveCounter`, and `mediaSaveCounter`
 * around the media upload after it), which the HQ side holds HQ's own
 * counter's move to (`proof/observe/publish.py`). Beside the two imports of the first
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
 * `edit/document.json` is it with the batch. Where a person's saves in HQ
 * over A are brought in before the republish (`hq-side.json` states
 * `brings-in`), the republish sends the document the bring-in gave, under
 * the target-identity record the bring-in left (the menu and form ids it read
 * of the app and each keyed create's prefix), and A after the saves and B both
 * hold it: `document.json`, the local archives and the import file are of
 * that document (`republishedDocument`), and D is what the first publish's
 * captured requests send.
 *
 * A migration witness whose A is retained (`./inputs.ts::retainedMigrationA`)
 * is captured without a first publish: each configuration's retained files
 * are copied into its `export/<configuration>/` beside the republish Nova
 * sends over them (`./publish.ts::PublishInput.retainedA`), the retained
 * `configurations.json` is the witness's own, and a witness whose migrated
 * document's verdict would refuse one of those configurations stops the
 * emission.
 *
 * The republished document's local archive is compiled once for each
 * configuration the document runs under, with what that project space holds
 * (`./publish.ts::localCcz`): `local.ccz` for a configuration without
 * `USH_EMPTY_CASE_LIST_TEXT`, and `local-empty-list-text.ccz`
 * (`./inputs.ts::EMPTY_LIST_TEXT_ARCHIVE`), the same export for a project
 * space that holds the flag, where any
 * configuration holds it. `local-again.ccz`, the second export proof 1
 * compares with `local.ccz`, and `edit/local.ccz` are compiled as
 * `local.ccz` is. Where the project space's app keeps a custom base URL
 * that sends phones elsewhere than the server, Nova's download makes no
 * `.ccz` (`workers-sent-elsewhere`), and the document carries none: it
 * states the refusal in their place (`./inputs.ts::LOCAL_REFUSED`), and a
 * base's value expectations at the local archive are left out.
 *
 * A document made in CommCare HQ (`hq-authored`) has no first publish: its
 * A is its base's app, which the entry writer copies from the base's
 * retained directory into `authored/` (`app.json`, `media.json` and
 * `media/`, `seed.json`, and `tables.json`, `places.json` and
 * `practice-workers.json` where the base holds them), so the document's key names every byte A is made of. Its one
 * configuration is the base's (`base.json`'s `configuration`, as both
 * `minimum` and `maximum`, with no single flag), and only `export/minimum/`
 * is written: the republish Nova sends over A as over an app it brought in
 * (`./publish.ts::PublishInput.hqAuthoredA`) and D′'s update. Beside them it
 * writes the first-publish changes the reading predicts, each with the
 * places it stands at (`first-publish.json`), the base's hand-written value expectations as
 * `expected.json`, one expectation for each state it runs at (HQ's A, Nova's
 * B and, where the declaration D was read under includes Android, the local
 * archive), each form named by HQ's positions resolved to D's form through
 * the reading's identity rows, and the restore each runs over. Such a
 * document carries no `hq-side.json`: its A is HQ's own app, and nothing is
 * saved over it before Nova's first publish.
 *
 * Every export is one seeded operation (`./entropy.mts`) of the corpus
 * seed: each update is captured once, in a stream of its own, the first
 * publish, the republish of D and the update to D′ each at its ordinal
 * (`./publish.ts::capturePublish`), and the local archives at theirs; the
 * archive compiled for the flag's project space is `local.ccz`'s export for
 * another project space, under `local.ccz`'s own operation.
 */

import { existsSync } from "node:fs";
import {
	copyFile,
	mkdir,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { planLanguageWire } from "@/lib/commcare/languageWire";
import { COMMCARE_SERVERS } from "@/lib/commcare/servers";
import type { TargetFacts } from "@/lib/commcare/targetFacts";
import { keptAdvisoryFacts } from "@/lib/deployment/targetFacts";
import {
	canonicalTargetIdentity,
	EMPTY_TARGET_IDENTITY,
	type TargetIdentity,
} from "@/lib/deployment/targetIdentity";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import type { Mutation } from "@/lib/doc/types";
import {
	type BlueprintDoc,
	blueprintDocSchema,
	effectiveAppLocalization,
	type PersistableDoc,
} from "@/lib/domain";
import { materializableCaseTypes } from "@/lib/domain/effectiveCaseTypes";
import { exportAdvisories } from "@/lib/publish/exportAdvisories";
import {
	type ConfigurationFlags,
	type CorpusConfiguration,
	configurationFlags,
	type DocumentConfigurations,
	documentConfigurations,
} from "./configurations";
import {
	type CorpusDocument,
	type CorpusSource,
	checkDocumentFileName,
	type HqAuthoredFacts,
	type HqSideSaves,
	type ProjectSettings,
} from "./documents";
import type { KeptEditBatch } from "./editBatches";
import {
	type EntropyOperation,
	LOCAL_CONFIGURATION,
	OPERATION_ORDINALS,
} from "./entropy.mts";
import { fixtureRowsFiles } from "./fixtureRowsFilename";
import { type Footprint, wireLanguages, wireLayout } from "./footprint";
import {
	EMPTY_LIST_TEXT_ARCHIVE,
	EMPTY_LIST_TEXT_FLAG,
	LOCAL_REFUSED,
	type RetainedMigrationA,
	retainedConfigurations,
	retainedMigrationA,
	writeDocumentInputs,
} from "./inputs";
import { mediaRole, writeMediaSidecar } from "./mediaSidecar";
import {
	type BringInRecord,
	type CapturedRequest,
	type CompatibilityOutcome,
	capturedTargetFacts,
	capturePublish,
	importFile,
	type LocalCczRefused,
	localCcz,
	minimumConfiguration,
	type NovaPublishVerdict,
	novaPublishVerdict,
	PLACEHOLDER_APP_ID,
	PROOF_DOMAIN,
	PROOF_SERVER,
	type PublishCapture,
	type PublishConfiguration,
	type PublishDocument,
	type PublishedOverRecord,
	type RepublishCapture,
	type SentImport,
	type StopConfirmation,
	TWO_IMPORT_LAYOUT,
} from "./publish";
import type { PeerTable } from "./targetPeer";
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
 * for a migration witness `targeted-migration:<rows, separated by "; ">`,
 * or for an app made in CommCare HQ `hq-authored:<base>`.
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
		case "hq-authored":
			return `hq-authored:${source.base}`;
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
 * What `document.json` holds of a document made in CommCare HQ, under
 * `hqAuthored`, as a read back of it reads it
 * (`proof/reader/laneReading.ts::storedDocument`) and the judges read it:
 * the reading's identity rows, the declaration D was read under, the ids of
 * the first-publish changes it predicts, and the path HQ keeps each asset
 * under, by asset id.
 */
function hqAuthoredJson(facts: HqAuthoredFacts) {
	return {
		identity: facts.identity,
		declaration: facts.declaration,
		...(facts.ownerRuleChoices !== undefined && {
			ownerRuleChoices: facts.ownerRuleChoices,
		}),
		firstPublish: facts.firstPublish,
		mediaPaths: Object.fromEntries(facts.mediaPaths),
	};
}

/**
 * A document as `document.json` holds it: the inputs `./publish.ts` takes,
 * its source, its effective materializable case catalog, where its
 * modules, forms and languages sit on the wire (`wire.modules`,
 * `wire.languages`: `./footprint.ts`), and for a document made in CommCare
 * HQ what its reading gave (`hqAuthored`). Python consumes the catalog's
 * derived property types without interpreting the document's writers itself.
 */
function documentJson(
	id: string,
	source: CorpusSource,
	publish: PublishDocument,
	doc: BlueprintDoc,
	facts?: HqAuthoredFacts,
	targetFacts?: TargetFacts | null,
) {
	// The device judge holds the two picker spellings to the real download advisory
	// and Nova's picker labels before either the archive or Android interprets them.
	let advisedPickerLabels: Record<string, string> | undefined;
	let catalogFallbackAdvisory: string | undefined;
	if (facts !== undefined && targetFacts != null) {
		const plan = planLanguageWire(effectiveAppLocalization(doc.localization));
		const kept = keptAdvisoryFacts(targetFacts, plan.languages);
		const advisories = exportAdvisories(doc, "known", kept);
		catalogFallbackAdvisory = advisories.find(
			(item) => item.id === "kept_ui_text_falls_back",
		)?.id;
		if (advisories.some((item) => item.id === "kept_language_names_differ")) {
			advisedPickerLabels = Object.fromEntries(plan.nameByWireCode);
		}
	}
	return {
		id,
		source,
		...storedInputs(publish),
		wire: {
			modules: wireLayout(doc),
			languages: wireLanguages(doc),
			...(advisedPickerLabels && { advisedPickerLabels }),
			...(catalogFallbackAdvisory && { catalogFallbackAdvisory }),
		},
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
		...(facts !== undefined && { hqAuthored: hqAuthoredJson(facts) }),
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
	const media = await writeMediaSidecar(step.mediaUploads, (request, role) =>
		writeShared(directory, name, role, request, written),
	);
	await writeRequest(directory, name, step.importApp, {
		compatibility: step.compatibility,
		...(lookupFile !== undefined && { lookups: lookupFile }),
		...media,
		...updateSidecar(step),
	});
}

/**
 * What an update's sidecar names beside its request: the capture peer's
 * save counter around it and around its media upload, the fields of HQ's
 * source and the resources it was built over, where Nova's preflight
 * stopped it, the stop and what the resend confirmed, and where it was sent
 * after a review of changes made in CommCare HQ, the review and what the
 * bring-in or the record took (`broughtIn`, `./publish.ts::BringInRecord`),
 * with, where the capture also published over the same saves, that branch's
 * stop and what CommCare HQ's map named after it (`publishedOver`,
 * `./publish.ts::PublishedOverRecord`).
 */
function updateSidecar(
	step: SentImport & {
		readonly confirmed?: StopConfirmation;
		readonly broughtIn?: BringInRecord;
		readonly publishedOver?: PublishedOverRecord;
	},
) {
	return {
		layout: TWO_IMPORT_LAYOUT,
		placeholderAppId: PLACEHOLDER_APP_ID,
		saveCounter: step.saveCounter,
		...(Object.keys(step.verifiedMedia).length > 0 && {
			verifiedMedia: step.verifiedMedia,
		}),
		assumedSource: step.assumedSource,
		...(step.assumedResources !== undefined && {
			assumedResources: step.assumedResources,
		}),
		...(step.confirmed !== undefined && { confirmed: step.confirmed }),
		...(step.broughtIn !== undefined && { broughtIn: step.broughtIn }),
		...(step.publishedOver !== undefined && {
			publishedOver: step.publishedOver,
		}),
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
 * The document the republish sent over A and the target-identity record it
 * sent it under, which A after a person's saves and B both hold: where every
 * configuration's republish was sent after a bring-in of those saves
 * (`SentImport`'s `sent` and `sentUnder`), the document the bring-in gave,
 * with the placements its emission records, under the record the bring-in
 * left; otherwise D under the empty record, every id derived.
 * Configurations that disagree stop the emission rather than choose one.
 */
function republishedDocument(
	documentId: string,
	captures: ReadonlyMap<string, PublishCapture | RepublishCapture>,
	publish: PublishDocument,
): {
	readonly publish: PublishDocument;
	readonly targetIdentity: TargetIdentity;
} {
	const sent = [...captures].map(([name, capture]) => {
		const step =
			capture.status === "refused" ? undefined : capture.updates.republish;
		return {
			name,
			taken:
				step?.status === "sent" &&
				step.broughtIn?.taken === "brought-in" &&
				step.sent !== undefined &&
				step.sentUnder !== undefined
					? { document: step.sent, record: step.sentUnder }
					: undefined,
		};
	});
	const brought = sent.filter((each) => each.taken !== undefined);
	if (brought.length === 0)
		return { publish, targetIdentity: EMPTY_TARGET_IDENTITY };
	const [first] = brought;
	const key = (taken: (typeof sent)[number]["taken"]) =>
		JSON.stringify({
			doc: taken?.document.doc,
			compiledAtSeq: taken?.document.compiledAtSeq,
			record:
				taken === undefined ? undefined : canonicalTargetIdentity(taken.record),
		});
	const other = sent.find((each) => key(each.taken) !== key(first?.taken));
	if (first?.taken === undefined || other !== undefined) {
		throw new Error(
			`${documentId}'s republish sent the document a bring-in gave under ${first?.name} and ${other?.taken === undefined ? "D" : "another document or other ids"} under ${other?.name}. A document has one local archive, made for the document the republish sends; look at what the capture peer holds under each configuration.`,
		);
	}
	return {
		publish: first.taken.document,
		targetIdentity: first.taken.record,
	};
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
	if (!Buffer.isBuffer(archive)) {
		throw new Error(
			`The download rule refused a second local archive of ${source.id}, whose first it made: both read the same declaration and the same project space.`,
		);
	}
	return archive;
}

/** Whether `localCcz` answered the download's refusal of a project space that has no `.ccz`. */
function isLocalCczRefused(
	archive: Awaited<ReturnType<typeof localCcz>>,
): archive is LocalCczRefused {
	return archive !== null && !Buffer.isBuffer(archive);
}

/**
 * The refusal a document states in place of its local archive
 * (`./inputs.ts::LOCAL_REFUSED`): the download's reason, the host the
 * project space's app sends phones to, and the server the archive would
 * have named, whose origin the judge holds A's custom base URL against.
 */
function localRefusalJson(archive: LocalCczRefused) {
	return {
		reason: archive.refused.reason,
		host: archive.refused.host,
		server: COMMCARE_SERVERS[PROOF_SERVER].baseUrl,
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

// ── A document made in CommCare HQ ───────────────────────────────────

/** The files of a base's retained directory that A is made of, which every base holds. */
const AUTHORED_FILES = ["app.json", "seed.json"] as const;
/** The files of a base's retained directory that A is made of where the base holds them. */
const AUTHORED_FILES_WHERE_HELD = [
	"media.json",
	"tables.json",
	"places.json",
	"practice-workers.json",
] as const;

/**
 * Copy what the base's A is made of from its retained directory into the
 * document's `authored/`, byte for byte, so the document's key names it and
 * the unit makes A of exactly these bytes.
 */
async function writeAuthored(
	root: string,
	documentId: string,
	retained: string,
): Promise<void> {
	const authored = join(root, "authored");
	await mkdir(authored, { recursive: true });
	for (const name of AUTHORED_FILES) {
		if (!existsSync(join(retained, name))) {
			throw new Error(
				`The base of ${documentId} retains no ${name} in ${retained}, and the unit makes A of it. Everything under proof/hq-apps/ is written by the lane; make the base again with python3 -m proof.matrix.adopt over every output of a lane run.`,
			);
		}
		await copyFile(join(retained, name), join(authored, name));
	}
	for (const name of AUTHORED_FILES_WHERE_HELD) {
		if (existsSync(join(retained, name))) {
			await copyFile(join(retained, name), join(authored, name));
		}
	}
	const media = join(retained, "media");
	if (existsSync(media)) {
		await mkdir(join(authored, "media"), { recursive: true });
		for (const name of (await readdir(media)).sort()) {
			await copyFile(join(media, name), join(authored, "media", name));
		}
	}
}

/** `base.json`'s `configuration`: one entry of a corpus document's `configurations.json`, key for key. */
const baseConfigurationSchema = z.object({
	configuration: z.strictObject({
		flags: z.array(z.string()),
		namedPrivileges: z.array(z.string()),
		commcareVersion: z.string(),
		commtrack: z.boolean(),
		syncCasesOnFormEntry: z.boolean(),
		caseSearchEnabled: z.boolean(),
	}),
});

/** The one configuration a base was authored under, from its `base.json`. */
async function baseConfiguration(
	documentId: string,
	retained: string,
): Promise<CorpusConfiguration> {
	const parsed = baseConfigurationSchema.safeParse(
		JSON.parse(await readFile(join(retained, "base.json"), "utf8")),
	);
	if (!parsed.success) {
		throw new Error(
			`The base of ${documentId} retains a base.json whose configuration is not one of a corpus document's configurations.json (${parsed.error.message}). The lane writes it from proof/matrix/registry.py.`,
		);
	}
	const { configuration } = parsed.data;
	return {
		flags: configuration.flags,
		namedPrivileges: configuration.namedPrivileges,
		commcareVersion: configuration.commcareVersion,
		commtrack: configuration.commtrack,
		syncCasesOnFormEntry: configuration.syncCasesOnFormEntry,
		caseSearchEnabled: configuration.caseSearchEnabled,
	};
}

/** One state a base's value expectation runs at: HQ's A, Nova's B, or Nova's local archive. */
const EXPECTATION_STATES = ["A", "B", "local"] as const;

/**
 * One value expectation of a base's `expectations.json`, as a person writes
 * it: `proof/targeted/expected.ts::Expectation` less `export`, its form by
 * HQ's positions, with the entry it holds and the states it runs at.
 */
const handExpectationSchema = z.strictObject({
	id: z.string().min(1),
	entry: z.string().min(1),
	form: z.strictObject({
		menu: z.number().int().nonnegative(),
		form: z.number().int().nonnegative(),
	}),
	restore: z.string().min(1),
	request: z.record(z.string(), z.unknown()),
	expect: z.array(z.strictObject({ pointer: z.string(), value: z.unknown() })),
	exports: z.array(z.enum(EXPECTATION_STATES)).min(1).optional(),
});

/** The form of HQ's app at `place`, as the reading's identity rows name D's form for it. */
function formAt(
	documentId: string,
	facts: HqAuthoredFacts,
	place: { readonly menu: number; readonly form: number },
): string {
	const modules = (facts.source as { readonly modules?: unknown }).modules;
	const form = Array.isArray(modules)
		? (modules[place.menu] as { readonly forms?: unknown } | undefined)?.forms
		: undefined;
	const xmlns = Array.isArray(form)
		? (form[place.form] as { readonly xmlns?: unknown } | undefined)?.xmlns
		: undefined;
	const row =
		typeof xmlns === "string"
			? facts.identity.find(
					(one) => one.entityKind === "form" && one.xmlns === xmlns,
				)
			: undefined;
	if (row === undefined) {
		throw new Error(
			`A value expectation of ${documentId} names the form at menu ${place.menu}, form ${place.form} of CommCare HQ's app, and ${typeof xmlns === "string" ? `the reading holds no form of its xmlns ${xmlns}` : "the app holds no form there"}. Look at the positions in proof/matrix/hand/${documentId}/expectations.json against the base's app.json.`,
		);
	}
	return row.novaEntityUuid;
}

/** One value expectation of a base's `expected.json`, at one state. */
interface HandIntent {
	readonly id: string;
	readonly export: (typeof EXPECTATION_STATES)[number];
	readonly form: string;
	readonly restore: string;
	readonly request: Readonly<Record<string, unknown>>;
	readonly expect: readonly {
		readonly pointer: string;
		readonly value?: unknown;
	}[];
}

/**
 * The base's hand-written value expectations as the document's
 * `expected.json`: one expectation for each state it runs at (every state
 * where it names none), less the local archive where the declaration D was
 * read under leaves Android out, each named `<id>@<state>` and its form
 * resolved to D's, with `entry` and `exports` left to the matrix's own
 * tests. Returns the restores they name, by file name, with their text.
 */
async function handExpected(
	documentId: string,
	facts: HqAuthoredFacts,
): Promise<{
	readonly expected: { readonly intent: readonly HandIntent[] };
	readonly files: Readonly<Record<string, string>>;
}> {
	const path = join(facts.hand, "expectations.json");
	if (!existsSync(path)) {
		throw new Error(
			`${documentId} has no hand-written value expectations (${path}). Every base holds at least one a form, written by hand from what its builder authors.`,
		);
	}
	const parsed = z
		.array(handExpectationSchema)
		.safeParse(JSON.parse(await readFile(path, "utf8")));
	if (!parsed.success) {
		throw new Error(
			`${path} is not a list of value expectations ({id, entry, form: {menu, form}, restore, request, expect, exports?}): ${parsed.error.message}`,
		);
	}
	const archive = facts.declaration.runsOnlyOn !== "web-apps";
	const intent: HandIntent[] = [];
	const files: Record<string, string> = {};
	for (const expectation of parsed.data) {
		checkDocumentFileName(documentId, expectation.restore);
		if (files[expectation.restore] === undefined) {
			const restore = join(facts.hand, expectation.restore);
			if (!existsSync(restore)) {
				throw new Error(
					`The value expectation ${expectation.id} of ${documentId} runs over ${expectation.restore}, and ${facts.hand} holds no such file.`,
				);
			}
			files[expectation.restore] = await readFile(restore, "utf8");
		}
		const form = formAt(documentId, facts, expectation.form);
		const states = expectation.exports ?? EXPECTATION_STATES;
		/* Core's evaluate opens a case list only on an installed archive, and
		 * the local export is the one the lane installs
		 * (`proof/observe/intent.py::expectations`). */
		const listed = states.filter((state) => state !== "local");
		if ("caseList" in expectation.request && listed.length > 0) {
			throw new Error(
				`The value expectation ${expectation.id} of ${documentId} opens a case list on ${listed.join(" and ")}, and a case list opens only on the local archive. Give it "exports": ["local"] in proof/matrix/hand/${documentId}/expectations.json.`,
			);
		}
		for (const state of states) {
			if (state === "local" && !archive) continue;
			intent.push({
				id: `${expectation.id}@${state}`,
				export: state,
				form,
				restore: expectation.restore,
				request: expectation.request,
				expect: expectation.expect,
			});
		}
	}
	return { expected: { intent }, files };
}

/** One answer as `proof/hq/operations.py::HqAnswer.retained()` writes it, its body parsed. */
async function retainedBody(path: string): Promise<unknown> {
	const answer = JSON.parse(await readFile(path, "utf8")) as {
		readonly body?: string;
	};
	return JSON.parse(answer.body ?? "null");
}

/** A field's value as `FixtureResource` serves it: one text, or each value with its properties. */
type ServedFieldValue =
	| string
	| {
			readonly field_list: readonly {
				readonly field_value: string;
				readonly properties: Readonly<Record<string, string>>;
			}[];
	  };

/**
 * The lookup tables the base's project space holds, as the capture's peer
 * holds them before Nova's first publish over A (`PublishInput.hqTables`):
 * each table HQ's table list answered (`lookup-tables.json`), under the id
 * HQ gave it, with its rows as HQ's rows read answered them
 * (`fixtureRowsFiles`) where the base retains that read, and its
 * description and each row's attributes as HQ's models hold them
 * (`tables.json`). A table whose rows no reading asked for holds none here,
 * and no publish over A reads them.
 */
async function retainedPeerTables(retained: string): Promise<PeerTable[]> {
	const listPath = join(retained, "lookup-tables.json");
	if (!existsSync(listPath)) return [];
	const list = (await retainedBody(listPath)) as {
		readonly objects?: readonly {
			readonly id: string;
			readonly tag: string;
			readonly is_global: boolean;
			readonly fields: readonly {
				readonly field_name: string;
				readonly properties: readonly string[];
			}[];
			readonly item_attributes: readonly string[];
		}[];
	};
	const modelled = existsSync(join(retained, "tables.json"))
		? (JSON.parse(await readFile(join(retained, "tables.json"), "utf8")) as {
				readonly tag: string;
				readonly description?: string;
				readonly rows?: readonly {
					readonly item_attributes?: Readonly<Record<string, string>>;
				}[];
			}[])
		: [];
	const tables: PeerTable[] = [];
	const files = fixtureRowsFiles(await readdir(retained));
	for (const table of list.objects ?? []) {
		const model = modelled.find((one) => one.tag === table.tag);
		const name = files.get(table.tag);
		const served =
			name !== undefined
				? ((
						(await retainedBody(join(retained, name))) as {
							readonly objects?: readonly {
								readonly id: string;
								readonly fields: Readonly<Record<string, ServedFieldValue>>;
							}[];
						}
					).objects ?? [])
				: [];
		tables.push({
			id: table.id,
			tag: table.tag,
			isGlobal: table.is_global,
			fields: table.fields.map((field) => ({
				name: field.field_name,
				properties: [...field.properties],
			})),
			itemAttributes: [...table.item_attributes],
			description: model?.description ?? "",
			rows: served.map((row, index) => ({
				id: row.id,
				fields: Object.fromEntries(
					Object.entries(row.fields).map(([name, value]) => [
						name,
						typeof value === "string"
							? [{ value, properties: {} }]
							: value.field_list.map((item) => ({
									value: item.field_value,
									properties: item.properties,
								})),
					]),
				),
				itemAttributes: model?.rows?.[index]?.item_attributes ?? {},
			})),
		});
	}
	return tables;
}

/**
 * The one configuration a document made in CommCare HQ is published under,
 * as Nova's publish reads it, `minimum`, after refusing one Nova's publish
 * of D or D′ would refuse: the base was authored under it, and A has no
 * other configuration to be made again under.
 */
function baseConfigurations(
	document: CorpusDocument,
	configuration: CorpusConfiguration,
	verdicts: readonly NovaPublishVerdict[],
): [string, ConfigurationFlags][] {
	const lacking = [
		...new Set(
			verdicts.flatMap((verdict) => verdictLacks(verdict, configuration)),
		),
	];
	if (lacking.length > 0) {
		throw new Error(
			`${document.id} is an app CommCare HQ's own pages made under its base's configuration, and Nova's publish of its document would refuse that project space (it lacks ${lacking.join(", ")}). A base is authored under the flags, privileges and case search its content needs; look at its row of proof/matrix/registry.py.`,
		);
	}
	return [
		[
			"minimum",
			{
				flags: configuration.flags,
				caseSearchEnabled: configuration.caseSearchEnabled,
			},
		],
	];
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
	/* A document made in CommCare HQ publishes over its base's own app, under
	 * the one configuration the base was authored under. Its `document.json`
	 * is written with the archives, of the document the republish sent
	 * (`republishedDocument`): a document made in HQ states no saves, so
	 * that is D. */
	const authored = document.hqAuthored;
	if (authored !== undefined && document.hqSide !== undefined) {
		throw new Error(
			`${document.id} is an app CommCare HQ's own pages made, and it names saves a person makes in HQ over A (hq-side.json). Its A is HQ's own app, so nothing is saved over it before Nova's first publish; show a save made in HQ on a targeted document.`,
		);
	}
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
	const authoredConfiguration =
		authored === undefined
			? undefined
			: await baseConfiguration(document.id, authored.retained);
	/* A base's value expectations, written once its local archive is made or
	 * refused: an expectation at the local archive runs only where one is. */
	let hand: Awaited<ReturnType<typeof handExpected>> | undefined;
	if (authored !== undefined) {
		await writeAuthored(root, document.id, authored.retained);
		await writeJson(join(root, "first-publish.json"), {
			changes: authored.firstPublishPlaces.map(({ id, places }) => ({
				id,
				places,
			})),
		});
		hand = await handExpected(document.id, authored);
		for (const [name, content] of Object.entries(hand.files)) {
			await writeFile(join(root, name), content);
		}
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
	} else if (authoredConfiguration !== undefined) {
		const configurations: DocumentConfigurations = {
			minimum: authoredConfiguration,
			maximum: authoredConfiguration,
			singleFlag: {},
		};
		await writeJson(join(root, "configurations.json"), configurations);
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
	if (retained === undefined && authoredConfiguration === undefined) {
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
		authoredConfiguration !== undefined
			? baseConfigurations(
					document,
					authoredConfiguration,
					editVerdict === undefined ? [verdict] : [verdict, editVerdict],
				)
			: retained === undefined
				? configurationFlags(flags)
				: witnessConfigurations(
						document,
						retained,
						editVerdict === undefined ? [verdict] : [verdict, editVerdict],
					);
	const hqTables =
		authored === undefined
			? undefined
			: await retainedPeerTables(authored.retained);
	/* The deployment a publish over the base's app leaves is the one a
	 * bring-in of it left: its ids, held paths and keyed create prefixes are
	 * the target's. */
	const adopted =
		authored === undefined
			? undefined
			: {
					identity: authored.identity,
					mediaPaths: authored.mediaPaths,
					keyedCaseIds: authored.keyedCaseIds,
					columnWords: authored.columnWords,
				};
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
			authored !== undefined
				? await capturePublish({
						...input,
						hqAuthoredA: {
							source: authored.source as Readonly<Record<string, unknown>>,
							identity: authored.identity,
							mediaPaths: authored.mediaPaths,
							keyedCaseIds: authored.keyedCaseIds,
							columnWords: authored.columnWords,
						},
						...(hqTables !== undefined && hqTables.length > 0 && { hqTables }),
					})
				: retainedA === undefined
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
		if (capture?.status === "republished" && authored !== undefined) {
			/* A is the base's own app, under `authored/`: the export holds
			 * Nova's republish over it alone. */
			const directory = join(root, "export", name);
			await mkdir(directory, { recursive: true });
			const republish = capture.updates.republish;
			if (republish?.status === "sent") {
				await writeStep(directory, "republish", republish, new Map());
			}
			await writeJson(join(directory, "outcome.json"), {
				republish: outcomeJson(republish),
			});
			continue;
		}
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
			const { workbook, mediaUploads } = exported.publish;
			if (exported.named.lookups !== undefined && workbook !== undefined) {
				written.set(
					"lookups",
					new Map([[exported.named.lookups, workbook.body]]),
				);
			}
			for (const [index, upload] of (mediaUploads ?? []).entries()) {
				const file = exported.named.media[index];
				if (!file)
					throw new Error(
						`The retained media upload ${index + 1} has no file.`,
					);
				written.set(mediaRole(index), new Map([[file, upload.body]]));
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
			saveCounter: create.saveCounter,
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

	/* `document.json`, the local archives and the import file are of the
	 * document the republish sent: D, or, where a person's saves in HQ were
	 * brought in before it, the document the bring-in gave, which A after the
	 * saves and B both hold (`republishedDocument`). */
	const republished = republishedDocument(document.id, captures, publish);
	const targetFacts = archiveTargetFacts(document.id, captures, "republish");
	await writeJson(
		join(root, "document.json"),
		documentJson(
			document.id,
			document.source,
			republished.publish,
			republished.publish === publish
				? entry.doc
				: hydrate(
						republished.publish.doc,
						`the document ${document.id}'s bring-in gave`,
					),
			authored,
			targetFacts,
		),
	);
	/* A `.ccz` installs an app on Android and nothing else, so Nova's own
	 * download refuses one for a document that does not declare it
	 * (`not-declared-for-android`), and the corpus writes no local archive
	 * of it: a Web Apps worker meets HQ's build. */
	/* Each archive is made for the project space as the publish before it
	 * left it: the republished document's for the republish, under the record
	 * it was sent under, and D′'s for its update, each with what the project
	 * space keeps (`SentImport.targetFacts`). */
	const { targetIdentity } = republished;
	const localArchive = await localCcz(
		republished.publish,
		PROOF_DOMAIN,
		local(OPERATION_ORDINALS.local),
		{ targetFacts, targetIdentity, ...(adopted !== undefined && { adopted }) },
	);
	/* A project space whose app keeps a custom base URL elsewhere has no
	 * `.ccz` (`workers-sent-elsewhere`): the document states the download's
	 * refusal in place of the archive, which the bar holds to A
	 * (`proof/checks/bar.py::local_outcome`). */
	const localRefused = isLocalCczRefused(localArchive);
	if (localRefused) {
		await writeJson(join(root, LOCAL_REFUSED), localRefusalJson(localArchive));
	}
	if (hand !== undefined) {
		await writeJson(join(root, "expected.json"), {
			intent: localRefused
				? hand.expected.intent.filter((one) => one.export !== "local")
				: hand.expected.intent,
		});
	}
	if (Buffer.isBuffer(localArchive)) {
		await writeFile(join(root, "local.ccz"), localArchive);
		await writeFile(
			join(root, "local-again.ccz"),
			await requiredLocalCcz(
				republished.publish,
				local(OPERATION_ORDINALS.localAgain),
				{
					targetFacts,
					targetIdentity,
					...(adopted !== undefined && { adopted }),
				},
			),
		);
		if (
			named.some(([, configuration]) =>
				configuration.flags.includes(EMPTY_LIST_TEXT_FLAG),
			)
		) {
			await writeFile(
				join(root, EMPTY_LIST_TEXT_ARCHIVE),
				await requiredLocalCcz(
					republished.publish,
					local(OPERATION_ORDINALS.local),
					{
						emptyCaseListText: true,
						targetFacts,
						targetIdentity,
						...(adopted !== undefined && { adopted }),
					},
				),
			);
		}
	}
	await writeFile(
		join(root, "import-file.zip"),
		await importFile(republished.publish, PROOF_DOMAIN),
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
			documentJson(
				document.id,
				document.source,
				edit.publish,
				edit.nextDoc,
				authored,
			),
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
			await writeJson(
				join(directory, "outcome.json"),
				authored !== undefined
					? { update: outcomeJson(update) }
					: {
							create:
								capture.status === "republished"
									? {
											status: "sent",
											compatibility: retained?.exports.get(name)?.compatibility,
										}
									: outcomeJson(capture.create),
							update: outcomeJson(update),
						},
			);
		}
		/* D′ may change the declaration, so its archive follows its own. */
		const editArchive = await localCcz(
			edit.publish,
			PROOF_DOMAIN,
			local(OPERATION_ORDINALS.editLocal),
			{
				targetFacts: archiveTargetFacts(document.id, captures, "update"),
				...(adopted !== undefined && { adopted }),
			},
		);
		if (isLocalCczRefused(editArchive)) {
			await writeJson(
				join(editRoot, LOCAL_REFUSED),
				localRefusalJson(editArchive),
			);
		} else if (editArchive !== null) {
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
			hqAuthored: authored !== undefined,
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
		...(document.hqAuthored !== undefined && {
			hqAuthored: {
				...document.hqAuthored,
				mediaPaths: [...document.hqAuthored.mediaPaths],
			},
		}),
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
			hqAuthored?: Omit<HqAuthoredFacts, "mediaPaths"> & {
				mediaPaths: [string, string][];
			};
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
			...(raw.hqAuthored !== undefined && {
				hqAuthored: {
					...raw.hqAuthored,
					mediaPaths: new Map(raw.hqAuthored.mediaPaths),
				},
			}),
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
