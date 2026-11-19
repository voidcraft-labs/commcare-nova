/**
 * The corpus's sixth source, `hq-authored`: apps CommCare HQ's own pages,
 * models and form builder made, retained whole under `proof/hq-apps/<base>/`
 * by the lane (`proof/matrix/retain.py`) and held to HQ at its pin, byte for
 * byte, on every lane run.
 *
 * A base's document is Nova's first reading of its retained answers
 * (`proof/reader/laneReading.ts::readForLane`), under the declaration the
 * base states or the reading's preselected one. A base whose reading is an
 * account stops the emission by name, and so does a base whose stated
 * declaration the reading does not offer: a base is made only
 * of what Nova holds. Beside D the reading gives what a bring-in of A
 * records and leaves: the ids HQ holds for each menu and form, the prefix
 * each keyed create's cases stand under, and the lookup tables D reads,
 * with HQ's rows, managed in CommCare HQ from A's project space.
 *
 * Nothing under `proof/hq-apps/` is written by hand. This module reads it.
 * What a person writes about a base lives under `proof/matrix/hand/<base>/`:
 * its value expectations and their restore, which the entry writer writes
 * beside the document, and, where the base states one, its edit
 * (`edit.ts`, exporting `edit(doc): readonly Mutation[]`), which Nova's
 * commit gate admits over D as an editor's save and which is the document's
 * one edit, as a targeted document's written edit is.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { placementChangeRefusal } from "@/lib/db/placementAuthority";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { withIdentityMoves } from "@/lib/doc/identityMoves";
import { readPlacementHolds } from "@/lib/doc/placementHolds";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc } from "@/lib/domain";
import { placeLine } from "@/lib/publish/hqFindingCopy";
import {
	type LaneDeclaration,
	type LaneMedia,
	type LaneReadInput,
	readForLane,
} from "@/proof/reader/laneReading";
import {
	type CorpusDocument,
	type HqAuthoredFacts,
	lookupContextOf,
	storedDocument,
} from "./documents";
import { hydrateAdmittedDocument } from "./editBatches";
import { WORKTREE } from "./emissionProcess";
import type { UploadedMedia } from "./publish";

/** Where the retained bases live, from the checkout's root. */
export const HQ_APPS = "proof/hq-apps";

/** Where what a person writes about each base lives, from the checkout's root. */
export const HQ_HAND = "proof/matrix/hand";

/** One retained answer, as `proof/hq/operations.py::HqAnswer.retained()` writes it. */
export interface RetainedHqAnswer {
	readonly status: number;
	/** `Content-Type` and `Retry-After`, where HQ sent them; absent where it sent neither. */
	readonly headers?: Readonly<Record<string, string>>;
	/** The body as text; absent where HQ sent none. */
	readonly body?: string;
}

export type MediaClass = "CommCareImage" | "CommCareAudio" | "CommCareVideo";

