/**
 * Every app the proof lane authored in CommCare HQ and retained
 * (`proof/hq-apps/<base>/`), read as a base's first reading is read: the
 * production reader, the Project data's verdicts and acceptance, through
 * part of production's own path (`proof/reader/laneReading.ts::readForLane`,
 * one call of `lib/deployment/reading/gather.ts::gatherFromHq`), over a peer
 * that answers native `fetch` from the base's retained answers and refuses
 * every other request.
 *
 * Contract: the tree holds every base the lane's registry names
 * (`proof/matrix/bases.json`); each base comes in; its reading's
 * declaration, the entries its claim log names and its first-publish ids
 * are the ones the lane recorded in its `expected.json`, each with a place
 * of its own but the one change that stands everywhere; each record of a
 * key of one of HQ's classes stands at that key's own pointer; every record's
 * key is one its entry names, or none; every retained
 * answer is one the reading asked for; the reading holds every placement
 * its emission derives; and the reading asks for nothing
 * the base does not hold, a mapped file's read among them (such a request
 * ends the reading, naming its path).
 *
 * Plausible failure: a reader change that stops a base coming in, or that
 * reads it under another declaration, claims it under other entries or
 * predicts other first-publish changes than the lane observed; a claim
 * recorded at a container while it names a key inside it; a claim recorded
 * under a key its entry does not name, which the lane's parity reads as a
 * class that entry does not hold; a reader that
 * stops reading an answer, or asks HQ for one at an address the lane never
 * read; and a tree no lane run wrote, which would leave this suite nothing
 * to read. The hold itself is shown over a base made of HQ's retained
 * answers for `navigation-base`, with each failure it names planted.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	laneInputOf,
	NAMED_BASES,
	RETAINED_BASES,
	retainedBase,
} from "@/__tests__/helpers/retainedHqApps";
import { placementsToHold } from "@/lib/commcare/placementHolds";
import { inventoryIndex } from "@/lib/commcare/surface/inventory";
import { placeLine } from "@/lib/publish/hqFindingCopy";
import type { RetainedHqApp } from "@/proof/corpus/hqAuthored";
import {
	type LaneDeclaration,
	type LaneReading,
	readForLane,
} from "@/proof/reader/laneReading";
import {
	CONTROL_BASE,
	claimedEntries,
	copyRetained,
	type ExpectedJson,
	expectedOf,
	writeControlBase,
	writeExpected,
} from "./retainedBaseControl";

/** A base's reading covers acceptance of the whole app; a starter app is the largest. */
const READING_MS = 180_000;

/** A retained answer no reading asked for. */
function unaskedMessage(base: string, unasked: readonly string[]): string {
	return `The base ${base} retains ${unasked.join(", ")}, and Nova's reader never asked for it. A base keeps only the answers a reading uses. Either the reader stopped reading it, or the base no longer holds what needs it.`;
}

/** Each retained answer of `base`, as `asked` names it, with the file that holds it. */
function retainedAnswers(base: RetainedHqApp): Map<string, string> {
	const answers = new Map<string, string>([
		["application", "application.json"],
		["source", "app-source.json"],
		["currentVersion", "current-version.json"],
		["lookupTables", "lookup-tables.json"],
	]);
	if (base.projectSpaces !== undefined) {
		answers.set("projectSpaces:all", "project-spaces.json");
		if (base.projectSpaces.flagged !== undefined)
			answers.set("projectSpaces:flagged", "project-spaces-flag.json");
		if (base.projectSpaces.caseListActions !== undefined)
			answers.set(
				"projectSpaces:caseListActions",
				"project-spaces-case-list-actions.json",
			);
	}
	for (const tag of Object.keys(base.fixtureRows ?? {}))
		answers.set(`fixtureRows:${tag}`, `fixture-rows-${tag}.json`);
	if (base.locationTypes !== undefined)
		answers.set("locationTypes", "location-types.json");
	if (base.locations !== undefined) answers.set("locations", "locations.json");
	for (const read of base.mediaReads ?? [])
		answers.set(
			`media:${read.path}`,
			`the read of ${read.path} in media-reads.json`,
		);
	return answers;
}

function words(declaration: LaneDeclaration): string {
	return JSON.stringify(declaration);
}

