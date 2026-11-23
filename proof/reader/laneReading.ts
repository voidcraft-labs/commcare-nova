/**
 * Nova's reading of an app CommCare HQ holds, as the proof lane asks for it:
 * the production path with no service around it, over HQ's retained answers.
 *
 * A first reading (`identity: "mint"`) is one call of
 * `lib/deployment/reading/gather.ts::gatherFromHq`, every step production
 * runs after the two reads of Nova's own store: the bracketed app read, the
 * flag read, the project data, the reader, the files' verdicts, acceptance
 * and the review. The Project it reads into holds nothing, so every table
 * stands as new. A read back (`identity: "match"`) is production's
 * bracketed read and flag read, then the reader under a matching resolver
 * over the corpus document's own identities, with every other input the
 * document's own; no acceptance runs, since the read back is itself the
 * claim the lane holds.
 *
 * Nothing here mints an id: every id of a reading is derived from the app's
 * id and `LANE_READING_ID`, so a reading of the same answers is the same
 * document.
 */

import { createHash } from "node:crypto";
import { Immer } from "immer";
import { v7 } from "uuid";
import { recordDialectRoundTrip } from "@/lib/agent/authoring/recordRoundTrip";
import { readHqSaveOnlyEditedAnswers } from "@/lib/commcare/client";
import {
	type HqAlignedModule,
	type HqAppReading,
	readHqAppForReading,
} from "@/lib/commcare/hq/appReading";
import { hqReadCircumstance } from "@/lib/commcare/hq/failure";
import {
	publishedCaseBlocks,
	sourceHoldsEditMode,
} from "@/lib/commcare/hq/publishedCaseBlocks";
import { wirePathFor } from "@/lib/commcare/multimedia/assetWirePath";
import {
	knownCaseTypesOf,
	knownLanguageCodesOf,
	type ReadDraft,
	type ReaderInput,
	type ReaderLookupCatalog,
	type ReaderMediaResolution,
	readHqApp,
	readHqLookupTagsSteps,
} from "@/lib/commcare/reader";
import { serializeClaimLog } from "@/lib/commcare/reader/accounting";
import { matchingResolver } from "@/lib/commcare/reader/identity";
import { externalIdentityMap } from "@/lib/commcare/reader/identityMap";
import { levelsAsPublished } from "@/lib/commcare/reader/worldEntities";
import { COMMCARE_SERVERS } from "@/lib/commcare/servers";
import {
	type ColumnFieldWordRow,
	targetWireIdentity,
	type WireIdentityOverride,
} from "@/lib/commcare/wireIdentity";
import {
	type AdoptedKeyedCaseId,
	adoptedIdentityRows,
	assignMediaPaths,
} from "@/lib/deployment/adoption";
import type { AcceptedDeclaration } from "@/lib/deployment/reading/acceptance";
import { readingAppStrings } from "@/lib/deployment/reading/appStrings";
import {
	type FirstPublishChangePlaces,
	firstPublishChangePlaces,
} from "@/lib/deployment/reading/firstPublishChanges";
import { type Gathered, gatherFromHq } from "@/lib/deployment/reading/gather";
import { Pieces } from "@/lib/deployment/reading/pieces";
import type { ReadingProjectSide } from "@/lib/deployment/reading/projectData/read";
import {
	mayUseProjectFactory,
	sourceFactoryReads,
} from "@/lib/deployment/reading/projectData/read";
import {
	EMPTY_TARGET_IDENTITY,
	observedTargetIdentity,
	resolveTargetIdentity,
} from "@/lib/deployment/targetIdentity";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import type { LookupValidationContext } from "@/lib/doc/lookupReferences";
import { applyMutations } from "@/lib/doc/mutations";
import type { DeclarationChoice } from "@/lib/doc/platformDeclaration";
import { ensureReferenceIndex } from "@/lib/doc/referenceIndex";
import type { Mutation } from "@/lib/doc/types";
import {
	type BlueprintDoc,
	blueprintDocSchema,
	type MediaKind,
} from "@/lib/domain";
import type { LookupRowId } from "@/lib/domain/lookupIds";
import { collectAssetRefs } from "@/lib/domain/mediaRefs";
import { lookupRevisionSchema } from "@/lib/lookup/schema";
import type {
	LookupFixtureDataSnapshot,
	LookupTableDefinition,
} from "@/lib/lookup/types";
import {
	partitionAssetRefs,
	resolveBuiltinManifestEntries,
} from "@/lib/media/builtinIconAssets";
import {
	type CircumstanceDetail,
	circumstanceFinding,
	type Finding,
	type HqPlace,
	type ReadCircumstance,
} from "@/lib/publish/hqFindings";
import type { RetainedHqAnswer } from "@/proof/corpus/hqAuthored";
import {
	LANE_READING_ID,
	LANE_TARGET,
	RetainedAnswerMissing,
	withRetainedHq,
} from "./retainedPeer";

/** Where a lane reading runs the app: `null` is Web Apps and Android. */
export interface LaneDeclaration {
	readonly runsOnlyOn: "web-apps" | "android" | null;
	readonly splitDatetime: boolean;
}

