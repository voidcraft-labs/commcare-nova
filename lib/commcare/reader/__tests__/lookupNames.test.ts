import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { plainColumn } from "@/lib/domain";
import type { SuiteDetailSources } from "../../hq/suiteDetailSources";
import { wireTable } from "../../lookup/__tests__/lookupWireCorpus";
import { lookupWireNaming } from "../../lookup/naming";
import { patients, uuid } from "../caseList/__tests__/fixtures";
import { readHqApp } from "../index";
import { type ExportEdits, exportedBody, inputFor } from "./novaExport";

async function reading(tag: string, label: string, edits: ExportEdits = {}) {
	const table = wireTable(tag, [
		{ name: "code", type: "text" },
		{ name: label, type: "text" },
	]);
	const doc = buildDoc({
		modules: [
			{
				name: "Visit",
				forms: [
					{
						name: "Site",
						type: "survey",
						fields: [
							f({
								kind: "single_select",
								id: "site",
								label: "Site",
								optionsSource: {
									kind: "lookup",
									tableId: table.id,
									valueColumnId: table.columns[0].id,
									labelColumnId: table.columns[1].id,
								},
							}),
						],
					},
				],
			},
		],
	});
	const body = exportedBody(doc, {
		expand: { lookupNaming: lookupWireNaming([table]) },
		...edits,
	});
	return readHqApp(
		await inputFor(body, {
			lookup: {
				definitions: new Map([[table.id, table]]),
				table: (name) =>
					name === table.tag
						? {
								tableId: table.id,
								column: (candidate) =>
									table.columns.find((column) => column.wireName === candidate)
										?.id,
							}
						: undefined,
			},
		}),
	);
}

describe("reading an HQ form with named table data", () => {
	it("offers only Web Apps for a used JVM-only column and both platforms for a shared spelling", async () => {
		for (const [label, expected] of [
			["Ა", ["web-apps"]],
			["région.1", [undefined, "android", "web-apps"]],
		] as const) {
			const result = await reading("meeting.sites", label);
			expect(result.kind === "read" ? [] : result.findings).toEqual([]);
			expect(result.defects).toEqual([]);
			if (result.kind !== "read" || result.draft.declaration.kind !== "choices")
				throw new Error("The app has no declaration.");
			expect(
				result.draft.declaration.choices.map((choice) => choice.runsOnlyOn),
			).toEqual(expected);
		}
	});

	it.each(["label", "editor", "comment"] as const)(
		"uses only the delivered XForm to resolve lookup choices at %s",
		async (site) => {
			const canonical = "instance('item-list:zones')";
			const grouped = "instance((('item-list:zones')))";
			const result = await reading("zones", "label", {
				xml(source) {
					const form = source
						.replace(
							/<instance[^>]*src="jr:\/\/fixture\/item-list:zones"[^>]*\/>/,
							"",
						)
						.replace(/instance\((?:&apos;|')zones(?:&apos;|')\)/g, grouped);
					if (site === "comment")
						return form.replace("<model>", `<model><!-- ${canonical} -->`);
					if (site === "editor")
						return form.replace(
							/nodeset="([^"]*item-list:zones[^"]*)"/,
							(_, value: string) =>
								`nodeset="${value}" vellum:nodeset="${value.replace(grouped, canonical)}"`,
						);
					return form.replaceAll(">Site<", `>Look up ${canonical}<`);
				},
			});
			expect(result.defects).toEqual([]);
			expect(result.kind).toBe(site === "label" ? "read" : "account");
		},
	);

	it("keeps grouped fixture references scoped to the form’s suite entry", async () => {
		const rows = "instance((('item-list:zones')))/zones_list/zones";
		const ordinary = "instance('item-list:zones')/zones_list/zones";
		for (const [guard, held] of [
			[rows, false],
			[ordinary, true],
		] as const) {
			const condition = `if(count(${guard}) > 0, ${rows}[code = 'west'][1]/label, '') != ''`;
			const result = await reading("zones", "label", {
				modules(modules) {
					const [form] = modules[0].forms as Record<string, unknown>[];
					form.form_filter = condition;
					return modules;
				},
			});
			expect(result.defects).toEqual([]);
			if (held)
				expect(result.kind === "account" ? result.findings : []).toEqual([]);
			else
				expect(
					result.kind === "account" &&
						result.findings.map((finding) => finding.code),
				).toContain(
					"expressions-and-data/lookup-table-instance-undiscovered-in-suite",
				);
		}
	});

	it("points a suite refusal to its form, while that same name remains usable in the form's question", async () => {
		for (const [tag, column, suffix] of [
			["meeting.1", "label", "lookup-table-instance-undiscovered-in-suite"],
			["zones", "zone.name", "dotted-column-interpolated-in-suite"],
			// HQ's build checks a form's display condition with js-xpath, whose
			// names are unaccented ("form filter has xpath error" on
			// hq-lookup-names/non-ascii-column-in-form-condition).
			["ζωνες", "label", "non-ascii-lookup-name-in-a-condition-hq-checks"],
			["zones", "région", "non-ascii-lookup-name-in-a-condition-hq-checks"],
		]) {
			const condition = `count(instance('item-list:${tag}')/${tag}_list/${tag}[${column} = 'garden']) > 0`;
			const result = await reading(tag, column, {
				modules: (modules) => {
					const [form] = modules[0].forms as Record<string, unknown>[];
					form.form_filter = condition;
					return modules;
				},
			});
			expect(result.defects).toEqual([]);
			expect(
				result.kind === "account" &&
					result.findings.map((one) => [one.code, one.place.kind]),
			).toContainEqual([`expressions-and-data/${suffix}`, "form"]);
		}
	});

	it("attributes an existing XML-only column at the read and keeps a missing column distinct", async () => {
		const present = await reading("sites", "名前");
		expect(
			present.kind === "account" && present.findings.map((one) => one.code),
		).toContain(
			"expressions-and-data/tag-or-field-name-core-s-xpath-lexer-does-not-read-as-a-name-any",
		);
		const missing = await reading("sites", "label", {
			xml: (xml) => xml.replace('ref="label"', 'ref="名前"'),
		});
		expect(
			missing.kind === "account" &&
				missing.findings.map((one) => one.detail.reason),
		).toContain("parse:unknown-column");
	});
});

