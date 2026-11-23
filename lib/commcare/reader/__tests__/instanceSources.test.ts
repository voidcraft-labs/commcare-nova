import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { wireTable } from "../../lookup/__tests__/lookupWireCorpus";
import { readHqApp } from "../index";
import { exportedBody, inputFor } from "./novaExport";

const currentAge = {
	kind: "term",
	term: { kind: "form-case", caseType: "patient", property: "age" },
} as const;

const clinics = wireTable("clinics", [{ name: "name", type: "text" }]);
const lookup = {
	definitions: new Map([[clinics.id, clinics]]),
	table: (tag: string) =>
		tag === clinics.tag
			? {
					tableId: clinics.id,
					column: (wire: string) =>
						clinics.columns.find((column) => column.wireName === wire)?.id,
				}
			: undefined,
};

const visit = buildDoc({
	caseTypes: [
		{
			name: "patient",
			properties: [{ name: "age", label: "Age", data_type: "int" }],
		},
	],
	modules: [
		{
			name: "Patients",
			caseType: "patient",
			forms: [
				{
					name: "Visit",
					type: "followup",
					fields: [
						f({ kind: "hidden", id: "current_age", calculate: currentAge }),
						f({ kind: "text", id: "note", label: "Note" }),
					],
				},
			],
		},
	],
});

async function readAge(
	declaration: string,
	argumentsText: string,
	change: (source: string) => string = (source) => source,
	root?: Record<string, unknown>,
) {
	const xml = (source: string) =>
		change(
			source
				.replace(
					'<instance src="jr://instance/casedb" id="casedb"/>',
					declaration,
				)
				.replace("instance(&apos;casedb&apos;)", `instance(${argumentsText})`),
		);
	return readHqApp(
		await inputFor(exportedBody(visit, { xml, root }), { lookup }),
	);
}

