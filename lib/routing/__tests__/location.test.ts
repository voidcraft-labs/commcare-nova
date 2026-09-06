import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	isValidLocation,
	parsePathToLocation,
	recoverLocation,
	serializePath,
} from "../location";
import { type Location, locationSchema } from "../types";

const mod = testUuid("module");
const form = testUuid("form");
const group = testUuid("group");
const field = testUuid("field");
const op = testUuid("operation");
const link = testUuid("link");
const gone = testUuid("gone");
function fixture() {
	const doc = buildDoc({
		modules: [
			{
				uuid: mod,
				name: "Visits",
				caseType: "visit",
				forms: [
					{
						uuid: form,
						name: "Visit",
						type: "followup",
						fields: [
							f({
								uuid: group,
								kind: "group",
								id: "group",
								children: [f({ uuid: field, kind: "text", id: "name" })],
							}),
						],
					},
				],
			},
		],
	});
	doc.forms[form].caseOperations = [
		{
			uuid: op,
			id: "finish",
			action: "close",
			caseType: "visit",
			target: { kind: "session" },
		},
	];
	doc.forms[form].formLinks = [
		{ uuid: link, target: { type: "module", moduleUuid: mod } },
	];
	return doc;
}
const routes: { location: Location; path: string[] }[] = [
	{ location: { kind: "home" }, path: [] },
	{ location: { kind: "module", moduleUuid: mod }, path: [mod] },
	{ location: { kind: "cases", moduleUuid: mod }, path: [mod, "results"] },
	{
		location: {
			kind: "cases",
			moduleUuid: mod,
			caseId: "nova-case:external/1 %x+y",
		},
		path: [mod, "cases", "nova-case%3Aexternal%2F1%20%25x%2By"],
	},
	{
		location: { kind: "search-config", moduleUuid: mod },
		path: [mod, "search"],
	},
	{
		location: { kind: "detail-config", moduleUuid: mod },
		path: [mod, "details"],
	},
	{
		location: { kind: "data-review", moduleUuid: mod },
		path: [mod, "data-review"],
	},
	{
		location: { kind: "module-condition", moduleUuid: mod },
		path: [mod, "condition"],
	},
	{ location: { kind: "form", moduleUuid: mod, formUuid: form }, path: [form] },
	{
		location: {
			kind: "form",
			moduleUuid: mod,
			formUuid: form,
			selectedUuid: field,
		},
		path: [field],
	},
	{
		location: { kind: "form-condition", moduleUuid: mod, formUuid: form },
		path: [form, "condition"],
	},
	{
		location: { kind: "form-operations", moduleUuid: mod, formUuid: form },
		path: [form, "operations"],
	},
	{
		location: {
			kind: "form-operations",
			moduleUuid: mod,
			formUuid: form,
			operationUuid: op,
		},
		path: [form, "operations", op],
	},
	{
		location: { kind: "form-links", moduleUuid: mod, formUuid: form },
		path: [form, "links"],
	},
	{
		location: {
			kind: "form-links",
			moduleUuid: mod,
			formUuid: form,
			linkUuid: link,
		},
		path: [form, "links", link],
	},
];