describe("the instance declarations available to a calculated case column", () => {
	const cell = (instance: string, code: string) => {
		const rows = `${instance}/zones_list/zones`;
		return `if(count(${rows}) > 0, ${rows}[code = '${code}'][1]/label, '')`;
	};
	const ordinary = cell("instance('item-list:zones')", "north");
	const grouped = cell("instance((('item-list:zones')))", "west");
	const missing =
		"expressions-and-data/lookup-table-instance-undiscovered-in-suite";
	async function detailReading(
		witness: "both" | "short" | "long" | "elsewhere",
		used: "both" | "short" = "both",
		suiteDetails?: SuiteDetailSources,
	) {
		const table = wireTable("zones", [
			{ name: "code", type: "text" },
			{ name: "label", type: "text" },
		]);
		const doc = patients([
			plainColumn(uuid(1), "case_name", "Name"),
			plainColumn(uuid(2), "notes", "Notes"),
		]);
		const body = exportedBody(doc, {
			modules(menus) {
				const menu = menus[0];
				const pair = menu.case_details as Record<
					"short" | "long",
					{ columns: Record<string, unknown>[] }
				>;
				for (const screen of ["short", "long"] as const) {
					const [one, two] = pair[screen].columns;
					pair[screen].columns = [
						...(used === "both" || used === screen
							? [{ ...one, useXpathExpression: true, field: grouped }]
							: []),
						{
							...two,
							...((witness === "both" || witness === screen) && {
								useXpathExpression: true,
								field: ordinary,
							}),
						},
					];
				}
				if (witness === "elsewhere") {
					// A command condition supplies a source only to the command that evaluates it.
					const form = (menu.forms as Record<string, unknown>[])[0];
					form.form_filter = `${ordinary} > 0`;
				}
				return menus;
			},
		});
		return readHqApp(
			await inputFor(body, {
				suiteDetails,
				lookup: {
					definitions: new Map([[table.id, table]]),
					table: (name) =>
						name === table.tag
							? {
									tableId: table.id,
									column: (wire) =>
										table.columns.find((column) => column.wireName === wire)
											?.id,
								}
							: undefined,
				},
			}),
		);
	}
	it.each([
		["both", "both", true],
		["short", "both", false],
		["long", "both", false],
		["short", "short", true],
		["elsewhere", "both", false],
	] as const)(
		"uses a %s sibling for a column on %s screens",
		async (witness, used, held) => {
			const result = await detailReading(witness, used);
			expect(result.defects).toEqual([]);
			const findings =
				result.kind === "account" ? result.findings.map((f) => f.code) : [];
			if (held) expect(findings).toEqual([]);
			else expect(findings).toContain(missing);
		},
	);
	it("uses a declaration supplied by all entries reaching the same detail", async () => {
		const held = await detailReading(
			"long",
			"both",
			new Map([
				[
					"m0_case_short",
					new Map([["item-list:zones", "jr://fixture/item-list:zones"]]),
				],
			]),
		);
		expect(held.kind === "account" ? held.findings : []).toEqual([]);
		const absent = await detailReading(
			"both",
			"both",
			new Map([["m0_case_short", new Map([["item-list:zones", null]])]]),
		);
		expect(
			absent.kind === "account" && absent.findings.map((f) => f.code),
		).toContain(missing);
	});
});
