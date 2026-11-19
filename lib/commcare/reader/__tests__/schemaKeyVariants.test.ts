/**
 * The reader's totality over every app the proof lane retained
 * (`proof/hq-apps/<base>/`): a key no manifest entry names, set in every
 * object of the base's source that HQ's model wraps as a document of its own
 * (an object carrying `doc_type`, the root included), never reads past.
 *
 * Contract: no planted key is held. Each is reported `unrecognized` at its
 * place (the finding names the key, or the key its object sits at, where
 * the reader refuses the object for it); or a claim at the key's own pointer
 * takes it at a standing that holds no Nova content (kept, inert, not yet,
 * never, fix in HQ), where an entry takes every unknown key of its object;
 * or it sits inside a value the reading claims whole at such a standing,
 * which Nova does not read into the document. A key held, under any entry,
 * or met by no finding and no claim, is read past. A base's keys are planted
 * at once, one name a place, and read as a first reading reads them
 * (`proof/reader/laneReading.ts::readForLane`).
 *
 * Plausible failure: a reader stage that walks an object of HQ's and admits
 * a key it does not know, so an app whose source holds a value Nova cannot
 * hold comes in as though it held none. The hold itself is shown over a base
 * made of HQ's retained answers for `navigation-base`.
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
import type { RetainedHqApp } from "@/proof/corpus/hqAuthored";
import { readForLane } from "@/proof/reader/laneReading";
import { CONTROL_BASE, writeControlBase } from "./retainedBaseControl";

const READING_MS = 180_000;
const PLANTED = "nova_planted_key_";
/** At most this many keys go into one reading, below the findings one account lists. */
const KEYS_A_READING = 1000;
const HOLDING = new Set(["held"]);

interface Planted {
	/** The JSON pointer of the object the key is set in. */
	readonly object: string;
	readonly key: string;
}

function token(key: string): string {
	return key.replaceAll("~", "~0").replaceAll("/", "~1");
}

/** The pointer of every object of `body` that carries `doc_type`, in document order. */
function documentObjects(body: unknown): string[] {
	const found: string[] = [];
	const walk = (value: unknown, pointer: string) => {
		if (Array.isArray(value)) {
			value.forEach((item, index) => {
				walk(item, `${pointer}/${index}`);
			});
			return;
		}
		if (value === null || typeof value !== "object") return;
		const object = value as Record<string, unknown>;
		if (typeof object.doc_type === "string") found.push(pointer);
		for (const [key, child] of Object.entries(object))
			if (key !== "_attachments") walk(child, `${pointer}/${token(key)}`);
	};
	walk(body, "");
	return found;
}

function at(body: unknown, pointer: string): Record<string, unknown> {
	let value = body;
	for (const part of pointer.split("/").slice(1)) {
		const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
		value = (value as Record<string, unknown>)[key];
	}
	return value as Record<string, unknown>;
}

/** `body` with one key of its own planted in each of `objects`. */
function planted(
	body: unknown,
	objects: readonly string[],
	first: number,
): { readonly body: unknown; readonly keys: readonly Planted[] } {
	const copy = structuredClone(body);
	const keys = objects.map((object, index) => {
		const key = `${PLANTED}${first + index}`;
		at(copy, object)[key] = "planted";
		return { object, key };
	});
	return { body: copy, keys };
}

/** Each planted key the reading of `base` with `keys` set reads past, as a sentence. */
async function readPast(
	base: RetainedHqApp,
	body: unknown,
	keys: readonly Planted[],
): Promise<string[]> {
	const reading = await readForLane({
		...laneInputOf(base),
		source: { ...base.source, body: JSON.stringify(body) },
	});
	const reported = new Set<string>();
	if (reading.kind === "account")
		for (const finding of reading.findings) {
			const name = finding.detail?.name;
			if (finding.code === "unrecognized" && typeof name === "string")
				reported.add(name.slice(name.lastIndexOf(".") + 1));
		}
	const notHolding = new Set(
		reading.claims
			.split("\n")
			.filter((line) => line !== "")
			.map(
				(line) =>
					JSON.parse(line) as {
						readonly artifact: string;
						readonly where: string;
						readonly standing: string;
					},
			)
			.filter(
				(record) =>
					record.artifact === "app.json" && !HOLDING.has(record.standing),
			)
			.map((record) => record.where),
	);
	const past: string[] = [];
	for (const { object, key } of keys) {
		const parts = `${object}/${key}`.split("/");
		const container = object.slice(object.lastIndexOf("/") + 1);
		if (reported.has(key) || (container !== "" && reported.has(container)))
			continue;
		if (
			parts.some((_, end) => notHolding.has(parts.slice(0, end + 1).join("/")))
		)
			continue;
		past.push(
			`${base.id}: a key no entry names, set at ${object || "the root"} of its source, is read past (${reading.kind}): no unrecognized finding names it, and no claim at it or around it holds nothing`,
		);
	}
	return past;
}

