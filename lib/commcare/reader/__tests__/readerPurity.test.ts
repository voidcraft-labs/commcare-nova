/**
 * The reader is a pure function of its input.
 *
 * Contract: two readings of one input object give deeply equal outcomes: the
 * same findings in the same order, the same claim log record for record, the
 * same defects, the same work, and, where a document reads, the same draft. A
 * reading changes nothing it was given: every value of its input is deeply
 * equal, after it, to a structured clone taken before it, and no object of it
 * is frozen that was not. An input frozen whole reads as it reads unfrozen.
 * These hold over Nova's own export and over apps CommCare HQ's own pages
 * made (`proof/hq-apps/`). Two sources of one app read one after the other in
 * one request, as a review of changes made in CommCare HQ reads its baseline
 * and the app now, sharing the request's held emissions (`heldExpansions.ts`)
 * and the process's held parses (`xmlParse.ts::heldXmlParse`,
 * `syntaxRead.ts`), each give the outcome a reading of it alone gives, and
 * leave every held parse as a fresh parse of its text. Plausible failures:
 * state a reading keeps on what it was given (the keys an identity resolver
 * has claimed, a mark or a memo on a source object), so a second reading of
 * one input finds its keys taken and reads to an account; state a module keeps
 * between readings; an order that follows a `Map`'s insertion history rather
 * than the source; a held parse or emission keyed too loosely, so a reading of
 * one source is answered with what was held for the other and the two compare
 * as one app; or a reader that writes into a parse it shares.
 */

import { describe, expect, it } from "vitest";
import { retainedBase } from "@/__tests__/helpers/retainedHqApps";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { proseTemplateText } from "@/lib/domain/prose";
import { localAppStringTable } from "../../appStrings";
import { heldXmlParse, parseXml } from "../../xmlParse";
import { HeldExpansions } from "../heldExpansions";
import { readHqApp } from "../index";
import type { ReaderInput } from "../types";
import { exportedBody, inputFor, mirrorMenu } from "./novaExport";
import { retainedSourceBody } from "./readerInput";

/** A whole reading of a retained base takes a few seconds at most; three take a test. */
const READINGS_MS = 120_000;

/** An outcome as plain data, the claim log's records read out. */
function plain(outcome: ReturnType<typeof readHqApp>): unknown {
	return JSON.parse(
		JSON.stringify({
			...outcome,
			claims: [...outcome.claims.records()],
			counts: outcome.claims.counts,
		}),
	);
}

function clinic() {
	return buildDoc({
		modules: [
			{
				name: "Clients",
				caseType: "client",
				forms: [
					{
						name: "Register",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "case_name",
								label: "Name",
								caseWrite: { caseType: "client", property: "case_name" },
							}),
							f({
								kind: "int",
								id: "age",
								label: "Age",
								relevant: "#form/case_name != ''",
							}),
						],
					},
				],
			},
		],
	});
}

/** Nova's export of `clinic`, with a mirror menu and a menu name HQ holds: one body, so each
 *  input made of it is the same app. */
const NOVA_EXPORT = exportedBody(clinic(), {
	modules: (modules) => [...modules, mirrorMenu(String(modules[0]?.unique_id))],
	root: { translations: { en: { en: "English", "modules.m0": "Patients" } } },
});

/** A new input over `body`, told the app strings Nova's build gives a document. */
function wholeInput(body: Readonly<Record<string, unknown>>) {
	return inputFor(body, {
		appStrings: (doc) => localAppStringTable(doc, []),
	});
}

/** The source body CommCare HQ answered for the retained base `id`. */
function retainedSourceOf(id: string): Record<string, unknown> {
	const { body } = retainedBase(id).source;
	if (body === undefined) throw new Error(`The base ${id} retains no source.`);
	return JSON.parse(body);
}

/** The inputs read below: Nova's own export, and apps CommCare HQ's own pages made, of menus,
 *  case management, search, languages, advanced menus and media. */
const INPUTS: readonly (readonly [string, () => Promise<ReaderInput>])[] = [
	["Nova's export", () => wholeInput(NOVA_EXPORT)],
	[
		"navigation-base",
		() => wholeInput(retainedSourceBody("navigation-base/app-source")),
	],
	...[
		"hq-plain",
		"hq-case-management",
		"hq-search",
		"hq-languages",
		"hq-advanced",
		"hq-media",
	].map((id) => [id, () => wholeInput(retainedSourceOf(id))] as const),
];

/** What an input holds as data: everything but its functions, which hold no state of a reading. */
function dataOf(input: ReaderInput): unknown {
	const {
		resolver: _resolver,
		lookup,
		media: _media,
		appStrings: _appStrings,
		recordDialect: _recordDialect,
		...data
	} = input;
	return { ...data, lookupDefinitions: lookup.definitions };
}

