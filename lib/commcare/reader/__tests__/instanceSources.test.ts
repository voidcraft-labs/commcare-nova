import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { wireTable } from "../../lookup/__tests__/lookupWireCorpus";
import { scannedInstances } from "../../xpath/instanceSources";
import { matchingResolver } from "../identity";
import { readHqApp } from "../index";
import { sourceFactories } from "../sourceFactories";
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

describe("HQ's effective native form instances", () => {
	const empty =
		"expressions-and-data/referenced-undeclared-instance-id-with-no-known-scheme-or-one";
	it.each([
		["flat", "flat", "", "instance('locations')", true],
		["hierarchical", "hierarchical", "", "instance('locations')", false],
		["unknown", undefined, "", "instance('locations')", false],
		[
			"explicit flat in a hierarchical project",
			"hierarchical",
			'<instance id="locations" src="jr://fixture/locations"/>',
			"instance((('locations')))",
			true,
		],
		[
			"explicit hierarchical in a flat project",
			"flat",
			'<instance id="locations" src="jr://fixture/commtrack:locations"/>',
			"instance((('locations')))",
			false,
		],
	] as const)(
		"reads the source project's %s places",
		async (_name, locations, declaration, call, held) => {
			const xml = (source: string) =>
				source
					.replace(
						'<instance src="jr://instance/casedb" id="casedb"/>',
						declaration,
					)
					.replace(
						/calculate="[^"]*instance[^"]*casedb[^"]*"/,
						`calculate="count(${call}/locations/location)"`,
					);
			const outcome = readHqApp(
				await inputFor(exportedBody(visit, { xml }), {
					sourceProjectFactories: { locations },
				}),
			);
			expect(outcome.defects).toEqual([]);
			if (held)
				expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
			else expect(outcome.kind).toBe("account");
		},
	);
	it.each([
		["basic active preload", "Form", "case", true, false, true],
		[
			"basic preload excluded by the requires setting",
			"Form",
			"none",
			true,
			false,
			false,
		],
		[
			"worker preload even without case selection",
			"Form",
			"none",
			false,
			true,
			true,
		],
		["advanced load with a preload", "AdvancedForm", "case", true, false, true],
		[
			"advanced load without a preload",
			"AdvancedForm",
			"case",
			false,
			false,
			false,
		],
	] as const)(
		"resolves a grouped case read from a %s",
		async (_name, kind, requires, preload, worker, available) => {
			const body = exportedBody(visit, {
				xml: (s) =>
					s
						.replace('<instance src="jr://instance/casedb" id="casedb"/>', "")
						.replaceAll(
							"instance(&apos;casedb&apos;)",
							"instance((('casedb')))",
						),
				modules: (menus) =>
					menus.map((menu) => ({
						...menu,
						doc_type: kind === "Form" ? "Module" : "AdvancedModule",
						forms: (menu.forms as Record<string, unknown>[]).map((form) => {
							const map = preload ? { "/data/note": "age" } : {};
							if (kind === "AdvancedForm")
								return {
									...form,
									doc_type: kind,
									actions: {
										load_update_cases: [
											{ case_type: "patient", case_tag: "load", preload: map },
										],
										open_cases: [],
									},
								};
							return {
								...form,
								requires,
								actions: {
									...(form.actions as object),
									case_preload: { preload: map },
									usercase_preload: {
										preload: worker ? { "/data/note": "age" } : {},
									},
								},
							};
						}),
					})),
			});
			const outcome = readHqApp(await inputFor(body));
			expect(outcome.defects).toEqual([]);
			expect(
				outcome.kind === "account" &&
					outcome.findings.some((f) => f.code === empty),
			).toBe(!available);
		},
	);
	it("reads the undeclared session that an ordinary form build appends, including a grouped literal", async () => {
		const xml = (s: string) =>
			s
				.replace(
					'<instance src="jr://instance/session" id="commcaresession"/>',
					"",
				)
				.replaceAll(
					"instance(&apos;commcaresession&apos;)",
					"instance((('commcaresession')))",
				);
		const outcome = readHqApp(await inputFor(exportedBody(visit, { xml })));
		expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
		if (outcome.kind === "read")
			expect(
				Object.values(outcome.draft.doc.fields).find(
					(f) => f.id === "current_age",
				),
			).toMatchObject({ calculate: currentAge });
	});
});