export interface RetainedHqApp {
	/** The base's id, which is its directory's name. */
	readonly id: string;
	/** Absolute path of `proof/hq-apps/<id>/`. */
	readonly directory: string;
	/** `base.json`. */
	readonly base: {
		readonly id: string;
		readonly configuration: {
			readonly flags: readonly string[];
			readonly namedPrivileges: readonly string[];
			readonly commcareVersion: string;
			readonly commtrack: boolean;
			readonly syncCasesOnFormEntry: boolean;
			readonly caseSearchEnabled: boolean;
		};
		readonly declaration: "preselected" | LaneDeclaration;
		readonly exhibits: readonly string[];
	};
	/** `app-source.json`, `application.json` and `current-version.json`. */
	readonly source: RetainedHqAnswer;
	readonly application: RetainedHqAnswer;
	readonly currentVersion: RetainedHqAnswer;
	/** `project-spaces.json` and `project-spaces-flag.json`, where the reading asks for them. */
	readonly projectSpaces?: {
		readonly all: RetainedHqAnswer;
		readonly flagged: RetainedHqAnswer;
	};
	/** `media.json`, one row a mapped path whose file HQ holds, each with its file read from `media/`. */
	readonly media: readonly {
		readonly path: string;
		readonly file: string;
		readonly mediaClass: MediaClass;
		readonly kind: "image" | "audio" | "video";
		readonly mimeType: string;
		readonly extension: string;
		readonly bytes: Uint8Array;
	}[];
	/** HQ's lookup table list, which every first reading asks for, whatever the app reads. */
	readonly lookupTables: RetainedHqAnswer;
	/** Where the base holds each: the rows, location and media answers. */
	readonly fixtureRows?: Readonly<Record<string, RetainedHqAnswer>>;
	readonly locationTypes?: RetainedHqAnswer;
	readonly locations?: RetainedHqAnswer;
	/**
	 * `media-reads.json`: each read the reading made of a mapped file, where it
	 * made any. A file the reading never asks for has a row in `media.json` and
	 * none here: one only a setting kept in CommCare HQ names (the Android
	 * logos), one nothing references, and a second path of a file it read
	 * under its first.
	 */
	readonly mediaReads?: readonly {
		readonly path: string;
		readonly mediaType: string;
		readonly multimediaId: string;
		readonly status: number;
		readonly sha256: string;
		readonly length: number;
	}[];
	/** `expected.json`. */
	readonly expected: {
		readonly reads: true;
		readonly declaration: LaneDeclaration;
		readonly claimed: readonly string[];
		readonly firstPublish: readonly string[];
	};
}

// ---------------------------------------------------------------------------
// Reading a base's directory
// ---------------------------------------------------------------------------

const FIXTURE_ROWS_PREFIX = "fixture-rows-";

function fail(directory: string, what: string): never {
	throw new Error(
		`The retained base ${directory} ${what}. Everything under proof/hq-apps/ is written by the lane; make it again with python3 -m proof.matrix.adopt over a lane run's output.`,
	);
}

function readJson(directory: string, name: string): unknown {
	try {
		return JSON.parse(readFileSync(join(directory, name), "utf8"));
	} catch (error) {
		return fail(
			directory,
			`holds no readable ${name} (${error instanceof Error ? error.message : String(error)})`,
		);
	}
}

function optionalJson(directory: string, name: string): unknown {
	return existsSync(join(directory, name))
		? readJson(directory, name)
		: undefined;
}

function answerOf(
	directory: string,
	name: string,
	value: unknown,
): RetainedHqAnswer {
	if (
		typeof value !== "object" ||
		value === null ||
		typeof (value as { status?: unknown }).status !== "number"
	)
		return fail(directory, `holds ${name}, which is no retained answer`);
	const { status, headers, body } = value as {
		readonly status: number;
		readonly headers?: Readonly<Record<string, string>>;
		readonly body?: unknown;
	};
	if (body !== undefined && typeof body !== "string")
		return fail(directory, `holds ${name}, whose body is not text`);
	return {
		status,
		...(headers !== undefined && { headers }),
		...(body !== undefined && { body }),
	};
}

function answer(directory: string, name: string): RetainedHqAnswer {
	return answerOf(directory, name, readJson(directory, name));
}

function optionalAnswer(
	directory: string,
	name: string,
): RetainedHqAnswer | undefined {
	const value = optionalJson(directory, name);
	return value === undefined ? undefined : answerOf(directory, name, value);
}

