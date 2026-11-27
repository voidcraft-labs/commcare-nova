import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readHqApp } from "../..";
import { inputFor } from "../../__tests__/novaExport";

const PATH = "instance('commcaresession')/session/data/fingerprintquery";
const KEY = "session-path:session/data/fingerprintquery";
const BARE = "expressions-and-data/bare-fingerprint-query-without-a-supplier";
const REMAINING = "expressions-and-data/session-data-fingerprintquery";

type SourceForm = {
	unique_id: string;
	arbitrary_datums?: {
		datum_id: string;
		datum_function: string;
		doc_type: string;
	}[];
};
type Source = {
	modules: { forms: SourceForm[] }[];
	_attachments: Record<string, string>;
};

function retained(base: "hq-expressions" | "hq-advanced"): Source {
	return JSON.parse(readFileSync(`proof/hq-apps/${base}/app.json`, "utf8"));
}

async function survey(calculation: string) {
	const body = retained("hq-expressions");
	const attachment = `${body.modules[0].forms[0].unique_id}.xml`;
	const source = body._attachments[attachment];
	body._attachments[attachment] = source.replace(
		/<bind [^>]*nodeset="\/data\/language"[^>]*>/,
		`<bind nodeset="/data/language" calculate="${calculation}"/>`,
	);
	expect(body._attachments[attachment]).not.toBe(source);
	return readHqApp(await inputFor(body), { claims: "full" });
}

describe("bare fingerprint query in a Hidden Value", () => {
	it("refuses the absent count at the actual calculation", async () => {
		const outcome = await survey(PATH);
		expect(outcome.kind).toBe("account");
		if (outcome.kind !== "account") throw new Error("Expected the finding.");
		expect(outcome.findings).toContainEqual(
			expect.objectContaining({
				code: BARE,
				standing: "fix-in-hq",
				place: expect.objectContaining({ kind: "question", path: "language" }),
			}),
		);
		expect([...outcome.claims.records()]).toContainEqual(
			expect.objectContaining({ key: KEY, entry: BARE, standing: "fix-in-hq" }),
		);
	});

	it("leaves the enclosing guard in the undecided class", async () => {
		const outcome = await survey(
			`if(count(${PATH}) = 0, 'No lookup result', string(${PATH}[1]))`,
		);
		expect(
			[...outcome.claims.records()].filter(({ key }) => key === KEY),
		).toEqual([
			expect.objectContaining({ entry: REMAINING, standing: "not-yet" }),
		]);
	});

	it("distinguishes a named datum on a reachable Advanced form", async () => {
		const body = retained("hq-advanced");
		const form = body.modules[1].forms[0];
		form.arbitrary_datums = [
			{
				datum_id: "fingerprintquery",
				datum_function: "'Declared result'",
				doc_type: "ArbitraryDatum",
			},
		];
		const attachment = `${form.unique_id}.xml`;
		body._attachments[attachment] = body._attachments[attachment]
			.replace("</data>", "<observed_count/></data>")
			.replace(
				"</model>",
				`<bind nodeset="/data/observed_count" calculate="${PATH}"/></model>`,
			);
		const outcome = readHqApp(await inputFor(body), { claims: "full" });
		const records = [...outcome.claims.records()];
		expect(records).toContainEqual(
			expect.objectContaining({
				key: "schema:ArbitraryDatum.datum_id",
				standing: "held",
			}),
		);
		expect(records).toContainEqual(expect.objectContaining({ key: KEY }));
		expect(records).not.toContainEqual(
			expect.objectContaining({ entry: BARE }),
		);
	});
});
