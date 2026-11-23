import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { wireTable } from "../../lookup/__tests__/lookupWireCorpus";
import { lookupWireNaming } from "../../lookup/naming";
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