/** The base `id`'s directory under `root`, parsed, file for file. */
export function loadRetainedHqApp(
	id: string,
	root: string = join(WORKTREE, HQ_APPS),
): RetainedHqApp {
	const directory = join(root, id);
	if (!existsSync(directory))
		return fail(directory, "does not exist: no lane run retained it");
	const base = readJson(directory, "base.json") as RetainedHqApp["base"];
	if (base?.id !== id) fail(directory, `holds a base.json naming ${base?.id}`);
	const all = optionalAnswer(directory, "project-spaces.json");
	const flagged = optionalAnswer(directory, "project-spaces-flag.json");
	const mediaRows = (optionalJson(directory, "media.json") ?? []) as readonly {
		readonly path: string;
		readonly file: string;
		readonly mediaClass: MediaClass;
		readonly kind: "image" | "audio" | "video";
		readonly mimeType: string;
		readonly extension: string;
	}[];
	const fixtureRows: Record<string, RetainedHqAnswer> = {};
	for (const name of readdirSync(directory).sort()) {
		if (!name.startsWith(FIXTURE_ROWS_PREFIX) || !name.endsWith(".json"))
			continue;
		fixtureRows[name.slice(FIXTURE_ROWS_PREFIX.length, -".json".length)] =
			answer(directory, name);
	}
	const locationTypes = optionalAnswer(directory, "location-types.json");
	const locations = optionalAnswer(directory, "locations.json");
	const mediaReads = optionalJson(directory, "media-reads.json") as
		| RetainedHqApp["mediaReads"]
		| undefined;
	return {
		id,
		directory,
		base,
		source: answer(directory, "app-source.json"),
		application: answer(directory, "application.json"),
		currentVersion: answer(directory, "current-version.json"),
		...(all !== undefined &&
			flagged !== undefined && { projectSpaces: { all, flagged } }),
		media: mediaRows.map((row) => ({
			...row,
			bytes: new Uint8Array(readFileSync(join(directory, row.file))),
		})),
		lookupTables: answer(directory, "lookup-tables.json"),
		...(Object.keys(fixtureRows).length > 0 && { fixtureRows }),
		...(locationTypes !== undefined && { locationTypes }),
		...(locations !== undefined && { locations }),
		...(mediaReads !== undefined && { mediaReads }),
		expected: readJson(directory, "expected.json") as RetainedHqApp["expected"],
	};
}

/** The base `base`'s retained directory, parsed. */
export async function readRetainedHqApp(base: string): Promise<RetainedHqApp> {
	return loadRetainedHqApp(base);
}

/** The ids of every retained base under `root`, sorted. */
export function retainedBaseIds(
	root: string = join(WORKTREE, HQ_APPS),
): string[] {
	if (!existsSync(root)) return [];
	return readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
}

// ---------------------------------------------------------------------------
// A base's first reading
// ---------------------------------------------------------------------------

/**
 * A base's first reading's input: `identity: "mint"`, `claims: "full"`, `appId` the base's id,
 * and the base's own declaration where `base.json` states one.
 */
export function laneInputFor(app: RetainedHqApp): LaneReadInput {
	const files = new Map(app.media.map((one) => [one.path, one]));
	return {
		appId: app.id,
		source: app.source,
		application: app.application,
		currentVersion: app.currentVersion,
		...(app.projectSpaces !== undefined && {
			projectSpaces: app.projectSpaces,
		}),
		projectData: {
			lookupTables: app.lookupTables,
			fixtureRows: app.fixtureRows ?? {},
			...(app.locationTypes !== undefined && {
				locationTypes: app.locationTypes,
			}),
			...(app.locations !== undefined && { locations: app.locations }),
			media: (app.mediaReads ?? []).map((read) => {
				const file = files.get(read.path);
				return {
					path: read.path,
					mediaType: read.mediaType,
					multimediaId: read.multimediaId,
					status: read.status,
					...(read.status === 200 &&
						file !== undefined && {
							base64: Buffer.from(file.bytes).toString("base64"),
						}),
				};
			}),
		},
		...(app.base.declaration !== "preselected" && {
			declaration: app.base.declaration,
		}),
		identity: "mint",
		claims: "full",
	};
}

/** A declaration in words, as the message for a declaration the reading does not offer names it. */
function declarationWords(declaration: LaneDeclaration): string {
	const where =
		declaration.runsOnlyOn === null
			? "Web Apps and Android"
			: declaration.runsOnlyOn === "web-apps"
				? "Web Apps only"
				: "Android only";
	return declaration.splitDatetime
		? `${where}, with date and time questions split`
		: where;
}