describe("reading a grouped instance ID in an HQ form", () => {
	it.each([
		[
			"chosen cases",
			'<instance id="casedb" src="jr://instance/selected-entities/selected_cases"/>',
			"(('casedb'))",
		],
		[
			"lookup fixture",
			'<instance id="casedb" src="jr://fixture/item-list:clinics"/>',
			"(('casedb'))",
		],
		[
			"unknown source",
			'<instance id="casedb" src="jr://unrecognized/source"/>',
			"(('casedb'))",
		],
		[
			"inline root",
			'<instance id="casedb"><choices/></instance>',
			"(('casedb'))",
		],
		["missing declaration", "", "(('casedb'))"],
		[
			"extra argument",
			'<instance id="casedb" src="jr://instance/casedb"/>',
			"(('casedb')), 'extra'",
		],
	])(
		"refuses a case property read from %s",
		async (_label, declaration, args) => {
			const outcome = await readAge(declaration, args);
			expect(outcome.kind).toBe("account");
			expect(outcome.defects).toEqual([]);
		},
	);

	it.each([
		[
			"label",
			(s: string) => s.replaceAll(">Note<", ">Guide to instance('casedb')<"),
			true,
		],
		[
			"nested XML entity",
			(s: string) =>
				s.replaceAll(
					">Note<",
					">Guide to instance(&amp;apos;casedb&amp;apos;)<",
				),
			false,
		],
		[
			"XML numeric entity",
			(s: string) =>
				s.replaceAll(">Note<", ">Guide to instan&#99;e(&apos;casedb&apos;)<"),
			true,
		],
		[
			"comment inside the model",
			(s: string) => s.replace("<model>", "<model><!-- instance('casedb') -->"),
			false,
		],
		[
			"comment before the root",
			(s: string) => s.replace("<h:html", "<!-- instance('casedb') --><h:html"),
			false,
		],
		[
			"editor shadow",
			(s: string) =>
				s.replace(
					/calculate="([^"]*instance[^"]*)"/,
					(_, value: string) =>
						`calculate="${value}" vellum:calculate="${value.replace("instance((('casedb')))", "instance('casedb')")}"`,
				),
			false,
		],
	] as const)(
		"reads the grouped native path when its factory survives the build at %s",
		async (_site, change, held) => {
			const result = await readAge("", "(('casedb'))", change);
			expect(result.defects).toEqual([]);
			expect(result.kind).toBe(held ? "read" : "account");
		},
	);

	it.each([
		["both languages", ["en", "fr"], ["en", "fr"], true],
		["only English", ["en", "fr"], ["en"], false],
		["excluded from the default build", ["en"], ["en"], false],
	] as const)(
		"requires the factory in every build for %s",
		async (_site, langs, profile, held) => {
			const change = (source: string) =>
				source.replace(
					/(<translation\b[^>]*lang="en"[^>]*>[\s\S]*?<\/translation>)/,
					(en) =>
						en +
						en
							.replace('lang="en"', 'lang="fr"')
							.replaceAll(">Note<", ">Guide to instance('casedb')<"),
				);
			const result = await readAge("", "(('casedb'))", change, {
				langs,
				build_profiles: { field: { name: "Field", langs: profile } },
			});
			expect(result.defects).toEqual([]);
			const absent =
				result.kind === "account" &&
				result.findings.some(
					(finding) =>
						finding.code ===
						"expressions-and-data/referenced-undeclared-instance-id-with-no-known-scheme-or-one",
				);
			expect(absent).toBe(!held);
		},
	);
	it.each([
		["same", true],
		["different", false],
	] as const)(
		"normalizes the %s itext values before scanning",
		async (value, absent) => {
			const change = (source: string) =>
				source.replace(
					/(<translation\b[^>]*>)/,
					(_, open: string) =>
						`${open}<text id="a-control"><value>same</value></text><text id="z-duplicate" note="instance('casedb')"><value>${value}</value></text>`,
				);
			const result = await readAge("", "(('casedb'))", change);
			expect(
				result.kind === "account" &&
					result.findings.some(
						(finding) =>
							finding.code ===
							"expressions-and-data/referenced-undeclared-instance-id-with-no-known-scheme-or-one",
					),
			).toBe(absent);
		},
	);

	it.each([
		[
			"absent versus empty CDATA",
			"<value/>",
			"<value><![CDATA[]]></value>",
			false,
		],
		[
			"two empty CDATA bodies",
			"<value><![CDATA[]]></value>",
			"<value><![CDATA[]]></value>",
			true,
		],
		[
			"CDATA and the same text",
			"<value><![CDATA[note]]></value>",
			"<value>note</value>",
			true,
		],
		[
			"empty CDATA beside an element",
			"<value><![CDATA[]]><output/></value>",
			"<value><output/></value>",
			true,
		],
		["comment alone", "<value><!-- lost --></value>", "<value/>", true],
		[
			"joined comment tail",
			"<value>no<!-- lost -->te</value>",
			"<value>note</value>",
			true,
		],
		[
			"empty PI and separated empty PI",
			"<value><?p?></value>",
			"<value><?p ?></value>",
			false,
		],
		[
			"normalized PI separator",
			"<value><?p  data?></value>",
			"<value><?p data?></value>",
			true,
		],
	] as const)(
		"uses HQ’s rendered value identity for %s",
		async (_what, earlier, later, duplicate) => {
			const change = (source: string) =>
				source.replace(
					/(<translation\b[^>]*>)/,
					(_, start: string) =>
						`${start}<text id="a-control">${earlier}</text><text id="z-control" note="instance('casedb')">${later}</text>`,
				);
			const result = await readAge("", "(('casedb'))", change);
			expect(
				result.kind === "account" &&
					result.findings.some(
						(finding) =>
							finding.code ===
							"expressions-and-data/referenced-undeclared-instance-id-with-no-known-scheme-or-one",
					),
			).toBe(duplicate);
		},
	);

	it.each([true, false])(
		"compares rendered inherited namespace bindings when a text redeclares the same binding: %s",
		async (same) => {
			const uri = `urn:nova:${"district-".repeat(180)}`;
			const change = (source: string) =>
				source.replace(
					/(<translation\b[^>]*)(>)/,
					(_, start: string) =>
						`${start} xmlns:area="${uri}"><text id="a-control"><value>one</value></text>` +
						`<text id="z-control" xmlns:area="${same ? uri : "urn:another"}" note="instance('casedb')"><value>one</value></text>` +
						Array.from(
							{ length: 24 },
							(_, i) =>
								`<text id="district-${i}"><value>Group ${i}</value></text>`,
						).join(""),
				);
			const result = await readAge("", "(('casedb'))", change);
			expect(
				result.kind === "account" &&
					result.findings.some(
						(finding) =>
							finding.code ===
							"expressions-and-data/referenced-undeclared-instance-id-with-no-known-scheme-or-one",
					),
			).toBe(same);
		},
	);

	it.each([true, false])(
		"follows repeated normalized references when a kept id supplies the factory: %s",
		async (pointsToDuplicate) => {
			const kept = `a-${"district".repeat(60)}-instance('casedb`;
			const ref = pointsToDuplicate ? "z-reader-ref" : "absent";
			const change = (source: string) =>
				source
					.replace(
						/(<translation\b[^>]*>)/,
						(_, start: string) =>
							`${start}<text id="${kept}"><value>same</value></text><text id="z-reader-ref"><value>same</value></text>`,
					)
					.replace(
						"<model>",
						`<model><?survey ${`jr:itext('${ref}') `.repeat(36)}?>`,
					);
			const result = await readAge("", "(('casedb'))", change);
			expect(
				result.kind === "account" &&
					result.findings.some(
						(finding) =>
							finding.code ===
							"expressions-and-data/referenced-undeclared-instance-id-with-no-known-scheme-or-one",
					),
			).toBe(!pointsToDuplicate);
		},
	);

	it("keeps an explicit non-case source even when a retained label asks the factory for its ID", async () => {
		const result = await readAge(
			'<instance id="casedb" src="jr://fixture/item-list:clinics"/>',
			"(('casedb'))",
			(source) => source.replaceAll(">Note<", ">Guide to instance('casedb')<"),
		);
		expect(result.kind).toBe("account");
		expect(result.defects).toEqual([]);
	});
	it("reads a grouped case property when a different question’s executable condition supplies the factory", async () => {
		const change = (source: string) => {
			const age = source.match(/calculate="([^"]*casedb[^"]*)"/)?.[1];
			if (!age) throw new Error("The follow-up has no current age read");
			const condition = age.replace(
				"instance((('casedb')))",
				"instance(&apos;casedb&apos;)",
			);
			return source.replace(
				/(<bind\b[^>]*nodeset="\/data\/note"[^>]*?)\/>/,
				(_, bind: string) => `${bind} relevant="${condition} &gt; 0"/>`,
			);
		};
		const result = await readAge("", "(('casedb'))", change);
		expect(result.kind === "account" ? result.findings : []).toEqual([]);
		if (result.kind !== "read") throw new Error("The follow-up was refused");
		expect(
			Object.values(result.draft.doc.fields).find(
				(field) => field.id === "current_age",
			),
		).toMatchObject({ calculate: currentAge });
	});

	it.each(["casedb", "held_cases"])(
		"reads and republishes the declared case database under %s",
		async (id) => {
			const outcome = await readAge(
				`<instance id="${id}" src="jr://instance/casedb"/>`,
				`(('${id}'))`,
			);
			expect(outcome.kind).toBe("read");
			if (outcome.kind !== "read")
				throw new Error("the source form was refused");
			const field = Object.values(outcome.draft.doc.fields).find(
				(one) => one.id === "current_age",
			);
			expect(field).toMatchObject({ kind: "hidden", calculate: currentAge });
			const again = await readHqApp(
				await inputFor(exportedBody(outcome.draft.doc)),
			);
			expect(again.kind).toBe("read");
			if (again.kind === "read")
				expect(
					Object.values(again.draft.doc.fields).find(
						(one) => one.id === "current_age",
					),
				).toMatchObject({ kind: "hidden", calculate: currentAge });
		},
	);
});
