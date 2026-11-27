/**
 * The reader bundle's entry: `node reader.mjs <requests> <answers>`.
 *
 * It reads one JSON document from `<requests>`,
 * `{ "requests": [{ "id", "mode", "input", "expected"?, "canon"?, "holds"? }] }`,
 * reads each request's app through `readForLane`, and writes
 * `{ "answers": [{ "id", "kind", "differences"?, "findings"?, "claims",
 * "declaration"?, "offered"?, "firstPublish"?, "held"?, "asked" }] }` to
 * `<answers>`. Standard output is not the answer channel: Nova's logger and
 * the readers under it write there, so it is the bundle's log.
 *
 * Every answer, whatever the reading's kind, holds the reading's claims as
 * the input's `claims` option asks for them: the JSON of the count of claims
 * by entry id under `counts`, the claim log under `full`.
 *
 * - `read-back`: a read back of a corpus document (`identity: "match"`).
 *   With `expected`, the answer holds `readBackDifferences(expected, { doc,
 *   choices })`, the choices being the declarations the reading offers, so
 *   `expected` loses its own declaration and the comparison requires it among
 *   them. A file is the asset the document's media name at the path it was
 *   sent at, or, where the input carries what HQ served
 *   (`LaneReadInput.servedMedia`), the asset whose bytes HQ served there:
 *   where two of its assets are one file (sent at one path, or of the same
 *   bytes), `expected` names the one the reading names
 *   (`LaneReading.sameFile`), since one Project holds one asset a content
 *   and HQ one file a path.
 * - `first-read`: a base's first reading (`identity: "mint"`), whose answer
 *   holds the declaration it was read under and that declaration's
 *   first-publish ids. With `expected`, the two documents are compared whole
 *   (`choices: null`). With `holds`, each fragment's value is found at its
 *   pointer of the entity its external key names, or the document itself under
 *   the key `app` (a row may also give it as the list `["app"]`, the spelling
 *   of every other key): `named` says whether the
 *   reading holds an entity under the key at all, and `found` is what that
 *   entity holds at the pointer (`null` for nothing, and for a key that names
 *   no entity), so a fragment whose value is `null` is told apart from a key
 *   the reading does not hold.
 * - `claims`: the reading's claim log in full.
 *
 * A first read may request `emitApplication` for a native witness. This returns the production
 * update JSON under the adopted HQ identities for a source with no media to upload.
 *
 * Each difference carries the value `expected` holds at its path and the
 * value the reading gave there (`expected`, `found`, `null` for none), which
 * the judge keeps as its evidence.
 *
 * `canon: true` puts `expected` in its canonical form first
 * (`lib/commcare/reader/canon.ts::canonDocument`). The entry draws nothing,
 * opens no socket and reads no file but its first argument. A request it
 * cannot answer (a request with no retained answer among them) ends the
 * process with status 1 and the reason on standard error, and no answers
 * file is written.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { expandDoc } from "@/lib/commcare/expander";
import { parseHqAppSource } from "@/lib/commcare/hq/appSource";
import { lookupWireNaming } from "@/lib/commcare/lookup/naming";
import { canonDocument } from "@/lib/commcare/reader/canon";
import { externalKeyText } from "@/lib/commcare/reader/identity";
import { externalIdentityMap } from "@/lib/commcare/reader/identityMap";
import { targetWireIdentity } from "@/lib/commcare/wireIdentity";
import { keyedCaseIdPrefixesFor } from "@/lib/deployment/adoption";
import { planFromDocuments } from "@/lib/deployment/hqChanges/plan";
import { hqImportApplication } from "@/lib/deployment/importApplication";
import {
	type ReadBackDifference,
	readBackDifferences,
} from "@/lib/deployment/reading/readBack";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import { ensureReferenceIndex } from "@/lib/doc/referenceIndex";
import {
	type BlueprintDoc,
	blueprintDocSchema,
	makeTranslationUnitId,
} from "@/lib/domain";
import { remapAssetRefs } from "@/lib/domain/mediaRefs";
import type { MediaAssetId } from "@/lib/domain/multimedia";
import {
	type LaneDeclaration,
	type LaneReadInput,
	type LaneReading,
	readForLane,
} from "./laneReading";
import { LANE_TARGET } from "./retainedPeer";

type Mode = "read-back" | "first-read" | "claims";

interface Hold {
	/** A field translation addressed by the same external field key as its source. */
	readonly translation?: { readonly language: string; readonly slot: string };
	readonly key: string;
	readonly pointer: string;
	readonly value: unknown;
}

