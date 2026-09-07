// Slug admission, collection grammar, and pure persona-default projection.
// HQ source grounds the policy; these tests do not execute HQ account writes.

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { expectAdmittedDoc } from "@/lib/agent/__tests__/admittedFixture";
import { userPropertySlugVerdict } from "@/lib/commcare/validator/userPropertySlug";
import {
	BUILT_IN_USER_PROPERTIES,
	blueprintDocSchema,
	personasOf,
	personaUserData,
	USER_DATA_SYSTEM_FIELDS,
	USER_PROPERTY_SLUG_MAX_LENGTH,
	type UserCollections,
	userDataValuesSchema,
	userPropertiesOf,
	userPropertySchema,
	userTypesOf,
} from "@/lib/domain";

const NONE: ReadonlySet<string> = new Set();

describe("the built-in catalog is also the reserved-name list", () => {
	it("refuses every slug CommCare injects, with no second list to maintain", () => {
		for (const property of BUILT_IN_USER_PROPERTIES) {
			const verdict = userPropertySlugVerdict(property.slug, NONE);
			expect(verdict.ok, `"${property.slug}" should be reserved`).toBe(false);
		}
	});

	it("marks the project slug as needing a deployment target", () => {
		const project = BUILT_IN_USER_PROPERTIES.find(
			(p) => p.slug === "commcare_project",
		);
		expect(project?.availability).toBe("needs-deployment-target");
	});
});

describe("slug admission and case-insensitive uniqueness", () => {
	it("accepts the Django slug charset", () => {
		for (const slug of [
			"region",
			"Region",
			"team_lead",
			"sub-district",
			"district-code",
			"a1",
		]) {
			expect(userPropertySlugVerdict(slug, NONE).ok, slug).toBe(true);
		}
	});

	it("requires an XML element-name-safe first character", () => {
		for (const slug of ["2fa_region", "-area"]) {
			expect(userPropertySlugVerdict(slug, NONE), slug).toMatchObject({
				ok: false,
				code: "illegal_format",
			});
		}
		expect(userPropertySlugVerdict("_2fa-region", NONE).ok).toBe(true);
	});

	it("refuses characters outside that charset", () => {
		for (const slug of ["my region", "region!", "région", "a.b", "a/b"]) {
			expect(userPropertySlugVerdict(slug, NONE).ok, slug).toBe(false);
		}
	});

	it("refuses an all-digit slug", () => {
		// `edit_model.py::XmlSlugField`'s `RegexValidator(r'\\D', '')` demands
		// at least one non-digit; digits alone break the XML element name.
		expect(userPropertySlugVerdict("2026", NONE)).toMatchObject({
			ok: false,
			code: "all_digits",
		});
		expect(userPropertySlugVerdict("y2026", NONE).ok).toBe(true);
	});

	it("refuses the reserved prefixes", () => {
		expect(userPropertySlugVerdict("commcare_region", NONE)).toMatchObject({
			ok: false,
			code: "reserved",
		});
		expect(userPropertySlugVerdict("CommCare_region", NONE)).toMatchObject({
			ok: false,
			code: "reserved",
		});
		expect(userPropertySlugVerdict("xmlish", NONE)).toMatchObject({
			ok: false,
			code: "reserved",
		});
		expect(userPropertySlugVerdict("XMLish", NONE)).toMatchObject({
			ok: false,
			code: "reserved",
		});
	});

	it("refuses every system field", () => {
		for (const slug of USER_DATA_SYSTEM_FIELDS) {
			expect(userPropertySlugVerdict(slug, NONE).ok, slug).toBe(false);
			expect(
				userPropertySlugVerdict(slug.toUpperCase(), NONE).ok,
				slug.toUpperCase(),
			).toBe(false);
		}
	});

	it("refuses a CommCare case-reserved word", () => {
		// `edit_model.py::CustomDataFieldsForm.verify_no_reserved_words` checks
		// the same list the case-property rules use.
		for (const slug of ["case_id", "opened_on", "status", "parent"]) {
			expect(userPropertySlugVerdict(slug, NONE).ok, slug).toBe(false);
		}
	});

	it("caps the slug at the supported column width", () => {
		const atCap = "a".repeat(USER_PROPERTY_SLUG_MAX_LENGTH);
		expect(userPropertySlugVerdict(atCap, NONE).ok).toBe(true);
		expect(userPropertySlugVerdict(`${atCap}a`, NONE)).toMatchObject({
			ok: false,
			code: "too_long",
		});
	});

	it("treats uniqueness case-insensitively, as HQ's duplicate check does", () => {
		const taken = new Set(["Region"]);
		expect(userPropertySlugVerdict("region", taken)).toMatchObject({
			ok: false,
			code: "duplicate",
		});
		expect(userPropertySlugVerdict("district", taken).ok).toBe(true);
	});
});

