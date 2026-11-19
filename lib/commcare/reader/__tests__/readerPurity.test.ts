/**
 * The reader is a pure function of its input.
 *
 * Contract: two readings of one input, each with a fresh resolver, give
 * deeply equal outcomes: the same findings in the same order, the same claim
 * log record for record, the same defects, the same work, and, where a
 * document reads, the same draft. Two sources of one app read one after the
 * other in one request, as a review of changes made in CommCare HQ reads its
 * baseline and the app now, sharing the request's held emissions
 * (`heldExpansions.ts`) and the process's held parses
 * (`xmlParse.ts::heldXmlParse`, `syntaxRead.ts`), each give the outcome a
 * reading of it alone gives, and leave every held parse as a fresh parse of
 * its text. Plausible failures: state a module keeps between readings, an
 * order that follows a `Map`'s insertion history rather than the source, a
 * held parse or emission keyed too loosely, so a reading of one source is
 * answered with what was held for the other and the two compare as one app,
 * or a reader that writes into a parse it shares.
 */

import { expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { proseTemplateText } from "@/lib/domain/prose";
import { heldXmlParse, parseXml } from "../../xmlParse";
import { HeldExpansions } from "../heldExpansions";
import { mintingResolver } from "../identity";
import { readHqApp } from "../index";
import { exportedBody, inputFor, mirrorMenu } from "./novaExport";

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

it("reads one input twice to one outcome", async () => {
	const doc = clinic();
	const body = exportedBody(doc, {
		modules: (modules) => [
			...modules,
			mirrorMenu(String(modules[0]?.unique_id)),
		],
		root: { translations: { en: { en: "English", "modules.m0": "Patients" } } },
	});
	const input = await inputFor(body);
	const once = readHqApp(
		{ ...input, resolver: mintingResolver(input.appId) },
		{ claims: "full" },
	);
	const twice = readHqApp(
		{ ...input, resolver: mintingResolver(input.appId) },
		{ claims: "full" },
	);
	expect(plain(twice)).toEqual(plain(once));
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
	const readShared = (input: typeof inputBefore) =>
		readHqApp(
			{ ...input, resolver: mintingResolver(input.appId) },
			{ claims: "full", heldExpansions: held },
		);
	const readAlone = (input: typeof inputBefore) =>
		readHqApp(
			{ ...input, resolver: mintingResolver(input.appId) },
			{ claims: "full", heldExpansions: new HeldExpansions() },
		);

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