interface Request {
	readonly id: string;
	readonly mode: Mode;
	readonly input: LaneReadInput;
	/** A stored document (`document.json`'s `doc`). */
	readonly expected?: unknown;
	readonly canon?: boolean;
	/** Review the changed reading over the previously adopted, unchanged app supplied as expected. */
	readonly reviewChanges?: boolean;
	readonly emitApplication?: {
		readonly appId: string;
		readonly domain: string;
	};
	readonly holds?: readonly Hold[];
}

interface Answer {
	readonly id: string;
	readonly kind: LaneReading["kind"];
	readonly differences?: readonly ValuedDifference[];
	readonly findings?: readonly unknown[];
	readonly claims: string;
	readonly declaration?: LaneDeclaration;
	readonly offered?: readonly LaneDeclaration[];
	readonly review?: ReturnType<typeof reviewChanges>;
	readonly application?: ReturnType<typeof expandDoc>;
	/** Where the owner-rule answers a first reading states are not one for each question it asks:
	 *  those answers, and the level of each question. */
	readonly ownerRuleChoices?: Readonly<Record<string, string>>;
	readonly ownerRuleLevels?: readonly string[];
	readonly firstPublish?: readonly string[];
	readonly firstPublishPlaces?: Extract<
		LaneReading,
		{ kind: "read" }
	>["firstPublishPlaces"];
	readonly held?: readonly {
		readonly key: string;
		readonly pointer: string;
		/** Whether the reading holds an entity under `key`. */
		readonly named: boolean;
		/** What that entity holds at `pointer`: `null` for nothing, and where `named` is false. */
		readonly found: unknown;
	}[];
	readonly asked: readonly string[];
}

const USAGE =
	"The reader bundle takes two paths: node reader.mjs <requests> <answers>. The first holds { requests: [...] } as proof/reader/cli.ts describes; the answers are written to the second.";

const MODE_OF_IDENTITY: Readonly<
	Record<Mode, LaneReadInput["identity"] | null>
> = { "read-back": "match", "first-read": "mint", claims: null };

function hydrated(
	stored: unknown,
	sameFile: ReadonlyMap<string, string> = new Map(),
): BlueprintDoc {
	const doc = hydratePersistedBlueprint(
		remapAssetRefs(
			blueprintDocSchema.parse(stored),
			sameFile as ReadonlyMap<MediaAssetId, MediaAssetId>,
		),
	);
	ensureReferenceIndex(doc);
	return doc;
}

/**
 * The value at `path` of a document's persisted shape, for a difference's
 * evidence: `null` where the document holds none there.
 */
function valueAt(persisted: unknown, path: readonly string[]): unknown {
	let current = persisted;
	for (const step of path) {
		if (typeof current !== "object" || current === null) return null;
		if (!Object.hasOwn(current, step)) return null;
		current = (current as Record<string, unknown>)[step];
	}
	return current ?? null;
}

/** The value at JSON pointer `pointer` of `value`, or undefined where it holds none. */
function atPointer(value: unknown, pointer: string): unknown {
	if (pointer === "") return value;
	let current = value;
	for (const raw of pointer.split("/").slice(1)) {
		const step = raw.replaceAll("~1", "/").replaceAll("~0", "~");
		if (typeof current !== "object" || current === null) return undefined;
		if (!Object.hasOwn(current, step)) return undefined;
		current = (current as Record<string, unknown>)[step];
	}
	return current;
}

/** A difference of a read back, with the value each document holds at its path. */
interface ValuedDifference extends ReadBackDifference {
	/** What the expected document holds there, `null` for nothing. */
	readonly expected: unknown;
	/** What the reading gave there, `null` for nothing. */
	readonly found: unknown;
}