describe("Builder location contract", () => {
	it.each(routes)(
		"serializes and parses $path, validates identity, and admits its presence location",
		({ location, path }) => {
			const doc = fixture();
			// Explicit paths prevent a serializer/parser round trip hiding mutual errors.
			expect(serializePath(location)).toEqual(path);
			expect(parsePathToLocation(path, doc)).toEqual(location);
			expect(isValidLocation(location, doc)).toBe(true);
			expect(recoverLocation(location, doc)).toBe(location);
			expect(locationSchema.parse(location)).toEqual(location);
		},
	);

	it.each(["cases", "search-config", "detail-config"])(
		"rejects retired %s authoring bookmarks",
		(token) => {
			expect(parsePathToLocation([mod, token], fixture())).toEqual({
				kind: "home",
			});
		},
	);

	it("keeps malformed opaque case segments literal and decodes valid segments exactly once", () => {
		expect(parsePathToLocation([mod, "cases", "100%legit"], fixture())).toEqual(
			{ kind: "cases", moduleUuid: mod, caseId: "100%legit" },
		);
		expect(parsePathToLocation([mod, "cases", "%252F"], fixture())).toEqual({
			kind: "cases",
			moduleUuid: mod,
			caseId: "%2F",
		});
		expect(
			parsePathToLocation([mod, "cases", "id", "extra"], fixture()),
		).toEqual({ kind: "home" });
	});

	it("resolves legacy nested selection and ignores a missing field segment", () => {
		expect(parsePathToLocation([form, field], fixture())).toEqual({
			kind: "form",
			moduleUuid: mod,
			formUuid: form,
			selectedUuid: field,
		});
		expect(parsePathToLocation([form, "missing"], fixture())).toEqual({
			kind: "form",
			moduleUuid: mod,
			formUuid: form,
		});
	});

	it("rejects unknown and orphaned owners, including a broken field ancestry", () => {
		const doc = fixture();
		for (const path of [
			["bogus"],
			[gone],
			[gone, "results"],
			[gone, "search"],
			[gone, "details"],
			[gone, "data-review"],
			[gone, "condition"],
			[gone, "links"],
			[gone, "operations"],
		]) {
			expect(parsePathToLocation(path, doc), path.join("/")).toEqual({
				kind: "home",
			});
		}
		const orphan = { ...doc, formOrder: {} };
		for (const path of [
			[form],
			[field],
			[form, "links"],
			[form, "operations"],
			[form, "condition"],
		]) {
			expect(parsePathToLocation(path, orphan), path.join("/")).toEqual({
				kind: "home",
			});
		}
		doc.fieldOrder[group] = [group, field];
		delete doc.fieldOrder[form];
		expect(parsePathToLocation([field], doc)).toEqual({ kind: "home" });
	});

	it.each([
		{ kind: "form-operations", token: "operations", selected: "operationUuid" },
		{ kind: "form-links", token: "links", selected: "linkUuid" },
	] as const)(
		"drops stale $kind selection while retaining its screen",
		({ kind, token, selected }) => {
			const doc = fixture();
			const list: Location = { kind, moduleUuid: mod, formUuid: form };
			const stale = { ...list, [selected]: gone };
			// Parsing admits a shaped identity; recovery checks that form's members.
			expect(parsePathToLocation([form, token, gone], doc)).toEqual(stale);
			expect(isValidLocation(stale, doc)).toBe(true);
			expect(recoverLocation(stale, doc)).toEqual(list);
			expect(parsePathToLocation([form, token, "not-a-uuid"], doc)).toEqual(
				list,
			);
			delete doc.forms[form].caseOperations;
			delete doc.forms[form].formLinks;
			expect(parsePathToLocation([form, token], doc)).toEqual(list);
			expect(recoverLocation(stale, doc)).toEqual(list);
			delete doc.forms[form];
			expect(isValidLocation(stale, doc)).toBe(false);
			expect(recoverLocation(stale, doc)).toEqual({
				kind: "module",
				moduleUuid: mod,
			});
			delete doc.modules[mod];
			expect(recoverLocation(stale, doc)).toEqual({ kind: "home" });
		},
	);

	it("keeps a legacy form URL on that form when its field belongs elsewhere", () => {
		const other = testUuid("other-form");
		const otherField = testUuid("other-field");
		const doc = buildDoc({
			modules: [
				{
					uuid: mod,
					name: "Visits",
					forms: [
						{
							uuid: form,
							name: "First",
							type: "survey",
							fields: [f({ uuid: field, kind: "text", id: "one" })],
						},
						{
							uuid: other,
							name: "Second",
							type: "survey",
							fields: [f({ uuid: otherField, kind: "text", id: "two" })],
						},
					],
				},
			],
		});
		expect(parsePathToLocation([form, otherField], doc)).toEqual({
			kind: "form",
			moduleUuid: mod,
			formUuid: form,
		});
		expect(parsePathToLocation([otherField], doc)).toEqual({
			kind: "form",
			moduleUuid: mod,
			formUuid: other,
			selectedUuid: otherField,
		});
	});

	it("requires valid location identities at the presence schema boundary", () => {
		for (const input of [
			{
				kind: "form",
				moduleUuid: mod,
				formUuid: form,
				selectedUuid: "missing",
			},
			{
				kind: "form-links",
				moduleUuid: mod,
				formUuid: form,
				operationUuid: op,
			},
			{
				kind: "form-operations",
				moduleUuid: mod,
				formUuid: form,
				linkUuid: link,
			},
			{ kind: "module-condition", moduleUuid: mod, formUuid: form },
		])
			expect(locationSchema.safeParse(input).success).toBe(false);
	});
});