export interface LaneReadInput {
	/** The Nova app id the reading mints or matches under: the corpus document's `doc.appId`,
	 *  which for an `hq-authored` document is the base's id, as a targeted document's is its own. */
	readonly appId: string;
	/** The corpus document's `document.json`, whole: `doc`, its lookup snapshot, its media, and
	 *  the ids HQ holds for its menus and forms, under `hqAuthored` or at its top level, with the
	 *  paths of a base's held files under `hqAuthored` (`storedDocument`). Absent for a base's first reading,
	 *  which has no document yet. */
	readonly document?: unknown;
	/** HQ's answers, as the unit recorded them or `proof/hq-apps/` retains them. */
	readonly source: RetainedHqAnswer;
	readonly application: RetainedHqAnswer;
	/** HQ's answer to the version read that closes the bracketed read of the app. */
	readonly currentVersion: RetainedHqAnswer;
	/** HQ's two project space lists, whole and filtered by the flag. Asked for only where the
	 *  source holds a write saved only if changed. */
	readonly sourceFactoryReads?: Readonly<Record<string, RetainedHqAnswer>>;
	readonly projectSpaces?: {
		readonly all: RetainedHqAnswer;
		readonly flagged: RetainedHqAnswer;
	};
	/** Required for `identity: "mint"`: HQ's own project data answers, and its files. */
	readonly projectData?: {
		readonly lookupTables: RetainedHqAnswer;
		readonly fixtureRows: Readonly<Record<string, RetainedHqAnswer>>;
		readonly locationTypes?: RetainedHqAnswer;
		readonly locations?: RetainedHqAnswer;
		/** One a mapped path: HQ's answer to the file's read, and its bytes where HQ gave them. */
		readonly media: readonly {
			readonly path: string;
			readonly mediaType: string;
			readonly multimediaId: string;
			readonly status: number;
			readonly base64?: string;
		}[];
	};
	/**
	 * A read back's: HQ's answer to the read of each file its media map names at
	 * this state, as the unit records it (`proof/observe/unit.py::_Unit.api_reads`,
	 * `reads:media`). Where given, a path names the asset of the document whose
	 * bytes HQ served there (`servedFiles`), never one the document's paths
	 * name; absent, the path Nova's publish sent each file at
	 * (`publishedFiles`).
	 */
	readonly servedMedia?: readonly ServedFile[];
	/** A first reading's declaration: the base's own, or absent for the reading's preselected one. */
	readonly declaration?: LaneDeclaration;
	/** `mint`: a base's first reading. `match`: a read back, which must give D's own UUIDs. */
	readonly identity: "mint" | "match";
	/** The reader's `claims` option. */
	readonly claims: "counts" | "full";
}

/**
 * The files a first reading holds. Only a file the app's source references in
 * a slot Nova reads is one: a file HQ maps that nothing references, or that
 * only a setting kept in CommCare HQ names (the Android logos), stays HQ's,
 * and the reading never asks HQ for its bytes.
 */
export interface LaneMedia {
	/** One a held file, in the reading's file order. */
	readonly files: readonly {
		/** The asset id the document names the file by. */
		readonly assetId: string;
		readonly kind: MediaKind;
		/** What Nova's judge of the file's bytes found. */
		readonly mimeType: string;
		readonly extension: string;
		readonly contentHash: string;
		/** Every referenced path of HQ's map that names the file, `jr://file/...`. */
		readonly paths: readonly string[];
	}[];
	/** The path, without `jr://file/`, HQ keeps each held file under, by asset id
	 *  (`reading/birth.ts::adoptedDeploymentWrite`'s `assignMediaPaths`). */
	readonly paths: readonly {
		readonly assetId: string;
		readonly wirePath: string;
	}[];
}

/** A first reading's files, from the plan its verdicts judged (`Gathered.media`). */
function laneMediaOf(gathered: Gathered): LaneMedia {
	const plan = gathered.media;
	const files: LaneMedia["files"][number][] = [];
	for (const file of plan.files) {
		const verdict = Object.hasOwn(plan.verdicts, file.key)
			? plan.verdicts[file.key]
			: undefined;
		if (verdict?.kind !== "held") continue;
		const held = gathered.mediaFiles.find((one) =>
			file.paths.includes(one.hqPath),
		);
		if (held === undefined)
			throw new Error(
				`The reading judged ${file.key} a held file and adopted none of its paths, which adoptedMediaFiles gives every held file. Look at lib/deployment/reading/projectData/media.ts.`,
			);
		files.push({
			assetId: held.assetId,
			kind: verdict.file.kind,
			mimeType: verdict.file.mimeType,
			extension: verdict.file.extension,
			contentHash: verdict.file.contentHash,
			paths: [...file.paths],
		});
	}
	return {
		files,
		paths: assignMediaPaths(gathered.mediaFiles).rows.map((row) => ({
			assetId: row.assetId,
			wirePath: row.wirePath,
		})),
	};
}

