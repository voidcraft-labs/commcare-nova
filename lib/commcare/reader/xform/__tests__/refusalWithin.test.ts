/**
 * Where a refusal that covers a form's element stands in the claim log: at the element, and at each
 * node inside it whose surface key its entry names, which the lane's parity decides under that entry
 * (a setvalue's `event`, an `appearance`, an itemset's `copy`). The plausible failure: a refusal
 * recorded only where the reader stood, so the lane's use of the class at the attribute it is a fact
 * about finds no record naming the entry.
 */
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { proseText } from "@/lib/domain";
import { localAppStringTable } from "../../../appStrings";
import { expandDoc } from "../../../expander";
import {
	readerInput,
	retainedSourceBody,
	sourceFromBody,
} from "../../__tests__/readerInput";
import type { ClaimRecord } from "../../accounting";
import { readHqApp } from "../../index";
import type { AppJson } from "../../menus/__tests__/menuReading";

const Q = "questions";

const SURVEY = buildDoc({
	modules: [
		{
			name: "Visits",
			forms: [
				{
					name: "Visit",
					type: "survey",
					fields: [
						f({ kind: "text", id: "visitnote", label: proseText("Note") }),
					],
				},
			],
		},
	],
});

/** The survey's reading, its one form's source edited by `edit`, with its full claim log. */
async function readEditedForm(
	edit: (xml: string) => string,
): Promise<ClaimRecord[]> {
	const emitted = expandDoc(SURVEY);
	const json = JSON.parse(
		JSON.stringify({
			...retainedSourceBody("shell/app-source"),
			langs: emitted.langs,
			modules: emitted.modules,
			_attachments: emitted._attachments,
		}),
	) as AppJson;
	const attachments = json._attachments as Record<string, string>;
	const [name] = Object.keys(attachments).filter((key) => key.endsWith(".xml"));
	if (name === undefined) throw new Error("The app holds no form source.");
	attachments[name] = edit(attachments[name] as string);
	const input = readerInput(await sourceFromBody(json));
	const outcome = readHqApp(
		{
			...input,
			recordDialect: () => undefined,
			appStrings: (read) => localAppStringTable(read, []),
		},
		{ claims: "full" },
	);
	return [...outcome.claims.records()];
}

/** Replaces `from`, which `xml` must hold once, with `to`. */
function once(xml: string, from: string, to: string): string {
	if (xml.split(from).length !== 2)
		throw new Error(`The form's source holds ${from} other than once.`);
	return xml.replace(from, to);
}

describe("a refusal covering an element", () => {
	it("stands at a setvalue's event under its entry, by the event's key", async () => {
		const records = await readEditedForm((xml) =>
			once(
				xml,
				"</model>",
				`<setvalue event="jr-insert" ref="/data/visitnote" value="'x'"/></model>`,
			),
		);
		const entry = `${Q}/a-default-value-s-setvalue-whose-event-does-not-match-where-the`;
		const at = records.filter((one) => one.entry === entry);
		expect(at.map((one) => one.key)).toEqual(
			expect.arrayContaining(["jr-action:setvalue", "jr-event:jr-insert"]),
		);
		expect(at.find((one) => one.key === "jr-event:jr-insert")?.where).toMatch(
			/\/setvalue\[1\]\/@event$/,
		);
	});

	it("stands at a refused question's appearance under its entry, by the appearance's key", async () => {
		const records = await readEditedForm((xml) =>
			once(
				once(xml, ' type="xsd:string"', ""),
				'ref="/data/visitnote">',
				'ref="/data/visitnote" appearance="numeric">',
			),
		);
		const entry = `${Q}/an-input-whose-bind-has-no-type-with-numeric-or-numbers-ignoring`;
		const appearance = records.find(
			(one) => one.entry === entry && one.key === "appearance:web-apps/numeric",
		);
		expect(appearance?.where).toMatch(/\/input\[1\]\/@appearance$/);
	});
});