describe("personaUserData", () => {
	const REGION = testUuid("11111111-1111-4111-8111-111111111111");
	const CADRE = testUuid("22222222-2222-4222-8222-222222222222");
	const CHW = testUuid("33333333-3333-4333-8333-333333333333");

	const doc = buildDoc({
		modules: [
			{
				name: "Survey",
				forms: [
					{
						name: "Intake",
						type: "survey",
						fields: [f({ kind: "text", id: "note", label: "Note" })],
					},
				],
			},
		],
	});
	doc.userProperties = {
		[REGION]: { uuid: REGION, slug: "region", label: "Region" },
		[CADRE]: { uuid: CADRE, slug: "cadre", label: "Cadre" },
	};
	doc.userPropertyOrder = [REGION, CADRE];
	doc.userTypes = {
		[CHW]: {
			uuid: CHW,
			name: "CHW",
			values: { [REGION]: "north", [CADRE]: "community" },
		},
	};
	doc.userTypeOrder = [CHW];

	it("layers the persona's own values over its role's defaults", () => {
		expectAdmittedDoc(doc);
		expect(
			personaUserData(
				{
					uuid: testUuid("44444444-4444-4444-8444-444444444444"),
					name: "Asha",
					userTypeUuid: CHW,
					values: { [REGION]: "south" },
				},
				doc,
			),
		).toEqual({ [REGION]: "south", [CADRE]: "community" });
	});

	it("is just the persona's own values when it holds no role", () => {
		expectAdmittedDoc(doc);
		expect(
			personaUserData(
				{
					uuid: testUuid("44444444-4444-4444-8444-444444444444"),
					name: "Asha",
					values: { [REGION]: "south" },
				},
				doc,
			),
		).toEqual({ [REGION]: "south" });
	});

	it("ignores an inherited role even when its UUID is otherwise valid", () => {
		const role = { uuid: CHW, name: "CHW", values: { [REGION]: "north" } };
		const inherited: UserCollections = {
			userTypes: Object.create({ [CHW]: role }),
		};
		const persona = {
			uuid: testUuid("persona-inherited"),
			name: "Asha",
			userTypeUuid: CHW,
		};
		expect(personaUserData(persona, inherited)).toEqual({});
		expect(personaUserData(persona, { userTypes: { [CHW]: role } })).toEqual({
			[REGION]: "north",
		});
	});
});

describe("user property accepted values", () => {
	it("rejects duplicate values at the domain schema boundary", () => {
		expect(
			userPropertySchema.safeParse({
				uuid: testUuid("property"),
				slug: "region",
				label: "Region",
				choices: ["north", "south"],
			}).success,
		).toBe(true);
		expect(
			userPropertySchema.safeParse({
				uuid: testUuid("property"),
				slug: "region",
				label: "Region",
				choices: ["north", "north"],
			}).success,
		).toBe(false);
	});
});

describe("prototype-safe user record parsing", () => {
	it("returns fresh null-prototype fallbacks with no inherited identities", () => {
		for (const read of [userPropertiesOf, userTypesOf, personasOf]) {
			const first = read({});
			const second = read({});
			expect(first).not.toBe(second);
			expect(Object.getPrototypeOf(first)).toBeNull();
			expect(Object.hasOwn(first, "constructor")).toBe(false);
			expect(Object.hasOwn(first, "__proto__")).toBe(false);
			expect(first.constructor).toBeUndefined();
		}
	});

	it("accepts only canonical property UUID keys in value bags", () => {
		const north = testUuid("__proto__");
		const south = testUuid("constructor");
		const values = Object.fromEntries([
			[north, "north"],
			[south, "south"],
		]);

		const parsed = userDataValuesSchema.parse(values);
		expect(Object.keys(parsed).sort()).toEqual([north, south].sort());
		expect(Object.getPrototypeOf(parsed)).toBeNull();
		expect(parsed[north]).toBe("north");
		expect(parsed[south]).toBe("south");
		for (const key of ["__proto__", "constructor", "toString"]) {
			expect(
				userDataValuesSchema.safeParse(Object.fromEntries([[key, "north"]]))
					.success,
			).toBe(false);
		}
		expect(
			userDataValuesSchema.parse(Object.create({ [north]: "inherited" })),
		).toEqual({});
	});

	it("preserves canonical collection UUIDs and their value bindings through JSON admission", () => {
		const propertyUuid = testUuid("__proto__");
		const typeUuid = testUuid("constructor");
		const personaUuid = testUuid("toString");
		const { fieldParent: _derived, ...persistable } = buildDoc({
			appName: "Worker identities",
			modules: [],
		});
		const wire = {
			...persistable,
			userProperties: Object.fromEntries([
				[
					propertyUuid,
					{
						uuid: propertyUuid,
						slug: "region",
						label: "Region",
					},
				],
			]),
			userPropertyOrder: [propertyUuid],
			userTypes: Object.fromEntries([
				[
					typeUuid,
					{
						uuid: typeUuid,
						name: "CHW",
						values: Object.fromEntries([[propertyUuid, "north"]]),
					},
				],
			]),
			userTypeOrder: [typeUuid],
			personas: Object.fromEntries([
				[
					personaUuid,
					{
						uuid: personaUuid,
						name: "Asha",
						userTypeUuid: typeUuid,
					},
				],
			]),
			personaOrder: [personaUuid],
		};

		const parsed = blueprintDocSchema.parse(JSON.parse(JSON.stringify(wire)));
		expect(Object.hasOwn(parsed.userProperties ?? {}, propertyUuid)).toBe(true);
		expect(Object.hasOwn(parsed.userTypes ?? {}, typeUuid)).toBe(true);
		expect(Object.hasOwn(parsed.personas ?? {}, personaUuid)).toBe(true);
		expect(
			Object.hasOwn(parsed.userTypes?.[typeUuid]?.values ?? {}, propertyUuid),
		).toBe(true);
	});
});