export type LaneReading =
	| {
			readonly kind: "read";
			/** A first reading's document under its declaration; a read back's draft as it came. */
			readonly doc: BlueprintDoc;
			readonly identity: readonly WireIdentityOverride[];
			readonly declaration: LaneDeclaration;
			/** Every declaration the reading offers, for a read back's declaration check. */
			readonly offered: readonly LaneDeclaration[];
			readonly firstPublish: readonly string[];
			/** Where each change of `firstPublish` stands on a first reading
			 *  (`firstPublishChanges.ts::firstPublishChangePlaces`); none on a read back. */
			readonly firstPublishPlaces: readonly FirstPublishChangePlaces[];
			/** Each create keyed by an answer the document keeps, with the prefix its cases stand
			 *  under in CommCare HQ's app: the rows a bring-in records
			 *  (`targetIdentity.ts::resolveTargetIdentity`'s keyed creates), which every later publish to that project
			 *  space prints the create under. */
			readonly keyedCaseIds: readonly AdoptedKeyedCaseId[];
			/** Each case list column the document keeps whose field CommCare HQ's app stores
			 *  under the word Nova does not write, by screen: the rows a bring-in records
			 *  (`targetIdentity.ts::resolveTargetIdentity`'s column words), which every later
			 *  publish to that project space prints the column under. */
			readonly columnWords: readonly ColumnFieldWordRow[];
			/** A first reading's lookup data: each table the document reads, with CommCare HQ's
			 *  rows, as the birth leaves it in the Project (`bornLookup`). Absent on a read back,
			 *  whose tables are the corpus document's own. */
			readonly lookup?: LookupFixtureDataSnapshot;
			/** A first reading's files: each the document holds, and the path CommCare HQ keeps
			 *  each under, as the birth records them. Absent on a read back, whose files are the
			 *  corpus document's own. */
			readonly media?: LaneMedia;
			/** A read back's: each asset of the document's media that names the file another asset
			 *  names, to that asset, as the read back names it (`publishedFiles`, `servedFiles`).
			 *  Absent on a first reading. */
			readonly sameFile?: ReadonlyMap<string, string>;
			/** The retained answers the reader asked for, by name: a test holds each one asked. */
			readonly asked: readonly string[];
			/** Under `full`, the claim log as `serializeClaimLog` writes it; under `counts`, the JSON
			 *  of the count of claims by entry id. */
			readonly claims: string;
	  }
	| {
			readonly kind: "account";
			readonly findings: readonly Finding[];
			readonly asked: readonly string[];
			readonly claims: string;
	  }
	/** A first reading whose stated declaration is none the reading offers. */
	| {
			readonly kind: "declaration-not-offered";
			readonly stated: LaneDeclaration;
			readonly offered: readonly LaneDeclaration[];
			readonly asked: readonly string[];
			readonly claims: string;
	  };

// ---------------------------------------------------------------------------
// Developer messages
// ---------------------------------------------------------------------------

/** A request the lane holds no retained answer for. `base` is the app the reading is of: a base's id, or a corpus document's app id. */
export function noRetainedAnswer(path: string, base: string): string {
	return `Nova's reader asked CommCare HQ for ${path} while it read ${base}, and the lane holds no answer for that request. The retained answers are every request Nova's client makes of an app; either the client now asks for something new, which the lane must read and keep (proof/matrix/retain.py), or it built an address HQ does not give.`;
}

const MINT_WITHOUT_PROJECT_DATA =
	"A first reading of an app CommCare HQ holds needs HQ's project data answers (projectData), since the reading asks HQ for its lookup tables before the reader runs. Look at whoever built this LaneReadInput: the lane's records or proof/hq-apps/<base>/.";

const MATCH_WITHOUT_DOCUMENT =
	"A read back gives the corpus document's own identities back, so it needs that document (document, the document.json the corpus holds). Look at whoever built this LaneReadInput.";

const NOT_A_DOCUMENT =
	"A read back was handed a document that is not a corpus document.json: it holds no doc. Pass the file the corpus holds whole.";

// ---------------------------------------------------------------------------
// The Project a first reading reads into
// ---------------------------------------------------------------------------

const EMPTY_REVISION = lookupRevisionSchema.parse("0");

/**
 * A Project that holds nothing: no table of any tag, no app that references
 * one, no sibling mapping, and a member who may administer it. Every row
 * measures under both caps; the caps are Postgres's to measure, and the
 * project data's own tests hold them.
 */
const EMPTY_PROJECT: ReadingProjectSide = {
	tables: async () => ({
		projectId: "proof-lane",
		projectRevision: EMPTY_REVISION,
		definitions: [],
		rowsByTable: {},
		keptColumns: {},
	}),
	referencingApps: async () => ({}),
	siblings: async () => [],
	mayAdminister: async () => true,
	measureRows: async () => ({ dataBytes: 0, largestRowBytes: 0 }),
};

/**
 * The instant a lane birth stamps on each table it brings in, as the day it
 * was brought in and last refreshed: a fixed one, so a reading of the same
 * answers is the same document. Only a finding that a copy is stale reads
 * either day, and no publish the lane captures asks for one.
 */
export const LANE_BROUGHT_IN_AT = "2026-01-01T00:00:00.000Z";