/** Where the list `found` is not `recorded`: what it lacks and what it adds, in words. */
function listChange(
	what: string,
	recorded: readonly string[],
	found: readonly string[],
): string[] {
	const lacks = recorded.filter((one) => !found.includes(one));
	const adds = found.filter((one) => !recorded.includes(one));
	const order =
		lacks.length === 0 &&
		adds.length === 0 &&
		recorded.join("\n") !== found.join("\n");
	return [
		...(lacks.length > 0
			? [`its ${what} lack ${lacks.join(", ")}, which expected.json names`]
			: []),
		...(adds.length > 0
			? [
					`its ${what} add ${adds.join(", ")}, which expected.json does not name`,
				]
			: []),
		...(order
			? [
					`its ${what} are expected.json's in another order: ${found.join(", ")}`,
				]
			: []),
	];
}

/**
 * Each record of the reading's claim log that names a key of one of HQ's
 * classes (`schema:<class>.<key>`) at any place but that key's own pointer:
 * the lane's parity looks for a claim of the key where its value sits
 * (`proof/checks/parity.py::join`), so a container claimed whole with the
 * key of a value inside it, or a key recorded at its container, meets no use
 * there. A class's undeclared-key item (`schema:<class>.<undeclared>`) names
 * no one key and is left out.
 */
function misplacedRecords(base: RetainedHqApp, reading: LaneReading): string[] {
	if (reading.kind !== "read") return [];
	const misplaced: string[] = [];
	for (const line of reading.claims.split("\n")) {
		if (line.trim() === "") continue;
		const record = JSON.parse(line) as {
			readonly artifact: string;
			readonly where: string;
			readonly key: string | null;
		};
		if (record.artifact !== "app.json" || record.key === null) continue;
		if (!record.key.startsWith("schema:")) continue;
		const dot = record.key.indexOf(".");
		const key = dot === -1 ? undefined : record.key.slice(dot + 1);
		if (key === undefined || key.startsWith("<")) continue;
		const last = (record.where.split("/").pop() ?? "")
			.replaceAll("~1", "/")
			.replaceAll("~0", "~");
		if (last !== key)
			misplaced.push(
				`The base ${base.id}'s claim log records ${record.key} at ${record.where}, where that key's value does not sit. Record the claim at the key's own pointer, where the lane's parity looks for it.`,
			);
	}
	return misplaced;
}

/**
 * Each record of the reading's claim log under a surface key its entry does not name: the
 * lane's parity joins a use of a key to a record naming an entry that holds the key
 * (`proof/checks/parity.py::join`), so such a record says the place is of a class its entry
 * is not. A record names a key its entry names, or none.
 */
function unnamedKeys(base: RetainedHqApp, claims: string): string[] {
	const index = inventoryIndex();
	const unnamed: string[] = [];
	for (const line of claims.split("\n")) {
		if (line.trim() === "") continue;
		const record = JSON.parse(line) as {
			readonly artifact: string;
			readonly where: string;
			readonly key: string | null;
			readonly entry: string;
		};
		if (record.key === null) continue;
		if (index.entry(record.entry)?.surfaceKeys.includes(record.key) === true)
			continue;
		unnamed.push(
			`The base ${base.id}'s claim log records ${record.entry} under ${record.key} at ${record.artifact} ${record.where}, and that entry does not name the key. Record the claim under the entry that reads that key, or give the entry the key where it is what reads it.`,
		);
	}
	return unnamed;
}

/**
 * What `reading` of `base` says otherwise than the lane recorded: each a
 * sentence naming the base; none where it comes in as recorded and asked
 * for every answer it retains.
 */