/** A base whose reading is an account: the first finding, and where to look. */
function didNotComeIn(
	base: string,
	findings: readonly {
		readonly code: string;
		readonly place: Parameters<typeof placeLine>[0];
	}[],
): string {
	const [first] = findings;
	const found =
		findings.length === 1 ? "one thing" : `${findings.length} things`;
	const code = first?.code ?? "";
	const at = first === undefined ? "The app" : placeLine(first.place);
	return `The base ${base} did not come in: Nova's reader found ${found} it does not hold, the first at ${at} (${code}). A base is made only of what Nova holds, so either the reader is wrong about that place or the base holds more than it should. Look at proof/hq-apps/${base}/app-source.json there, and at the entry ${code} in lib/commcare/surface/entries/.`;
}

/** A base whose stated declaration its reading does not offer. */
function declarationNotOffered(
	base: string,
	stated: LaneDeclaration,
	offered: readonly LaneDeclaration[],
): string {
	return `The base ${base} is to be read as an app that runs on ${declarationWords(stated)}, and Nova's reading of it offers only ${offered.map(declarationWords).join("; ")}. A base's declaration is one a person could choose in the review. Either the base's content no longer allows that choice (look at what proof/matrix/bases/ authors for it) or the reader narrowed the choices wrongly.`;
}

/**
 * The base's media as the document's own assets: each file the reading holds
 * (`LaneMedia`), under the id and with the type and extension the reading
 * gives it, its bytes the retained file `media.json` names at one of its
 * paths, and the path HQ keeps each asset under on the project space it came
 * from, as the birth records it: an asset no path of which can be held takes
 * its content-hash path, and names none here.
 *
 * `media.json` holds every file HQ maps; the reading holds only those the
 * app's source references in a slot Nova reads, so a file nothing references
 * and one only a setting kept in CommCare HQ names (the Android logos) are no
 * asset of the document, and `media-reads.json` holds no read of them.
 */
function baseMedia(
	app: RetainedHqApp,
	held: LaneMedia | undefined,
): {
	readonly media: ReadonlyMap<string, UploadedMedia>;
	readonly mediaPaths: ReadonlyMap<string, string>;
} {
	const retained = new Map(app.media.map((file) => [file.path, file]));
	const media = new Map<string, UploadedMedia>();
	for (const file of held?.files ?? []) {
		const at = file.paths.find((path) => retained.has(path));
		const bytes = at === undefined ? undefined : retained.get(at)?.bytes;
		if (bytes === undefined)
			return fail(
				app.directory,
				`holds no file in media.json at ${file.paths.join(" or ")}, which Nova's reading of it holds`,
			);
		const hash = createHash("sha256").update(bytes).digest("hex");
		if (hash !== file.contentHash)
			return fail(
				app.directory,
				`holds a file in media.json at ${at} whose bytes are not the ones Nova's reading judged for that file`,
			);
		media.set(file.assetId, {
			kind: file.kind,
			mimeType: file.mimeType,
			extension: file.extension,
			bytes: Buffer.from(bytes),
		});
	}
	const mediaPaths = new Map<string, string>();
	for (const row of held?.paths ?? [])
		mediaPaths.set(row.assetId, `jr://file/${row.wirePath}`);
	return { media, mediaPaths };
}

/**
 * The edit a base states (`proof/matrix/hand/<base>/edit.ts`), as Nova makes
 * an editor's edit of D: the moves its mutations need appended over D's holds
 * (`lib/doc/identityMoves.ts::withIdentityMoves`), admitted by Nova's commit
 * gate over D and by the commit kernel's placement rule as an editor's save.
 * None where the base states no edit. Throws, naming the base, where either
 * refuses it.
 */