/** Each difference with the values the two documents hold at its path: the evidence a judge keeps. */
function withValues(
	expected: BlueprintDoc,
	found: BlueprintDoc,
	differences: readonly ReadBackDifference[],
	offered: readonly LaneDeclaration[] | null,
): readonly ValuedDifference[] {
	if (differences.length === 0) return [];
	const expectedShape = toPersistableDoc(expected);
	const foundShape = toPersistableDoc(found);
	return differences.map((difference) => ({
		...difference,
		expected: valueAt(expectedShape, difference.path),
		found:
			offered !== null &&
			difference.path.length === 2 &&
			difference.path[0] === "appSettings" &&
			difference.path[1] === "runsOnlyOn"
				? offered
				: valueAt(foundShape, difference.path),
	}));
}

/** The record of the entity `uuid` names, from whichever of the document's maps holds it. */
function entityOf(doc: BlueprintDoc, uuid: string): unknown {
	for (const value of [
		...Object.values(doc),
		doc.appSettings.installationProfiles,
	]) {
		if (
			typeof value === "object" &&
			value !== null &&
			!Array.isArray(value) &&
			Object.hasOwn(value, uuid)
		)
			return (value as Record<string, unknown>)[uuid];
	}
	return undefined;
}

function heldOf(
	reading: Extract<LaneReading, { kind: "read" }>,
	holds: readonly Hold[],
): Answer["held"] {
	const uuidOfKey = new Map(
		externalIdentityMap(
			reading.doc,
			targetWireIdentity(
				reading.identity,
				reading.columnWords,
				reading.projectSearches,
				reading.installationProfiles,
			),
			reading.lookup && lookupWireNaming(reading.lookup.definitions),
		).map((entry) => [
			externalKeyText({ kind: entry.kind, parts: entry.parts }),
			entry.uuid,
		]),
	);
	return holds.map(({ key, pointer, translation }) => {
		const uuid = uuidOfKey.get(key);
		const entity =
			key === "app" || key === JSON.stringify(["app"])
				? reading.doc
				: uuid === undefined
					? undefined
					: translation === undefined
						? entityOf(reading.doc, uuid)
						: reading.doc.localization?.translations[translation.language]?.[
								makeTranslationUnitId("field", uuid, translation.slot)
							];
		return {
			key,
			pointer,
			named: entity !== undefined,
			found: entity === undefined ? null : (atPointer(entity, pointer) ?? null),
		};
	});
}

/** Apply the production HQ change planner to an adoption with no unpublished edits, then emit
 * the resulting app under its adopted IDs so HQ can read back the actual wire. */
function reviewChanges(
	previous: BlueprintDoc | undefined,
	reading: Extract<LaneReading, { kind: "read" }>,
) {
	if (previous === undefined)
		throw new Error("A change review needs the previous adopted document.");
	const plan = planFromDocuments({
		ref: previous,
		now: previous,
		base: previous,
		theirs: reading.doc,
		renamesSince: [],
	});
	if (plan.kind !== "changes") return plan;
	return {
		kind: plan.kind,
		target: toPersistableDoc(plan.target),
		application: expandDoc(plan.target, {
			identity: targetWireIdentity(reading.identity),
			lookupNaming:
				reading.lookup && lookupWireNaming(reading.lookup.definitions),
		}),
	};
}

function firstPublishApplication(
	reading: Extract<LaneReading, { kind: "read" }>,
	input: LaneReadInput,
	target: NonNullable<Request["emitApplication"]>,
) {
	if (reading.media?.files.length)
		throw new Error(
			"An application-only witness needs a source with no media to upload.",
		);
	const raw = JSON.parse(input.source.body ?? "null");
	const parsed = parseHqAppSource(raw, { admit: "any" });
	if (parsed.kind !== "source")
		throw new Error(
			"A first publish needs the source of the HQ application it updates.",
		);
	return hqImportApplication({
		prepared: {
			doc: reading.doc,
			assets: new Map(),
			attachmentTarget: null,
			lookupNaming:
				reading.lookup && lookupWireNaming(reading.lookup.definitions),
		},
		target: { ...LANE_TARGET, domain: target.domain },
		compatibility: { advisories: [] },
		update: { appId: target.appId, source: parsed.source },
		identity: targetWireIdentity(
			reading.identity,
			reading.columnWords,
			reading.projectSearches,
			reading.installationProfiles,
		),
		languageNames: "target",
		seeds: "target",
		keyedCaseIdPrefixes: keyedCaseIdPrefixesFor(
			reading.doc,
			reading.keyedCaseIds,
		),
	}).application;
}

