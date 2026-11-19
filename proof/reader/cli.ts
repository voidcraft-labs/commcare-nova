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
 *   pointer of the entity its external key names: `named` says whether the
 *   reading holds an entity under the key at all, and `found` is what that
 *   entity holds at the pointer (`null` for nothing, and for a key that names
 *   no entity), so a fragment whose value is `null` is told apart from a key
 *   the reading does not hold.
 * - `claims`: the reading's claim log in full.
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
import { canonDocument } from "@/lib/commcare/reader/canon";
import { externalKeyText } from "@/lib/commcare/reader/identity";
import { externalIdentityMap } from "@/lib/commcare/reader/identityMap";
import { targetWireIdentity } from "@/lib/commcare/wireIdentity";
import {
	type ReadBackDifference,
	readBackDifferences,
} from "@/lib/deployment/reading/readBack";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import { ensureReferenceIndex } from "@/lib/doc/referenceIndex";
import { type BlueprintDoc, blueprintDocSchema } from "@/lib/domain";
import { remapAssetRefs } from "@/lib/domain/mediaRefs";
import type { MediaAssetId } from "@/lib/domain/multimedia";
import {
	type LaneDeclaration,
	type LaneReadInput,
	type LaneReading,
	readForLane,
} from "./laneReading";

type Mode = "read-back" | "first-read" | "claims";

interface Hold {
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
	readonly firstPublish?: readonly string[];
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
): readonly ValuedDifference[] {
	if (differences.length === 0) return [];
	const expectedShape = toPersistableDoc(expected);
	const foundShape = toPersistableDoc(found);
	return differences.map((difference) => ({
		...difference,
		expected: valueAt(expectedShape, difference.path),
		found: valueAt(foundShape, difference.path),
	}));
}

/** The record of the entity `uuid` names, from whichever of the document's maps holds it. */
function entityOf(doc: BlueprintDoc, uuid: string): unknown {
	for (const value of Object.values(doc)) {
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
		externalIdentityMap(reading.doc, targetWireIdentity(reading.identity)).map(
			(entry) => [
				externalKeyText({ kind: entry.kind, parts: entry.parts }),
				entry.uuid,
			],
		),
	);
	return holds.map(({ key, pointer }) => {
		const uuid = uuidOfKey.get(key);
		const entity = uuid === undefined ? undefined : entityOf(reading.doc, uuid);
		return {
			key,
			pointer,
			named: entity !== undefined,
			found: entity === undefined ? null : (atPointer(entity, pointer) ?? null),
		};
	});
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
			? canonDocument(expectedDoc)
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
				);
	return {
		...base,
		...(differences !== undefined && { differences }),
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