function discrepancies(base: RetainedHqApp, reading: LaneReading): string[] {
	if (reading.kind === "account")
		return [
			`The base ${base.id} did not come in: Nova's reader found ${reading.findings
				.map((finding) => `${finding.code} at ${placeLine(finding.place)}`)
				.join(
					"; ",
				)}. A base is made only of what Nova holds, so either the reader is wrong about that place or the base holds more than it should. Look at proof/hq-apps/${base.id}/app-source.json there.`,
		];
	if (reading.kind === "declaration-not-offered")
		return [
			`The base ${base.id} is to be read under ${words(reading.stated)}, and its reading offers only ${reading.offered.map(words).join(", ")}.`,
		];
	const expected = base.expected;
	const changes = [
		...(words(reading.declaration) === words(expected.declaration)
			? []
			: [
					`it reads under ${words(reading.declaration)}, and expected.json records ${words(expected.declaration)}`,
				]),
		...listChange(
			"claimed entries",
			expected.claimed,
			claimedEntries(reading.claims),
		),
		...listChange(
			"first-publish ids",
			expected.firstPublish,
			reading.firstPublish,
		),
	];
	const found =
		changes.length === 0
			? []
			: [
					`Nova's reading of the base ${base.id} is not the one the lane recorded in proof/hq-apps/${base.id}/expected.json: ${changes.join("; ")}. Where the reader changed on purpose, the lane's next run writes the new expected.json (python3 -m proof.matrix.adopt); otherwise the reader reads this app otherwise than it did.`,
				];
	const unasked = [...retainedAnswers(base)]
		.filter(([name]) => !reading.asked.includes(name))
		.map(([, file]) => file);
	return unasked.length === 0
		? found
		: [...found, unaskedMessage(base.id, unasked)];
}

/**
 * Each placement Nova's emission of `reading`'s document derives that the document does not
 * hold: a sentence naming it, none where the reading holds every one. A reading holds every
 * placement CommCare HQ keeps a case change, a query repeat or a menu's kind at
 * (`assemble.ts`'s `unheld-placements-are-held`), so the first publish records none into the
 * document and a read of the app it left gives the document back (proof 6's `read(A) = D`).
 */
function unheldPlacements(base: RetainedHqApp, reading: LaneReading): string[] {
	if (reading.kind !== "read") return [];
	return placementsToHold(reading.doc).map(
		(hold) =>
			`Nova's reading of the base ${base.id} holds no placement where its emission places ${JSON.stringify(hold)}, so the first publish would record one the reading did not read. Look at the reader stage that reads that case change, query repeat or menu.`,
	);
}

/**
 * Each first-publish change of the reading that stands nowhere: the emission writes each with the
 * places it stands at (`first-publish.json`), and the proof lane's judge holds a difference to a
 * change only at its places (`proof/checks/changes.py`), so a change but the one that stands
 * everywhere with no place could never be seen. `firstPublishChangePlaces` throws for one; this
 * names a list that parts from the ids the reading predicts.
 */
function unplacedChanges(base: RetainedHqApp, reading: LaneReading): string[] {
	if (reading.kind !== "read") return [];
	const placed = reading.firstPublishPlaces.map(({ id }) => id);
	return [
		...(placed.join("\n") === reading.firstPublish.join("\n")
			? []
			: [
					`The base ${base.id}'s first-publish places name ${placed.join(", ")}, and its reading predicts ${reading.firstPublish.join(", ")}. Look at lib/deployment/reading/firstPublishChanges.ts::firstPublishChangePlaces.`,
				]),
		...reading.firstPublishPlaces
			.filter(
				({ id, places }) =>
					places.length === 0 ||
					(id !== "forms-and-settings-rewritten" && places.includes("")),
			)
			.map(
				({ id }) =>
					`The base ${base.id}'s reading predicts ${id} and gives it no place of its own. Look at its entry's at in lib/deployment/reading/firstPublishChanges.ts.`,
			),
	];
}

async function readBase(base: RetainedHqApp): Promise<LaneReading> {
	return readForLane(laneInputOf(base));
}

describe("the apps CommCare HQ made that the proof lane retained", () => {
	it("holds every base the lane's registry names", () => {
		expect(
			RETAINED_BASES,
			"proof/hq-apps/ is to hold one directory a base of proof/matrix/bases.json; a lane run writes it (proof/matrix/test_retained.py) and python3 -m proof.matrix.adopt copies it in",
		).toEqual(NAMED_BASES);
	});

	for (const id of RETAINED_BASES)
		it(
			`reads ${id} as the lane recorded, asking for every answer it retains`,
			async () => {
				const base = retainedBase(id);
				const reading = await readBase(base);
				expect([
					...discrepancies(base, reading),
					...unheldPlacements(base, reading),
					...unplacedChanges(base, reading),
					...misplacedRecords(base, reading),
					...(reading.kind === "read" ? unnamedKeys(base, reading.claims) : []),
				]).toEqual([]);
			},
			READING_MS,
		);
});

