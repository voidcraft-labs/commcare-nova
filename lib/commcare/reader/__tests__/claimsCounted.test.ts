/**
 * Shapes a reading meets and claims under the entry that names them, at the place the proof
 * lane's manifest check extracts each use, so the claim log counts the entry where an app made in
 * CommCare HQ holds the shape: an add-on turned on, a profile property only a local archive
 * writes, a stored custom suite, the hashtags a form's head map names, a question's data node, a
 * secondary instance's element and a Hidden Value's bind type.
 *
 * Plausible failures: `add_ons` taken whole, so no add-on's entry is ever counted; a key that
 * turns nothing on counted as the add-on; a profile property filed at `profile` rather than at
 * its own key; the head map dropped whole, so a hashtag it names is counted nowhere; a question's
 * data node recorded only under its type; a refused question id raising its finding at no node;
 * a secondary instance claimed only under its source; a Hidden Value's type recorded under a key
 * no use of the lane has there.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc } from "@/lib/domain";
import { proseText } from "@/lib/domain";
import { localAppStringTable } from "../../appStrings";
import { expandDoc } from "../../expander";
import type { ClaimRecord } from "../accounting";
import { readHqApp } from "../index";
import type { AppJson } from "../menus/__tests__/menuReading";
import { readerInput, retainedSourceBody, sourceFromBody } from "./readerInput";

const A = "application-and-settings";
const Q = "questions";

/** `doc` emitted on HQ's shell, `edit` applied to the stored app, read with the full claim log. */
async function readEdited(
	doc: BlueprintDoc,
	edit: (app: AppJson) => void,
): Promise<ReturnType<typeof readHqApp>> {
	const emitted = expandDoc(doc);
	const json = JSON.parse(
		JSON.stringify({
			...retainedSourceBody("shell/app-source"),
			langs: emitted.langs,
			modules: emitted.modules,
			_attachments: emitted._attachments,
		}),
	) as AppJson;
	edit(json);
	const input = readerInput(await sourceFromBody(json));
	return readHqApp(
		{
			...input,
			recordDialect: () => undefined,
			appStrings: (read) => localAppStringTable(read, []),
		},
		{ claims: "full" },
	);
}

/** The one form's source, edited by `edit`. */
function editForm(app: AppJson, edit: (xml: string) => string): void {
	const attachments = app._attachments as Record<string, string>;
	const [name] = Object.keys(attachments).filter((key) => key.endsWith(".xml"));
	if (name === undefined) throw new Error("The app holds no form source.");
	attachments[name] = edit(attachments[name] as string);
}

function records(outcome: ReturnType<typeof readHqApp>): ClaimRecord[] {
	return [...outcome.claims.records()];
}

function findingCodes(outcome: ReturnType<typeof readHqApp>): string[] {
	return outcome.kind === "account"
		? outcome.findings.map((one) =>
				one.code === "unrecognized"
					? `unrecognized:${one.detail.name ?? ""}`
					: one.code,
			)
		: [];
}

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
						f({
							kind: "group",
							id: "details",
							label: proseText("Details"),
							children: [
								f({ kind: "text", id: "inner", label: proseText("Inner") }),
							],
						}),
						f({ kind: "hidden", id: "made", calculate: "1 + 1" }),
					],
				},
			],
		},
	],
});