async function handEdit(
	app: RetainedHqApp,
	hand: string,
	document: Pick<CorpusDocument, "id" | "doc" | "lookup">,
): Promise<CorpusDocument["edit"]> {
	const path = join(hand, "edit.ts");
	if (!existsSync(path)) return undefined;
	const loaded: unknown = await import(pathToFileURL(path).href);
	const edit = (loaded as { edit?: unknown }).edit;
	if (typeof edit !== "function")
		throw new Error(
			`${path} exports no edit function, so the corpus cannot read the edit the base ${app.id} states. It exports edit(doc), which returns the mutations of the edit.`,
		);
	const from: BlueprintDoc = hydrateAdmittedDocument(document);
	const content = (edit as (doc: BlueprintDoc) => readonly Mutation[])(from);
	const recorded = readPlacementHolds(from);
	const { batch } = withIdentityMoves(from, content, { recorded });
	const verdict = mutationCommitVerdict(
		from,
		batch,
		lookupContextOf(document.lookup),
	);
	if (!verdict.ok)
		throw new Error(
			`Nova's commit gate refused the edit the base ${app.id} states (${verdict.findings
				.map((finding) => `${finding.code}: ${finding.message}`)
				.join(
					"; ",
				)}), so it is not an edit a person could make in Nova. Look at ${path} against the document the base reads as.`,
		);
	const refusal = placementChangeRefusal(
		from,
		verdict.nextDoc,
		"autosave",
		recorded,
	);
	if (refusal !== null)
		throw new Error(
			`The commit kernel refused the edit the base ${app.id} states as an editor's save ("${refusal}"); an edit changes a held placement only by a move its own change needs. Look at ${path}.`,
		);
	return {
		mutations: [...verdict.mutations],
		nextDoc: storedDocument(verdict.nextDoc),
	};
}

/**
 * One base's document: its first reading under its declaration, with the
 * edit the base states. `handRoot` holds each base's hand directory.
 */
export async function hqAuthoredDocument(
	app: RetainedHqApp,
	handRoot: string = join(WORKTREE, HQ_HAND),
): Promise<CorpusDocument> {
	const reading = await readForLane(laneInputFor(app));
	if (reading.kind === "account")
		throw new Error(didNotComeIn(app.id, reading.findings));
	if (reading.kind === "declaration-not-offered")
		throw new Error(
			declarationNotOffered(app.id, reading.stated, reading.offered),
		);
	const { media, mediaPaths } = baseMedia(app, reading.media);
	const hand = join(handRoot, app.id);
	const hqAuthored: HqAuthoredFacts = {
		identity: reading.identity,
		source: sourceBody(app),
		firstPublish: reading.firstPublish,
		declaration: reading.declaration,
		mediaPaths,
		keyedCaseIds: reading.keyedCaseIds,
		retained: app.directory,
		hand,
	};
	/* The tables D reads, with HQ's rows, as the birth leaves them in the
	 * Project: managed in CommCare HQ from the project space A is in, so the
	 * republish, the local archive and the restores carry HQ's rows. */
	const lookup =
		reading.lookup !== undefined && reading.lookup.definitions.length > 0
			? reading.lookup
			: undefined;
	const document = {
		id: app.id,
		doc: storedDocument(reading.doc),
		...(lookup !== undefined && { lookup }),
	};
	const edit = await handEdit(app, hand, document);
	return {
		...document,
		source: { kind: "hq-authored", base: app.id },
		...(media.size > 0 && { media }),
		hqAuthored,
		...(edit !== undefined && { edit }),
	};
}

/** HQ's source of the app, as its retained source answer's body holds it. */
function sourceBody(app: RetainedHqApp): Readonly<Record<string, unknown>> {
	let body: unknown;
	try {
		body = JSON.parse(app.source.body ?? "");
	} catch {
		body = undefined;
	}
	if (typeof body !== "object" || body === null || Array.isArray(body))
		return fail(app.directory, "holds app-source.json, whose body is no app");
	return body as Readonly<Record<string, unknown>>;
}

/**
 * Every retained base's document under `root`, in id order, each with its
 * hand directory under `handRoot`; none while `root` holds none.
 */
export async function hqAuthoredDocuments(
	root: string = join(WORKTREE, HQ_APPS),
	handRoot: string = join(WORKTREE, HQ_HAND),
): Promise<CorpusDocument[]> {
	const documents: CorpusDocument[] = [];
	for (const id of retainedBaseIds(root))
		documents.push(
			await hqAuthoredDocument(loadRetainedHqApp(id, root), handRoot),
		);
	return documents;
}