/**
 * The id Nova's lookup store gives a row a birth brings in. The store mints
 * one with Postgres's `uuidv7()` (`lib/lookup/managed.ts`); a lane birth
 * derives it instead, so a reading of the same answers is the same document:
 * a UUIDv7 whose time is `LANE_READING_ID`'s and whose random bits are the
 * first 16 bytes of the SHA-256 of the table's id and HQ's id for the row.
 * No document names a row brought in by its id.
 */
function bornRowId(tableId: string, hqRowId: string): LookupRowId {
	const digest = createHash("sha256")
		.update(JSON.stringify(["nova-proof-lane-row", tableId, hqRowId]), "utf8")
		.digest();
	return v7({
		msecs: Number.parseInt(
			LANE_READING_ID.replaceAll("-", "").slice(0, 12),
			16,
		),
		random: new Uint8Array(digest.subarray(0, 16)),
	}) as LookupRowId;
}

/**
 * A first reading's lookup data as the birth leaves it in the Project: the
 * tables acceptance validates the document under (`Gathered.lookup`), each
 * with the origin `lookupTableStore.ts::writeBroughtInLookupTablesInTransaction`
 * stores for a table it creates, so CommCare HQ manages it from the project
 * space the app was read from, under the id HQ gave it, and each of its rows
 * under the id the store gives it (`bornRowId`) where the reading keys it by
 * HQ's. A publish to that project space then leaves the table out of its
 * workbook and reads HQ's rows again
 * (`export/boundaryFindings.ts::leftOutOfMainWorkbook`,
 * `deployment/managedData.ts`), as it does after a real bring-in.
 */