it("resolves only the app's named searches and only recoverable report sources", async () => {
	const body = exportedBody(visit, {
		modules: (menus) => [
			...menus.map((menu) => ({
				...menu,
				search_config: { instance_name: "visits", enabled: false },
			})),
			{
				unique_id: "reports",
				case_type: "",
				doc_type: "ReportModule",
				module_type: "report",
				forms: [],
				report_configs: [{ report_slug: "clinic", uuid: "fresh-export-id" }],
			},
		],
	});
	const names = [
		"results",
		"results:inline",
		"results:visits",
		"results:missing",
		"search-input:results:visits",
		"search-input:results:missing",
		"commcare:reports",
		"reports",
		"commcare-reports:clinic",
		"commcare-reports-filters:historic",
	];
	for (const mobileReports of [true, false]) {
		const input = await inputFor(body, {
			sourceProjectFactories: { mobileReports },
		});
		const sources = new Map(
			scannedInstances(
				names.map((name) => `instance('${name}')`).join(" "),
				sourceFactories(input),
			),
		);
		expect(Object.fromEntries(sources)).toEqual({
			results: "jr://instance/remote/results",
			"results:inline": "jr://instance/remote/results:inline",
			"results:visits": "jr://instance/remote/results:visits",
			"search-input:results:visits":
				"jr://instance/search-input/results:visits",
			reports: "jr://fixture/commcare:reports",
			...(mobileReports && {
				"commcare:reports": "jr://fixture/commcare:reports",
				"commcare-reports-filters:historic":
					"jr://fixture/commcare-reports-filters:historic",
			}),
		});
	}
});

describe("the source read by HQ-generated worker actions", () => {
	const source = "jr://fixture/item-list:clinics";
	function built(
		id: string,
		declaration: string,
		caseLoad: boolean,
		kind = "Form",
	) {
		return exportedBody(visit, {
			xml: (xml) =>
				xml
					.replace('<instance src="jr://instance/casedb" id="casedb"/>', "")
					.replace(
						'<instance src="jr://instance/session" id="commcaresession"/>',
						"",
					)
					.replace(
						"<model>",
						`<model><instance id="${id}" src="${declaration}"/>`,
					)
					.replace(/calculate="[^"]*instance[^"]*"/, 'calculate="1"'),
			modules: (menus) =>
				menus.map((menu) => ({
					...menu,
					doc_type: kind === "AdvancedForm" ? "AdvancedModule" : "Module",
					forms: (menu.forms as Record<string, unknown>[]).map((form) => ({
						...form,
						doc_type: kind,
						requires: "case",
						actions:
							kind === "AdvancedForm"
								? {
										load_update_cases: [
											{
												case_type: "patient",
												case_tag: "load",
												preload: caseLoad ? { "/data/note": "age" } : {},
											},
										],
										open_cases: [],
									}
								: {
										...(form.actions as object),
										case_preload: {
											preload: caseLoad ? { "/data/note": "age" } : {},
										},
									},
					})),
				})),
		});
	}
	it.each([
		["casedb", source, true, "Form", true],
		["casedb", source, true, "AdvancedForm", true],
		["casedb", source, false, "Form", false],
		["commcaresession", source, false, "Form", true],
		["commcaresession", source, false, "AdvancedForm", true],
		["other", source, true, "Form", false],
		["casedb", "jr://instance/casedb", true, "Form", false],
	] as const)(
		"checks %s from %s when preload=%s in %s",
		async (id, declared, active, kind, clash) => {
			const input = await inputFor(built(id, declared, active, kind), {
				lookup,
			});
			const result = readHqApp(input);
			expect(result.defects).toEqual([]);
			const found =
				result.kind === "account" &&
				result.findings.some(
					(f) => f.code === "form-data-source-conflict" && f.detail.name === id,
				);
			expect(found).toBe(clash);
		},
	);
	it.each([false, true])(
		"checks the group source only when HQ generates its shared case owner, sharing=%s",
		async (sharing) => {
			const body = built("groups", source, false);
			body.case_sharing = sharing;
			const menu = (body.modules as { forms: Record<string, unknown>[] }[])[0];
			const form = menu.forms[0];
			form.requires = "none";
			form.actions = {
				open_case: {
					condition: { type: "always" },
					name_update: { question_path: "/data/note" },
				},
			};
			const result = readHqApp(await inputFor(body, { lookup }));
			expect(result.defects).toEqual([]);
			expect(
				result.kind === "account" &&
					result.findings.some(
						(f) =>
							f.code === "form-data-source-conflict" &&
							f.detail.name === "groups",
					),
			).toBe(sharing);
		},
	);
	it.each([false, true])(
		"checks the case source of an edit-only write when the source flag is %s",
		async (enabled) => {
			const body = built("casedb", source, false);
			const menu = (body.modules as { forms: Record<string, unknown>[] }[])[0];
			menu.forms[0].actions = {
				update_case: {
					condition: { type: "always" },
					update: { age: { question_path: "/data/note", update_mode: "edit" } },
				},
			};
			const result = readHqApp(
				await inputFor(body, { lookup, saveOnlyEditedApplied: enabled }),
			);
			expect(result.defects).toEqual([]);
			expect(
				result.kind === "account" &&
					result.findings.some(
						(f) =>
							f.code === "form-data-source-conflict" &&
							f.detail.name === "casedb",
					),
			).toBe(enabled);
		},
	);
	it("keeps a table under an unrelated alias alongside a genuine active preload", async () => {
		const body = built("clinic-data", source, true);
		const forms = body._attachments as Record<string, string>;
		for (const [id, xml] of Object.entries(forms)) {
			forms[id] = xml.replace(
				'calculate="1"',
				`calculate="count(instance('clinic-data')/clinics_list/clinics)"`,
			);
		}
		const result = readHqApp(await inputFor(body, { lookup }));
		expect(result.kind === "account" ? result.findings : []).toEqual([]);
		expect(result.kind).toBe("read");
	});
	it("rechecks the worker source when bringing in changes to an adopted app", async () => {
		const baseline = await inputFor(
			built("casedb", "jr://instance/casedb", true),
			{ lookup },
		);
		const clean = readHqApp(baseline);
		expect(clean.kind === "account" ? clean.findings : []).toEqual([]);
		if (clean.kind !== "read") throw new Error("Unusable baseline");
		const resolver = matchingResolver(
			baseline.appId,
			clean.draft.identities.entries,
		);
		const now = readHqApp(
			await inputFor(built("casedb", source, true), { resolver, lookup }),
		);
		expect(now.kind === "account" && now.findings).toContainEqual(
			expect.objectContaining({
				code: "form-data-source-conflict",
				detail: { name: "casedb" },
			}),
		);
		const replay = readHqApp(
			await inputFor(exportedBody(clean.draft.doc), { resolver, lookup }),
		);
		expect(replay.kind).toBe("read");
	});
});