/** Every planted key of `base` that a reading reads past, its objects read in batches. */
async function keysReadPast(base: RetainedHqApp): Promise<string[]> {
	const body = JSON.parse(base.source.body ?? "null") as unknown;
	const objects = documentObjects(body);
	expect(
		objects.length,
		`${base.id}'s source holds a document`,
	).toBeGreaterThan(0);
	const past: string[] = [];
	for (let first = 0; first < objects.length; first += KEYS_A_READING) {
		const batch = planted(
			body,
			objects.slice(first, first + KEYS_A_READING),
			first,
		);
		past.push(...(await readPast(base, batch.body, batch.keys)));
	}
	return past;
}

describe("a key no entry names, in each object of a retained base's source", () => {
	it("is held over every base the lane's registry names", () => {
		expect(
			RETAINED_BASES,
			"proof/hq-apps/ is to hold one directory a base of proof/matrix/bases.json; a lane run writes it (proof/matrix/test_retained.py) and python3 -m proof.matrix.adopt copies it in",
		).toEqual(NAMED_BASES);
	});

	for (const id of RETAINED_BASES)
		it(
			`reads as unrecognized wherever it is set in ${id}`,
			async () => {
				expect(await keysReadPast(retainedBase(id))).toEqual([]);
			},
			READING_MS,
		);
});

describe("the hold, over a base made of HQ's retained answers for navigation-base", () => {
	let root: string;

	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "schema-key-variants-"));
		await writeControlBase(root, {
			reads: true,
			declaration: { runsOnlyOn: null, splitDatetime: false },
			claimed: [],
			firstPublish: [],
		});
	});

	afterAll(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it(
		"finds a key reported or claimed at a standing that holds nothing wherever the reader keeps its account",
		async () => {
			const base = retainedBase(CONTROL_BASE, root);
			const body = JSON.parse(base.source.body ?? "null") as unknown;
			// The app, a menu, a form, its actions, a case list and its column, a tile group and the
			// case references: an unknown key is unrecognized, or refused under its object's entry.
			const objects = [
				"",
				"/modules/0",
				"/modules/0/forms/0",
				"/modules/0/forms/0/actions",
				"/modules/0/forms/0/actions/update_case",
				"/modules/0/forms/0/case_references_data",
				"/modules/0/case_details",
				"/modules/0/case_details/short",
				"/modules/0/case_details/short/columns/0",
				"/modules/0/case_details/short/case_tile_group",
			];
			expect(
				objects.every((object) => documentObjects(body).includes(object)),
			).toBe(true);
			const { body: set, keys } = planted(body, objects, 0);
			expect(await readPast(base, set, keys)).toEqual([]);
		},
		READING_MS,
	);

	it(
		"finds a key reported or claimed at a standing that holds nothing in every object of HQ's the base holds",
		async () => {
			const base = retainedBase(CONTROL_BASE, root);
			const body = JSON.parse(base.source.body ?? "null") as unknown;
			// Every object a held claim takes whole with its key among them: an inactive action,
			// an action's condition and name, an update map's entry, a search the menu does not
			// offer. A key HQ's model keeps as a dynamic property is never held under that claim.
			const objects = documentObjects(body);
			expect(objects).toContain("/modules/0/forms/0/actions/open_case");
			expect(objects).toContain("/modules/0/search_config");
			const { body: set, keys } = planted(body, objects, 0);
			expect(await readPast(base, set, keys)).toEqual([]);
		},
		READING_MS,
	);

	it(
		"names a key no reading of the planted source met",
		async () => {
			const base = retainedBase(CONTROL_BASE, root);
			const body = JSON.parse(base.source.body ?? "null") as unknown;
			// A key named as planted and never set is met by nothing, which the hold must name.
			const past = await readPast(base, body, [
				{ object: "/modules/0", key: `${PLANTED}never-set` },
			]);
			expect(past).toEqual([
				`${CONTROL_BASE}: a key no entry names, set at /modules/0 of its source, is read past (read): no unrecognized finding names it, and no claim at it or around it holds nothing`,
			]);
		},
		READING_MS,
	);
});