async function answer(request: Request): Promise<Answer> {
	const identity = MODE_OF_IDENTITY[request.mode];
	if (identity === undefined)
		throw new Error(
			`The request ${request.id} asks for the mode ${String(request.mode)}; the reader bundle answers read-back, first-read and claims.`,
		);
	if (identity !== null && request.input.identity !== identity)
		throw new Error(
			`The request ${request.id} asks for a ${request.mode} with identity ${request.input.identity}; a ${request.mode} is made with identity ${identity}.`,
		);
	const input: LaneReadInput =
		request.mode === "claims"
			? { ...request.input, claims: "full" }
			: request.input;
	const reading = await readForLane(input);
	const base = {
		id: request.id,
		kind: reading.kind,
		asked: reading.asked,
		claims: reading.claims,
	};
	if (request.mode === "claims") return base;
	if (reading.kind === "account")
		return { ...base, findings: reading.findings };
	if (reading.kind === "declaration-not-offered")
		return { ...base, declaration: reading.stated, offered: reading.offered };
	if (reading.kind === "owner-rules-not-answered")
		return {
			...base,
			ownerRuleChoices: reading.stated,
			ownerRuleLevels: reading.askedLevels,
		};
	// Where two assets of the document are one file, the expected document names the one the read
	// back names it by.
	const expectedDoc =
		request.expected === undefined
			? undefined
			: hydrated(
					request.expected,
					request.mode === "read-back" ? reading.sameFile : undefined,
				);
	const expected =
		expectedDoc !== undefined && request.canon === true
			? canonDocument(
					expectedDoc,
					undefined,
					request.mode === "read-back"
						? expectedDoc.localization?.sourceLanguage
						: undefined,
				)
			: expectedDoc;
	const differences =
		expected === undefined
			? undefined
			: withValues(
					expected,
					reading.doc,
					readBackDifferences(expected, {
						doc: reading.doc,
						choices:
							request.mode === "read-back"
								? reading.offered.map((choice) => ({
										runsOnlyOn: choice.runsOnlyOn ?? undefined,
									}))
								: null,
					}),
					request.mode === "read-back" ? reading.offered : null,
				);
	return {
		...base,
		...(differences !== undefined && { differences }),
		...(request.mode === "first-read" &&
			request.emitApplication && {
				application: firstPublishApplication(
					reading,
					input,
					request.emitApplication,
				),
				firstPublishPlaces: reading.firstPublishPlaces,
			}),
		...(request.reviewChanges && {
			review: reviewChanges(expectedDoc, reading),
		}),
		...(request.mode === "first-read" && {
			declaration: reading.declaration,
			firstPublish: reading.firstPublish,
		}),
		...(request.holds !== undefined && {
			held: heldOf(reading, request.holds),
		}),
	};
}

async function main(argv: readonly string[]): Promise<void> {
	const [requestsPath, answersPath, ...rest] = argv;
	if (
		requestsPath === undefined ||
		answersPath === undefined ||
		rest.length > 0
	)
		throw new Error(USAGE);
	const { requests } = JSON.parse(readFileSync(requestsPath, "utf8")) as {
		readonly requests: readonly Request[];
	};
	if (!Array.isArray(requests)) throw new Error(USAGE);
	const answers: Answer[] = [];
	for (const request of requests) answers.push(await answer(request));
	writeFileSync(answersPath, `${JSON.stringify({ answers }, null, "\t")}\n`);
}

try {
	await main(process.argv.slice(2));
} catch (error) {
	process.stderr.write(
		`${error instanceof Error ? error.message : String(error)}\n`,
	);
	process.exitCode = 1;
}