describe("HQ dispatches fixed instance schemes before consulting the form's declarations", () => {
	it.each([
		["casedb:archive", "'casedb:archive'", true],
		["registry:", "'registry:'", true],
		["commcaresession:one:two", "'commcaresession:one:two'", true],
		["casedb:archive", "(('casedb:archive'))", false],
		["archive", "'archive'", false],
	] as const)("reads %s via %s", async (id, call, broken) => {
		const result = await readAge(
			`<instance id="${id}" src="jr://instance/casedb"/>`,
			call,
		);
		expect(result.defects).toEqual([]);
		if (broken)
			expect(result.kind === "account" && result.findings).toContainEqual(
				expect.objectContaining({
					code: "unbuildable-data-source-name",
					detail: { name: id },
				}),
			);
		else expect(result.kind).toBe("read");
	});
	it("names the failing preset on a real menu condition", async () => {
		const body = exportedBody(visit, {
			modules: (menus) =>
				menus.map((menu) => ({
					...menu,
					forms: (menu.forms as Record<string, unknown>[]).map((form) => ({
						...form,
						form_filter: "count(instance('ledgerdb:archive')/x) > 0",
					})),
				})),
		});
		const result = readHqApp(await inputFor(body));
		expect(result.kind === "account" && result.findings).toContainEqual(
			expect.objectContaining({
				code: "unbuildable-data-source-name",
				detail: { name: "ledgerdb:archive" },
			}),
		);
	});
	it("checks scanner-visible prose in a language that only a named build includes", async () => {
		const change = (xml: string) =>
			xml.replace(
				/(<translation\b[^>]*lang="en"[^>]*>[\s\S]*?<\/translation>)/,
				(en) =>
					en +
					en
						.replace('lang="en"', 'lang="fr"')
						.replaceAll(">Note<", ">Guide to instance('groups:archive')<"),
			);
		const result = await readAge(
			'<instance id="casedb" src="jr://instance/casedb"/>',
			"'casedb'",
			change,
			{
				langs: ["en"],
				build_profiles: { field: { name: "Field", langs: ["fr"] } },
			},
		);
		expect(result.kind === "account" && result.findings).toContainEqual(
			expect.objectContaining({
				code: "unbuildable-data-source-name",
				detail: { name: "groups:archive" },
			}),
		);
	});
});