describe("the hold, over a base made of HQ's retained answers for navigation-base", () => {
	let root: string;
	let recorded: ExpectedJson;

	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "bases-retained-"));
		const placeholder: ExpectedJson = {
			reads: true,
			declaration: { runsOnlyOn: null, splitDatetime: false },
			claimed: [],
			firstPublish: [],
		};
		const directory = await writeControlBase(root, placeholder);
		// What the lane writes: the first reading's facts, read with claim counts.
		const control = retainedBase(CONTROL_BASE, root);
		recorded = expectedOf(
			await readForLane({ ...laneInputOf(control), claims: "counts" }),
		);
		await writeExpected(directory, recorded);
	}, READING_MS);

	afterAll(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it(
		"finds nothing where the base comes in as expected.json records it",
		async () => {
			const base = retainedBase(CONTROL_BASE, root);
			expect(recorded.claimed.length).toBeGreaterThan(0);
			expect(discrepancies(base, await readBase(base))).toEqual([]);
		},
		READING_MS,
	);

	it(
		"names a declaration, a claimed entry and a first-publish id the reading does not give",
		async () => {
			const base = retainedBase(CONTROL_BASE, root);
			const [dropped, ...kept] = recorded.claimed;
			const planted: RetainedHqApp = {
				...base,
				expected: {
					...recorded,
					declaration: { runsOnlyOn: "android", splitDatetime: false },
					claimed: kept,
					firstPublish: [...recorded.firstPublish, "web-apps-turned-on"],
				},
			};
			const [found, ...more] = discrepancies(planted, await readBase(base));
			expect(more).toEqual([]);
			expect(found).toContain(
				`it reads under ${words(recorded.declaration)}, and expected.json records {"runsOnlyOn":"android","splitDatetime":false}`,
			);
			expect(found).toContain(
				`its claimed entries add ${dropped}, which expected.json does not name`,
			);
			expect(found).toContain(
				"its first-publish ids lack web-apps-turned-on, which expected.json names",
			);
		},
		READING_MS,
	);

	it(
		"names a record whose key its entry does not name, and passes the base's own records",
		async () => {
			const base = retainedBase(CONTROL_BASE, root);
			const reading = await readBase(base);
			if (reading.kind !== "read")
				throw new Error("The control base did not read.");
			expect(unnamedKeys(base, reading.claims)).toEqual([]);
			const planted = `${reading.claims}${JSON.stringify({
				artifact: "form:0.0",
				where: "/h:html/h:head[1]/model[1]/bind[1]/@calculate",
				key: "xform:model/bind@calculate",
				entry: "application-and-settings/doc-type-application",
				standing: "held",
			})}\n`;
			expect(unnamedKeys(base, planted)).toEqual([
				`The base ${CONTROL_BASE}'s claim log records application-and-settings/doc-type-application under xform:model/bind@calculate at form:0.0 /h:html/h:head[1]/model[1]/bind[1]/@calculate, and that entry does not name the key. Record the claim under the entry that reads that key, or give the entry the key where it is what reads it.`,
			]);
		},
		READING_MS,
	);

	it(
		"names a retained answer the reading never asked for",
		async () => {
			const unasked = await mkdtemp(join(tmpdir(), "bases-retained-unasked-"));
			try {
				const directory = await writeControlBase(unasked, recorded);
				await copyRetained(
					directory,
					"lookups/fixture-rows-plain.json",
					"fixture-rows-planted.json",
				);
				const base = retainedBase(CONTROL_BASE, unasked);
				expect(discrepancies(base, await readBase(base))).toEqual([
					unaskedMessage(CONTROL_BASE, ["fixture-rows-planted.json"]),
				]);
			} finally {
				await rm(unasked, { recursive: true, force: true });
			}
		},
		READING_MS,
	);

	it(
		"ends a reading that asks for an answer the base does not hold",
		async () => {
			const moved = await mkdtemp(join(tmpdir(), "bases-retained-moved-"));
			try {
				const directory = await writeControlBase(moved, recorded);
				// HQ's version read after a save: the bracket does not close, and production reads
				// the app again, which the base holds no second answer for.
				await copyRetained(
					directory,
					"reading/current-version-after-save.json",
					"current-version.json",
				);
				const base = retainedBase(CONTROL_BASE, moved);
				await expect(readBase(base)).rejects.toThrow(
					`while it read ${CONTROL_BASE}, and the lane holds no answer for that request.`,
				);
			} finally {
				await rm(moved, { recursive: true, force: true });
			}
		},
		READING_MS,
	);
});