/** Every object `value` reaches, a map's keys and values among them. */
function objectsOf(value: unknown, seen = new Set<object>()): Set<object> {
	if (typeof value !== "object" || value === null || seen.has(value))
		return seen;
	seen.add(value);
	if (value instanceof Map)
		for (const [key, member] of value) {
			objectsOf(key, seen);
			objectsOf(member, seen);
		}
	else if (value instanceof Set)
		for (const member of value) objectsOf(member, seen);
	else for (const member of Object.values(value)) objectsOf(member, seen);
	return seen;
}

/** `input` with every object its data reaches frozen, the input itself included. */
function frozenWhole(input: ReaderInput): ReaderInput {
	for (const object of objectsOf(dataOf(input))) Object.freeze(object);
	return Object.freeze(input);
}

describe("one input read twice", () => {
	for (const [name, inputOf] of INPUTS)
		it(
			`reads ${name} twice to one outcome and one claim log`,
			async () => {
				const input = await inputOf();
				const once = readHqApp(input, { claims: "full" });
				const twice = readHqApp(input, { claims: "full" });
				expect(plain(twice)).toEqual(plain(once));
				expect(
					[...twice.claims.records()].length,
					"a reading claims what it reads",
				).toBeGreaterThan(0);
			},
			READINGS_MS,
		);
});

describe("what a reading was given", () => {
	for (const [name, inputOf] of INPUTS)
		it(
			`leaves ${name} as it found it, and reads it frozen as it reads it unfrozen`,
			async () => {
				const input = await inputOf();
				const before = structuredClone(dataOf(input));
				const frozenBefore = [...objectsOf(dataOf(input))].filter((object) =>
					Object.isFrozen(object),
				);
				const unfrozen = readHqApp(input, { claims: "full" });
				expect(dataOf(input)).toEqual(before);
				expect(
					[...objectsOf(dataOf(input))].filter((object) =>
						Object.isFrozen(object),
					),
				).toEqual(frozenBefore);

				const frozen = readHqApp(frozenWhole(await inputOf()), {
					claims: "full",
				});
				expect(plain(frozen)).toEqual(plain(unfrozen));
			},
			READINGS_MS,
		);
});

/** The label a reading gives the question `id`. */
function labelOf(outcome: ReturnType<typeof readHqApp>, id: string): string {
	if (outcome.kind !== "read") throw new Error("The reading is an account.");
	const field = Object.values(outcome.draft.doc.fields).find(
		(one) => one.id === id,
	);
	if (field === undefined || !("label" in field) || field.label === undefined)
		throw new Error(`The reading holds no question ${id}.`);
	return proseTemplateText(field.label);
}

it("reads two sources of one app in one request as each reads alone, and leaves every held parse as a fresh parse", async () => {
	const doc = clinic();
	const before = exportedBody(doc);
	// A change a person makes in HQ's form builder: the question's label.
	const after = exportedBody(doc, {
		xml: (xml) => xml.replaceAll(">Age<", ">Years<"),
	});
	const inputBefore = await inputFor(before);
	const inputAfter = await inputFor(after);
	const held = new HeldExpansions();
	const readShared = (input: ReaderInput) =>
		readHqApp(input, { claims: "full", heldExpansions: held });
	const readAlone = (input: ReaderInput) =>
		readHqApp(input, { claims: "full", heldExpansions: new HeldExpansions() });

	const first = readShared(inputBefore);
	const second = readShared(inputAfter);
	const third = readShared(inputBefore);

	expect(labelOf(first, "age")).toBe("Age");
	expect(labelOf(second, "age")).toBe("Years");
	expect(plain(second)).toEqual(plain(readAlone(inputAfter)));
	expect(plain(third)).toEqual(plain(first));
	expect(plain(first)).toEqual(plain(readAlone(inputBefore)));

	for (const body of [before, after])
		for (const xml of Object.values(
			body._attachments as Record<string, string>,
		)) {
			const parsed = heldXmlParse(xml);
			if (!("doc" in parsed)) throw new Error("A form text does not parse.");
			expect(Object.isFrozen(parsed.doc)).toBe(true);
			expect(JSON.stringify(parsed.doc, domKeys)).toBe(
				JSON.stringify(parseXml(xml), domKeys),
			);
		}
});

/** A DOM node as its name, attributes, text and children: what a reader of
 *  it reads. */
function domKeys(key: string, value: unknown): unknown {
	if (key === "parent" || key === "prev" || key === "next") return undefined;
	if (
		key === "startIndex" ||
		key === "endIndex" ||
		key === "sourceCodeLocation"
	)
		return undefined;
	return value;
}