function bornLookup(gathered: Gathered): LookupFixtureDataSnapshot {
	const { origin, tables } = gathered.fetched.data.gathered;
	const born = new Set<string>();
	const definitions = gathered.lookup.definitions.map((definition) => {
		if (definition.hq !== undefined) return definition;
		born.add(definition.id);
		const read = tables.find(
			(table) => table.binding?.tableId === definition.id,
		)?.read;
		if (read === undefined)
			throw new Error(
				`The reading's lookup data holds a table (${definition.id}) that no table CommCare HQ listed is bound to, which readingLookupSnapshot never gives. Look at lib/deployment/reading/projectData/lookupTables.ts.`,
			);
		return {
			...definition,
			hq: {
				server: origin.server,
				domain: origin.domain,
				remoteId: read.table.id,
				managedBy: "commcare-hq" as const,
				broughtInAt: LANE_BROUGHT_IN_AT,
				takenOverAt: null,
				takenOverBy: null,
				refreshedAt: LANE_BROUGHT_IN_AT,
				goneColumnIds: [],
			},
		};
	});
	return {
		...gathered.lookup,
		definitions,
		rowsByTable: new Map(
			[...gathered.lookup.rowsByTable].map(([tableId, rows]) => [
				tableId,
				born.has(tableId)
					? rows.map((row) => ({ ...row, id: bornRowId(tableId, row.id) }))
					: rows,
			]),
		),
	};
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

const APP: HqPlace = { kind: "app" };

/** A circumstance at the app with no detail, as every stop of the bracketed read is. */
function atApp(code: ReadCircumstance): Finding {
	return circumstanceFinding(code, APP, {} as CircumstanceDetail<typeof code>);
}

function laneDeclarationOf(
	runsOnlyOn: "web-apps" | "android" | undefined | null,
	splitDatetime: boolean,
): LaneDeclaration {
	return { runsOnlyOn: runsOnlyOn ?? null, splitDatetime };
}

function sameDeclaration(a: LaneDeclaration, b: LaneDeclaration): boolean {
	return a.runsOnlyOn === b.runsOnlyOn && a.splitDatetime === b.splitDatetime;
}

/** The app id the retained application resource names: the app a reading asks for. */
function remoteAppIdOf(application: RetainedHqAnswer): string {
	try {
		const body = JSON.parse(application.body ?? "") as { id?: unknown };
		if (typeof body.id === "string") return body.id;
	} catch {
		/* Answered below. */
	}
	return "";
}

const UNFROZEN = new Immer({ autoFreeze: false });

/** A copy of `doc` with `mutations` applied; `doc` stays as it came. */
function docUnder(
	doc: BlueprintDoc,
	mutations: readonly Mutation[],
): BlueprintDoc {
	return UNFROZEN.produce(doc, (working) => {
		applyMutations(working, mutations);
	});
}

/** The bracketed read's answer as the account a reading gives where it is no read. */
function readingStop(
	reading: Exclude<HqAppReading, { kind: "read" }>,
): Finding {
	switch (reading.kind) {
		case "changed":
			return atApp("changed-while-reading");
		case "linked":
			return atApp("linked-app");
		case "remote":
			return atApp("remote-app");
		case "deleted":
			return atApp("app-deleted");
		case "gone":
			return atApp("app-gone");
		case "failed":
			return atApp(hqReadCircumstance(reading.failure));
	}
}

// ---------------------------------------------------------------------------
// A first reading
// ---------------------------------------------------------------------------

async function firstReading(
	input: LaneReadInput,
	creds: Parameters<typeof gatherFromHq>[0]["creds"],
	asked: () => readonly string[],
): Promise<LaneReading> {
	const { result, claims } = await gatherFromHq({
		key: {
			projectId: "proof-lane",
			...LANE_TARGET,
			remoteAppId: remoteAppIdOf(input.application),
		},
		readingId: LANE_READING_ID,
		appId: input.appId,
		keepMedia: false,
		onEvent: () => {},
		creds,
		project: EMPTY_PROJECT,
		claims: input.claims,
	});
	const claimsText =
		claims === null
			? ""
			: input.claims === "full"
				? (claims.log ?? "")
				: JSON.stringify(claims.counts);
	if (result.kind === "stop")
		return {
			kind: "account",
			findings: [result.finding],
			asked: asked(),
			claims: claimsText,
		};
	if (result.kind === "account")
		return {
			kind: "account",
			findings: result.account.findings,
			asked: asked(),
			claims: claimsText,
		};
	const { draft, accepted, fetched } = result.gathered;
	const offered = accepted.declarations.map((one) =>
		laneDeclarationOf(one.runsOnlyOn, one.splitDatetime),
	);
	const chosen: AcceptedDeclaration | undefined =
		input.declaration === undefined
			? accepted.declarations.find((one) => one.preselected)
			: accepted.declarations.find((one) =>
					sameDeclaration(
						laneDeclarationOf(one.runsOnlyOn, one.splitDatetime),
						input.declaration as LaneDeclaration,
					),
				);
	if (chosen === undefined) {
		if (input.declaration === undefined)
			throw new Error(
				"Acceptance offered no preselected declaration, which every clean reading has. Look at lib/deployment/reading/acceptance.ts.",
			);
		return {
			kind: "declaration-not-offered",
			stated: input.declaration,
			offered,
			asked: asked(),
			claims: claimsText,
		};
	}
	const rows = adoptedIdentityRows(draft.identities, fetched.modules);
	if (!rows.ok)
		throw new Error(
			`A clean reading named a menu or form CommCare HQ's application resource does not hold (${rows.at}), which acceptance refuses before a reading is clean. Look at lib/deployment/adoption.ts::adoptedIdentityRows.`,
		);
	return {
		kind: "read",
		doc: docUnder(draft.doc, chosen.mutations),
		identity: rows.rows.map(
			({ entityKind, novaEntityUuid, uniqueId, xmlns }) => ({
				entityKind,
				novaEntityUuid,
				uniqueId,
				xmlns,
			}),
		),
		declaration: laneDeclarationOf(chosen.runsOnlyOn, chosen.splitDatetime),
		offered,
		firstPublish: [...chosen.firstPublish.ids],
		firstPublishPlaces: firstPublishChangePlaces(
			chosen.firstPublishFacts,
			chosen.firstPublish.ids,
		),
		/* The record the birth writes (`reading/birth.ts::adoptedDeploymentWrite`). */
		keyedCaseIds: result.gathered.targetIdentity.keyedCaseIds,
		columnWords: result.gathered.targetIdentity.columnWords,
		lookup: bornLookup(result.gathered),
		media: laneMediaOf(result.gathered),
		asked: asked(),
		claims: claimsText,
	};
}

// ---------------------------------------------------------------------------
// A read back
// ---------------------------------------------------------------------------

/** What a read back reads of `document.json`. */
interface StoredDocument {
	readonly doc: BlueprintDoc;
	readonly lookupDefinitions: readonly LookupTableDefinition[];
	readonly lookup: LookupValidationContext;
	/** Each file by the path Nova's publish sent it at: an uploaded asset, or a built-in icon the
	 *  document shows. */
	readonly published: PublishedFiles;
	/** Each uploaded asset of the document's media, in its order, then each built-in icon the
	 *  document shows, with the SHA-256 of its bytes. */
	readonly assets: readonly DocumentAsset[];
	readonly identity: readonly WireIdentityOverride[];
}

interface StoredMedia {
	readonly kind: MediaKind;
	readonly extension: string;
	readonly base64: string;
}

/** An asset a corpus document can name a file by, with the SHA-256 of its bytes, hex. */
export interface DocumentAsset {
	readonly assetId: string;
	readonly kind: MediaKind;
	readonly contentHash: string;
}

/** HQ's answer to the read of one file its media map names (`proof/observe/unit.py::_Unit.api_reads`, `reads:media`). */
export interface ServedFile {
	/** The map's path, `jr://file/...`. */
	readonly path: string;
	/** The status HQ answered the file's read with. */
	readonly status: number;
	/** The SHA-256 of the bytes HQ sent, hex. */
	readonly sha256?: string;
}

/** The uploaded files Nova's publish of a corpus document sent, by path. */
export interface PublishedFiles {
	/** The asset each path names, the first in the document's media order of those sent there. */
	readonly byPath: ReadonlyMap<
		string,
		{ readonly assetId: string; readonly kind: MediaKind }
	>;
	/**
	 * Each asset sent at a path an earlier asset of the document's media was sent at, to that
	 * earlier asset. Two assets of one Project are never one file: the media store keeps one
	 * ready asset a content (`lib/media/publishReadyMedia.ts`, and the browser upload's confirm),
	 * so where a corpus document gives two of its assets the same bytes (the compiler fuzz's
	 * manifest gives every asset of a kind one file, `compilerEvidence.ts::manifestFor`), HQ holds
	 * one file at their one path and a reading of it names the one asset `byPath` holds there.
	 */
	readonly sameFile: ReadonlyMap<string, string>;
}

/** The SHA-256 of a stored asset's bytes, hex. */
function storedContentHash(asset: StoredMedia): string {
	return createHash("sha256")
		.update(Buffer.from(asset.base64, "base64"))
		.digest("hex");
}

/** `document.json`'s uploaded assets, in its media's order. */
function storedMediaOf(document: unknown): readonly [string, StoredMedia][] {
	if (typeof document !== "object" || document === null || !("doc" in document))
		throw new Error(NOT_A_DOCUMENT);
	const media = (
		document as { readonly media?: Readonly<Record<string, StoredMedia>> }
	).media;
	return Object.entries(media ?? {});
}

/**
 * The uploaded files of a corpus document's `document.json`, by the path its
 * publish sent each at: the one path HQ keeps a held file under on the
 * project space the app came from (`hqAuthored.mediaPaths`, as the birth
 * records it), else the path its content derives
 * (`assetWirePath.ts::wirePathFor`), as production's manifest gives each
 * asset one path (`lib/media/manifest.ts::resolveMediaManifest`'s
 * `heldPaths`). A held path takes its held asset before any asset whose
 * content derives the same path: HQ holds the held file there, so the other
 * is the same file (`sameFile`). What HQ holds at a path a person saved over
 * is no file Nova's publish sent: a read back of such a state is told what HQ
 * served there (`servedFiles`).
 */
export function publishedFiles(document: unknown): PublishedFiles {
	const entries = storedMediaOf(document);
	const heldPaths =
		(
			document as {
				readonly hqAuthored?: {
					readonly mediaPaths?: Readonly<Record<string, string>>;
				};
			}
		).hqAuthored?.mediaPaths ?? {};
	const byPath = new Map<
		string,
		{ readonly assetId: string; readonly kind: MediaKind }
	>();
	const sameFile = new Map<string, string>();
	const heldAt = (assetId: string) =>
		Object.hasOwn(heldPaths, assetId) ? heldPaths[assetId] : undefined;
	// A held path first: HQ keeps the held file there, so an asset whose content derives the same
	// path names the held file, as a read of HQ's answer does.
	for (const held of [true, false])
		for (const [assetId, asset] of entries) {
			const at = heldAt(assetId);
			if ((at !== undefined) !== held) continue;
			const path =
				at ??
				`jr://file/${wirePathFor(storedContentHash(asset), asset.extension)}`;
			const earlier = byPath.get(path);
			if (earlier === undefined)
				byPath.set(path, { assetId, kind: asset.kind });
			else sameFile.set(assetId, earlier.assetId);
		}
	return { byPath, sameFile };
}

/** A read back's media index, and the assets it names by another of the same file. */
export interface LaneMediaIndex {
	readonly resolve: (path: string) => ReaderMediaResolution;
	readonly sameFile: ReadonlyMap<string, string>;
}

/**
 * The index a read back of a state HQ holds answers each path with, from what
 * HQ served at that state (`served`, one row a path its media map names):
 * the asset of `assets` whose bytes are the ones HQ sent there, as
 * production's review answers a path from the bytes it fetched
 * (`lib/deployment/hqChanges/readings.ts::nowIndex`). Where two assets hold
 * the same bytes, the first of them in `assets`' order names the file, and
 * the other is that file (`sameFile`), as one Project keeps one asset a
 * content. A path HQ's map does not name is `no-entry`; one HQ served no file
 * at, or bytes no asset holds, `unreadable`, so a reading that named any asset
 * there differs. No path the document records takes part.
 */
export function servedFiles(
	assets: readonly DocumentAsset[],
	served: readonly ServedFile[],
): LaneMediaIndex {
	const byHash = new Map<string, DocumentAsset>();
	const sameFile = new Map<string, string>();
	for (const asset of assets) {
		const earlier = byHash.get(asset.contentHash);
		if (earlier === undefined) byHash.set(asset.contentHash, asset);
		else if (earlier.assetId !== asset.assetId)
			sameFile.set(asset.assetId, earlier.assetId);
	}
	const rows = new Map(served.map((row) => [row.path, row]));
	return {
		resolve: (path) => {
			const row = rows.get(path);
			if (row === undefined) return { kind: "no-entry" };
			const asset =
				row.status === 200 && row.sha256 !== undefined
					? byHash.get(row.sha256)
					: undefined;
			return asset === undefined
				? { kind: "unreadable" }
				: { kind: "asset", assetId: asset.assetId, mediaKind: asset.kind };
		},
		sameFile,
	};
}

/**
 * What a read back reads of `document.json`. The ids CommCare HQ holds for
 * each menu and form stand either under `hqAuthored`, for an app made in
 * CommCare HQ, or at the document's top level (`identity`), which proof 6
 * gives the document a bring-in of a person's saves left
 * (`proof/checks/proof6.py`, `BroughtIn.identities`); the top level's stand
 * where both are given. Every read back is told the document's own case
 * types and language codes (`knownCaseTypesOf`, `knownLanguageCodesOf`), as
 * production's re-read of an app Nova holds is, a brought-in one too
 * (`lib/deployment/hqChanges/readings.ts`, and acceptance's own re-read of a
 * reading), so a type Nova's edit of an app made in CommCare HQ declares
 * reads back declared.
 *
 * The files are those Nova's publish of the document sent: each uploaded
 * asset at the path it was sent at (`publishedFiles`), and each built-in icon
 * the document shows at the content path production's manifest gives it
 * (`lib/media/builtinIconAssets.ts::resolveBuiltinManifestEntries`), as the
 * index a read of changes made in CommCare HQ answers a published path with
 * (`lib/deployment/hqChanges/readings.ts::withOwnFiles`); and every one of
 * those assets with the hash of its bytes, which a read of what HQ served
 * names a path by (`servedFiles`).
 */
async function storedDocument(document: unknown): Promise<StoredDocument> {
	const uploaded = storedMediaOf(document);
	const stored = document as {
		readonly doc: unknown;
		readonly lookup?: {
			readonly projectId: string;
			readonly projectRevision: string;
			readonly definitions: readonly LookupTableDefinition[];
		};
		readonly identity?: readonly WireIdentityOverride[];
		readonly hqAuthored?: {
			readonly identity: readonly WireIdentityOverride[];
		};
	};
	const doc = hydratePersistedBlueprint(blueprintDocSchema.parse(stored.doc));
	ensureReferenceIndex(doc);
	const definitions = stored.lookup?.definitions ?? [];
	const files = publishedFiles(document);
	const byPath = new Map(files.byPath);
	const assets: DocumentAsset[] = uploaded.map(([assetId, asset]) => ({
		assetId,
		kind: asset.kind,
		contentHash: storedContentHash(asset),
	}));
	const { builtinSlugs } = partitionAssetRefs([...collectAssetRefs(doc)]);
	for (const [assetId, asset] of await resolveBuiltinManifestEntries(
		builtinSlugs,
		false,
	)) {
		const path = `jr://file/${asset.wirePath}`;
		if (!byPath.has(path)) byPath.set(path, { assetId, kind: asset.kind });
		assets.push({ assetId, kind: asset.kind, contentHash: asset.contentHash });
	}
	return {
		doc,
		lookupDefinitions: definitions,
		lookup: {
			kind: "available",
			projectId: stored.lookup?.projectId ?? "proof-lane",
			projectRevision: stored.lookup?.projectRevision ?? "0",
			definitions,
		} as LookupValidationContext,
		published: { byPath, sameFile: files.sameFile },
		assets,
		identity: stored.identity ?? stored.hqAuthored?.identity ?? [],
	};
}

/** The index a read back answers each path with: what HQ served where `served` is given, else
 *  the path Nova's publish sent each file at. */
function mediaIndexOf(
	stored: StoredDocument,
	served: readonly ServedFile[] | undefined,
): LaneMediaIndex {
	if (served !== undefined) return servedFiles(stored.assets, served);
	const { byPath, sameFile } = stored.published;
	return {
		resolve: (path) => {
			const asset = byPath.get(path);
			return asset === undefined
				? { kind: "no-entry" }
				: { kind: "asset", assetId: asset.assetId, mediaKind: asset.kind };
		},
		sameFile,
	};
}

/** The document's tables, by tag, as the reader is told the project space holds them. */
function lookupCatalogOf(
	definitions: readonly LookupTableDefinition[],
): ReaderLookupCatalog {
	return {
		table: (tag) => {
			const table = definitions.find((one) => one.tag === tag);
			return table === undefined
				? undefined
				: {
						tableId: table.id,
						column: (name) =>
							table.columns.find((column) => column.wireName === name)?.id,
					};
		},
		definitions: new Map(definitions.map((table) => [table.id, table])),
	};
}

async function readBack(
	input: LaneReadInput,
	creds: Parameters<typeof gatherFromHq>[0]["creds"],
	asked: () => readonly string[],
): Promise<LaneReading> {
	const stored = await storedDocument(input.document);
	const remoteAppId = remoteAppIdOf(input.application);
	const account = (finding: Finding): LaneReading => ({
		kind: "account",
		findings: [finding],
		asked: asked(),
		claims: "",
	});

	let reading = await readHqAppForReading(
		creds,
		LANE_TARGET.domain,
		remoteAppId,
	);
	if (reading.kind === "changed")
		reading = await readHqAppForReading(creds, LANE_TARGET.domain, remoteAppId);
	if (reading.kind !== "read") return account(readingStop(reading));
	const { source, modules } = reading;

	let saveOnlyEditedApplied: boolean | undefined;
	if (sourceHoldsEditMode(publishedCaseBlocks(source.raw))) {
		const flag = await readHqSaveOnlyEditedAnswers(creds, LANE_TARGET.domain);
		if (flag.kind === "not-a-member") return account(atApp("not-a-member"));
		if (flag.kind === "failed")
			return account(atApp(hqReadCircumstance(flag.failure)));
		saveOnlyEditedApplied = flag.kind === "applied";
	}

	const { doc } = stored;
	const files = mediaIndexOf(stored, input.servedMedia);
	const levels = levelsAsPublished(doc);
	const readerInput: ReaderInput = {
		appId: input.appId,
		target: {
			origin: COMMCARE_SERVERS[LANE_TARGET.server].baseUrl,
			domain: LANE_TARGET.domain,
		},
		source,
		modules,
		resolver: matchingResolver(
			input.appId,
			externalIdentityMap(doc, targetWireIdentity(stored.identity)),
		),
		lookup: lookupCatalogOf(stored.lookupDefinitions),
		organization: { levelCodes: levels.map((level) => level.code), levels },
		media: { resolve: files.resolve },
		appStrings: readingAppStrings(stored.lookup),
		recordDialect: recordDialectRoundTrip,
		...(saveOnlyEditedApplied !== undefined && { saveOnlyEditedApplied }),
		knownCaseTypes: knownCaseTypesOf(doc),
		knownLanguageCodes: knownLanguageCodesOf(doc),
	};
	const discovery = sourceFactoryReads({
		creds,
		domain: LANE_TARGET.domain,
		working: reading,
		source,
	});
	if (mayUseProjectFactory(source))
		await new Pieces().steps(
			readHqLookupTagsSteps({
				...readerInput,
				observeFactory: (kind, id, form) =>
					discovery.observe(source, kind, id, form),
			}),
		);
	const factories = await discovery.read();
	if (factories.kind === "failed")
		return account(atApp(hqReadCircumstance(factories.failure)));
	const outcome = readHqApp(
		{ ...readerInput, sourceProjectFactories: factories.facts },
		{ claims: input.claims },
	);
	const claims =
		input.claims === "full"
			? serializeClaimLog(outcome.claims)
			: JSON.stringify(outcome.claims.counts);
	if (outcome.kind === "account")
		return {
			kind: "account",
			findings: outcome.findings,
			asked: asked(),
			claims,
		};
	const { draft } = outcome;
	const choices: readonly DeclarationChoice[] =
		draft.declaration.kind === "choices" ? draft.declaration.choices : [];
	const proposed =
		draft.declaration.kind === "choices"
			? choices[draft.declaration.proposed]
			: undefined;
	const rows = adoptedIdentityRows(draft.identities, modules);
	if (!rows.ok)
		throw new Error(
			`A read back named a menu or form CommCare HQ's application resource does not hold (${rows.at}). Look at lib/deployment/adoption.ts::adoptedIdentityRows.`,
		);
	return {
		kind: "read",
		doc: draft.doc,
		identity: rows.rows.map(
			({ entityKind, novaEntityUuid, uniqueId, xmlns }) => ({
				entityKind,
				novaEntityUuid,
				uniqueId,
				xmlns,
			}),
		),
		declaration: laneDeclarationOf(
			proposed?.runsOnlyOn ?? doc.appSettings.runsOnlyOn,
			proposed?.split ?? false,
		),
		offered: choices.map((choice) =>
			laneDeclarationOf(choice.runsOnlyOn, choice.split),
		),
		firstPublish: [],
		firstPublishPlaces: [],
		...readBackRecordRows(draft, modules),
		sameFile: files.sameFile,
		asked: asked(),
		claims,
	};
}

// ---------------------------------------------------------------------------
// The entry
// ---------------------------------------------------------------------------

/**
 * Nova's reading of the app `input`'s answers hold, served through the
 * retained peer. A request with no retained answer ends the reading,
 * naming the request's path.
 */
export async function readForLane(input: LaneReadInput): Promise<LaneReading> {
	if (input.identity === "mint" && input.projectData === undefined)
		throw new Error(MINT_WITHOUT_PROJECT_DATA);
	if (input.identity === "match" && input.document === undefined)
		throw new Error(MATCH_WITHOUT_DOCUMENT);
	try {
		return await withRetainedHq(input, (peer) =>
			input.identity === "mint"
				? firstReading(input, peer.creds, () => peer.asked())
				: readBack(input, peer.creds, () => peer.asked()),
		);
	} catch (error) {
		if (error instanceof RetainedAnswerMissing)
			throw new Error(noRetainedAnswer(error.path, input.appId));
		throw error;
	}
}

/**
 * The keyed creates and the column words a read back holds, as a birth over it
 * records them: the reading observed
 * (`targetIdentity.ts::observedTargetIdentity`) and resolved over nothing.
 */
function readBackRecordRows(
	draft: ReadDraft,
	modules: readonly HqAlignedModule[],
): {
	readonly keyedCaseIds: readonly AdoptedKeyedCaseId[];
	readonly columnWords: readonly ColumnFieldWordRow[];
} {
	const observed = observedTargetIdentity({
		read: draft.identities,
		aligned: modules,
		mediaFiles: [],
		mediaMap: [],
		doc: draft.doc,
	});
	if (!observed.ok)
		throw new Error(
			`A read back named a menu or form CommCare HQ's application resource does not hold (${observed.at}). Look at lib/deployment/adoption.ts::adoptedIdentityRows.`,
		);
	const { keyedCaseIds, columnWords } = resolveTargetIdentity(
		EMPTY_TARGET_IDENTITY,
		observed.observed,
		draft.doc,
	);
	return { keyedCaseIds, columnWords };
}
