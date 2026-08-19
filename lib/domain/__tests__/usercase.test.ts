// The worker's own case, as a case type rather than a projection.
//
// The projection half (`usercaseBuiltInValues`, `declaredUsercaseSlots`) is
// covered where its consumer is, in the preview identity suite. What is new
// here is the SCHEMA: `commcare-user` as something the case store can
// materialize, whose shape is derived from the worker-property catalog rather
// than declared beside it.

import { describe, expect, it } from "vitest";
import type { PersistableDoc } from "@/lib/domain";
import {
	USERCASE_CASE_TYPE,
	usercaseCaseType,
	usercaseValuesBySlug,
} from "@/lib/domain";

function doc(
	properties: ReadonlyArray<{ uuid: string; slug: string; label: string }>,
): PersistableDoc {
	return {
		appId: "app-usercase",
		appName: "Usercase",
		connectType: null,
		caseTypes: [],
		modules: {},
		forms: {},
		fields: {},
		moduleOrder: [],
		formOrder: {},
		fieldOrder: {},
		userProperties: Object.fromEntries(
			properties.map((property) => [property.uuid, property]),
		),
	} as unknown as PersistableDoc;
}

const names = (d: PersistableDoc): string[] =>
	usercaseCaseType(d).properties.map((property) => property.name);

describe("usercaseCaseType", () => {
	it("is named for CommCare's own case type", () => {
		expect(usercaseCaseType(doc([])).name).toBe(USERCASE_CASE_TYPE);
		expect(USERCASE_CASE_TYPE).toBe("commcare-user");
	});

	it("carries the built-ins HQ writes on every worker's case", () => {
		// `_get_user_case_fields` writes these whatever the app declared, so
		// they are on the case type even for an app with no worker properties.
		expect(names(doc([]))).toEqual(
			expect.arrayContaining([
				"username",
				"first_name",
				"last_name",
				"hq_user_id",
				"language",
				"phone_number",
			]),
		);
	});

	it("leaves out case_name, which is the case's name and not a property", () => {
		// HQ's writers pop `name` straight into `case_name=`, so it never
		// reaches `<update>`, and `get_usercase_properties` lists no `name`.
		// Nova's storage agrees for its own reason: `case_name` is a first-class
		// column (`RESERVED_SCALAR_COLUMN_BY_PROPERTY`), so listing it as a
		// property would claim a JSONB key that nothing reads.
		expect(names(doc([]))).not.toContain("case_name");
		expect(names(doc([]))).not.toContain("name");
	});

	it("leaves external_id off, because HQ never writes it", () => {
		// HQ FINDS a usercase by external id but never writes one
		// (`_get_user_case_fields` sets it nowhere, `create_usercase` passes it
		// nowhere). Writing it would make `external_id = ''` answer one way in
		// Preview and the other in the field.
		expect(names(doc([]))).not.toContain("external_id");
	});

	it("derives a slot per declared worker property", () => {
		const withProperties = doc([
			{ uuid: "u-1", slug: "clinic_code", label: "Clinic code" },
			{ uuid: "u-2", slug: "cadre", label: "Cadre" },
		]);
		expect(names(withProperties)).toEqual(
			expect.arrayContaining(["clinic_code", "cadre"]),
		);
	});

	it("gives every slot the text type, because HQ stores user data as strings", () => {
		const withProperties = doc([
			{ uuid: "u-1", slug: "clinic_code", label: "Clinic code" },
		]);
		for (const property of usercaseCaseType(withProperties).properties) {
			expect(property.data_type).toBe("text");
		}
	});

	it("emits each name once when a worker property shadows a built-in", () => {
		// The slug grammar does not reserve the built-in names, so an author
		// can declare `language`. One property per name or the schema carries a
		// duplicate JSONB key.
		const shadowing = doc([
			{ uuid: "u-1", slug: "language", label: "Preferred language" },
		]);
		const emitted = names(shadowing);
		expect(emitted.filter((name) => name === "language")).toHaveLength(1);
	});
});

describe("usercaseValuesBySlug", () => {
	it("re-keys authored values from property uuid to current slug", () => {
		const d = doc([{ uuid: "u-1", slug: "cadre", label: "Cadre" }]);
		expect(usercaseValuesBySlug({ "u-1": "nurse" }, d)).toEqual({
			cadre: "nurse",
		});
	});

	it("drops a value whose property no longer exists", () => {
		// A removed property leaves its stored value behind. Emitting it under
		// a stale key would put a property on the worker's case that the app no
		// longer declares.
		const d = doc([{ uuid: "u-1", slug: "cadre", label: "Cadre" }]);
		expect(usercaseValuesBySlug({ "u-gone": "orphan" }, d)).toEqual({});
	});
});