describe("the claims a reading counts", () => {
	it("claims each add-on turned on under its entry at its own key, and every other key at the map", async () => {
		const outcome = await readEdited(SURVEY, (app) => {
			app.add_ons = {
				menu_mode: true,
				calc_xpaths: false,
				custom_icon_badges: true,
			};
		});
		expect(findingCodes(outcome)).toEqual([]);
		const at = records(outcome).filter((one) =>
			one.where.startsWith("/add_ons"),
		);
		expect(at.map(({ where, key, entry }) => ({ where, key, entry }))).toEqual(
			expect.arrayContaining([
				{
					where: "/add_ons/menu_mode",
					key: "add-on:menu_mode",
					entry: `${A}/menu-mode`,
				},
				{
					where: "/add_ons",
					key: "schema:Application.add_ons",
					entry: `${A}/add-ons`,
				},
			]),
		);
		expect(at.some((one) => one.entry === `${A}/calc-xpaths`)).toBe(false);
		expect(at.some((one) => one.where === "/add_ons/calc_xpaths")).toBe(false);
		expect(at.some((one) => one.where === "/add_ons/custom_icon_badges")).toBe(
			false,
		);
	});

	it("accounts each of a menu's badges after the first under its entry, beside the first's refusal", async () => {
		const badge = (text: string) => ({
			doc_type: "CustomIcon",
			form: "badge",
			text: { en: text },
			xpath: "",
		});
		const outcome = await readEdited(SURVEY, (app) => {
			const [menu] = app.modules as Record<string, unknown>[];
			if (menu !== undefined)
				menu.custom_icons = [badge("1"), badge("2"), badge("3")];
		});
		expect(findingCodes(outcome)).toEqual([
			"menus-and-case-lists/custom-icons-0-badge-localized-text-or-xpath",
		]);
		expect(
			records(outcome).filter(
				(one) => one.entry === "menus-and-case-lists/custom-icons-1",
			),
		).toEqual([
			expect.objectContaining({
				where: "/modules/0/custom_icons",
				key: "schema:Module.custom_icons",
			}),
			expect.objectContaining({
				where: "/modules/0/custom_icons",
				key: "schema:Module.custom_icons",
			}),
		]);
	});

	it("claims a profile property only a local archive writes at its own key", async () => {
		const outcome = await readEdited(SURVEY, (app) => {
			const profile = (app.profile ?? {}) as Record<string, unknown>;
			app.profile = {
				...profile,
				properties: {
					...((profile.properties ?? {}) as Record<string, unknown>),
					"cc-app-version": "5",
				},
			};
		});
		expect(findingCodes(outcome)).toEqual([]);
		expect(records(outcome)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					where: "/profile/properties/cc-app-version",
					key: "profile-property:cc-app-version",
					entry: `${A}/local-archive-profile-properties`,
				}),
			]),
		);
	});

	it("claims a stored custom suite at the attachments under its entry", async () => {
		const outcome = await readEdited(SURVEY, (app) => {
			(app._attachments as Record<string, string>)["custom_suite.xml"] =
				"<suite/>";
		});
		expect(findingCodes(outcome)).toEqual([]);
		expect(
			records(outcome).filter((one) => one.entry === `${A}/42-hq-custom-suite`),
		).toEqual([
			expect.objectContaining({
				where: "/_attachments",
				key: "schema:Application._attachments",
			}),
		]);
	});

	it("claims the head's hashtag map once under each hashtag it names that an allowing entry holds", async () => {
		const outcome = await readEdited(SURVEY, (app) =>
			editForm(app, (xml) =>
				xml.replace(
					"</h:title>",
					'</h:title><vellum:hashtags>{"#case/name":null,"#case/age":null,"#form/visitnote":null,"#user/region":null}</vellum:hashtags>',
				),
			),
		);
		expect(findingCodes(outcome)).toEqual([]);
		const atMap = records(outcome).filter((one) =>
			one.where.endsWith("/vellum:hashtags[1]"),
		);
		expect(atMap.map(({ key, entry }) => ({ key, entry })).sort(byKey)).toEqual(
			[
				{
					key: "hashtag:#case/",
					entry:
						"expressions-and-data/case-prop-case-parent-prop-case-grandparent-prop",
				},
				{ key: "hashtag:#form/", entry: "expressions-and-data/form" },
				{
					key: "hashtag:#user",
					entry: "forms-and-case-writes/user-prop-in-xform-expressions",
				},
				{
					key: "vellum-markup:h:head/vellum:hashtags",
					entry: `${Q}/vellum-hashtags-vellum-hashtagtransforms`,
				},
			].sort(byKey),
		);
	});

	it("claims each question's data node by its depth, and a declared instance's element beside its source", async () => {
		const outcome = await readEdited(SURVEY, (app) =>
			editForm(app, (xml) => {
				const at = xml.indexOf("</instance>") + "</instance>".length;
				return `${xml.slice(0, at)}<instance id="casedb" src="jr://instance/casedb"/>${xml.slice(at)}`;
			}),
		);
		expect(findingCodes(outcome)).toEqual([]);
		const ids = records(outcome).filter(
			(one) => one.entry === `${Q}/question-id-matching-xml-a-za-z-w`,
		);
		const keyOf = (name: string) =>
			ids.find((one) => one.where.endsWith(`}${name}[1]`))?.key;
		expect(keyOf("visitnote")).toBe("xform:model/instance/*/*");
		expect(keyOf("details")).toBe("xform:model/instance/*/*");
		expect(keyOf("inner")).toBe("xform:model/instance//*");
		expect(
			records(outcome).filter(
				(one) =>
					one.where.endsWith("/instance[2]") &&
					one.key === "xform:model/instance",
			),
		).toEqual([
			expect.objectContaining({
				entry: `${A}/attachments-form-unique-id-xml`,
			}),
		]);
	});

	it("refuses a question id at its data node, one finding", async () => {
		const outcome = await readEdited(SURVEY, (app) =>
			editForm(app, (xml) => xml.replaceAll("visitnote", "case")),
		);
		expect(findingCodes(outcome)).toEqual([
			`${Q}/question-id-case-registration-script`,
		]);
		expect(
			records(outcome).filter(
				(one) =>
					one.entry === `${Q}/question-id-case-registration-script` &&
					one.where.includes("/model[1]/instance[1]/"),
			),
		).toEqual([
			expect.objectContaining({
				key: "xform:model/instance/*/*",
				standing: "not-yet",
			}),
		]);
	});

	it("keys a Hidden Value's bind type by the bind type's own key", async () => {
		const outcome = await readEdited(SURVEY, (app) =>
			editForm(app, (xml) => {
				const nodeset = 'nodeset="/data/made"';
				const at = xml.indexOf(nodeset);
				if (at < 0) throw new Error("No bind for the Hidden Value.");
				const bind = xml.slice(
					xml.lastIndexOf("<bind", at),
					xml.indexOf("/>", at),
				);
				return bind.includes(" type=")
					? xml
					: xml.replace(nodeset, `${nodeset} type="xsd:string"`);
			}),
		);
		expect(findingCodes(outcome)).toEqual([]);
		const type = records(outcome).filter(
			(one) =>
				one.where.endsWith("/@type") &&
				one.entry ===
					`${Q}/hidden-value-data-node-bind-no-control-with-calculate-or-default`,
		);
		expect(type.map((one) => one.key)).toEqual(["xform:model/bind@type"]);
		expect(
			records(outcome).some(
				(one) => one.where.endsWith("/@type") && one.key === "mug:DataBindOnly",
			),
		).toBe(false);
	});

	it("claims the uses of a markdown copy's literal output, as its source text's are", async () => {
		// The emitter writes `instance(` with its bracket as a literal output, in the text and in its
		// markdown copy alike, and the copy's output, which has no twin, is claimed with its uses.
		const doc = buildDoc({
			modules: [
				{
					name: "Visits",
					forms: [
						{
							name: "Visit",
							type: "survey",
							fields: [
								f({
									kind: "text",
									id: "note",
									label: proseText("Read instance('x') here"),
								}),
							],
						},
					],
				},
			],
		});
		const outcome = await readEdited(doc, () => {});
		expect(findingCodes(outcome)).toEqual([]);
		const literals = records(outcome).filter(
			(one) => one.where.includes("/output[") && one.where.endsWith("/@value"),
		);
		const values = [...new Set(literals.map((one) => one.where))];
		// The source's value and its markdown copy each hold the output.
		expect(values.length).toBe(2);
		for (const where of values)
			expect(
				literals
					.filter((one) => one.where === where)
					.map((one) => one.key)
					.sort(),
			).toEqual(
				expect.arrayContaining([
					"xform:model/itext/translation/text/value/output@value",
					"xpath-expr:XPathStringLiteral",
					"xpath-token:STR",
				]),
			);
	});

	it("claims the shorthand of a tab's filter over a case type's children where HQ interpolates it, and of no tab with its own rows", async () => {
		const doc = buildDoc({
			caseTypes: [
				{
					name: "household",
					properties: [{ name: "village", label: "Village" }],
				},
			],
			modules: [
				{
					name: "Households",
					caseType: "household",
					forms: [
						{
							name: "Visit",
							type: "followup",
							fields: [f({ kind: "text", id: "note", label: "Note" })],
						},
					],
				},
			],
		});
		const tab = (fields: object) => ({
			doc_type: "DetailTab",
			header: { en: "Children" },
			starting_index: 0,
			has_nodeset: true,
			nodeset_case_type: "child",
			nodeset_filter: "#parent/village = 'x'",
			...fields,
		});
		const outcome = await readEdited(doc, (app) => {
			const details = (
				app.modules[0] as unknown as {
					case_details: { long: { tabs?: unknown[] } };
				}
			).case_details;
			details.long.tabs = [
				tab({}),
				tab({ nodeset: "instance('casedb')/casedb/case" }),
			];
		});
		const at = (index: number) =>
			records(outcome)
				.filter(
					(one) =>
						one.where ===
						`/modules/0/case_details/long/tabs/${index}/nodeset_filter`,
				)
				.map((one) => one.key);
		// HQ's build interpolates the filter (`details.py::_get_detail_tab_nodeset`), and Core
		// refuses the raw text's hashtag, so its uses are its shorthand alone.
		expect(at(0)).toContain("hashtag:#parent");
		expect(at(0)).not.toContain("xpath-token:STR");
		expect(at(1)).not.toContain("hashtag:#parent");
	});
});

function byKey(a: { key: string | null }, b: { key: string | null }): number {
	return (a.key ?? "") < (b.key ?? "") ? -1 : 1;
}
