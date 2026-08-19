// The worker's own case: its shape, its contents, and what a re-sync writes.
//
// Three things, and the seam between them is the point. `usercaseCaseType` is
// the SCHEMA the case store materializes, derived from the worker-property
// catalog rather than declared beside it. `usercaseRecord` is the CONTENTS,
// and it is one derivation with two consumers — Preview answers `#user/<prop>`
// from it and the materializer writes it into the row — because `#user/`
// resolves from `casedb` on the wire, so the two disagreeing would make
// Preview answer differently from a device for any worker saved once.
// `usercaseChangedFields` is the DIFF, and it is the never-clobber contract
// that decides whether a form-written value survives the next persona edit.

import { describe, expect, it } from "vitest";
import type { PersistableDoc } from "@/lib/domain";
import {
	USERCASE_CASE_TYPE,
	usercaseCaseType,
	usercaseChangedFields,
	usercaseName,
	usercaseRecord,
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

	it("is a SUPERSET of every record any worker could produce", () => {
		// The bug this pins: the key list was derived by calling
		// `usercaseBuiltInValues` with a null project space, so the conditional
		// `commcare_project` key vanished from the case type while a
		// project-bearing sync still wrote it — and the insert was rejected by
		// its own schema with `additionalProperties`. The schema must admit
		// every key any record can carry, whatever this worker's facts are.
		const d = doc([{ uuid: "u-1", slug: "cadre", label: "Cadre" }]);
		const declared = new Set(names(d));
		for (const projectSpace of [null, "my-domain"]) {
			const record = usercaseRecord(
				{
					id: "p-1",
					username: "amara",
					personName: "Amara",
					email: "",
					locationIds: [],
				},
				{ "u-1": "nurse" },
				d,
				projectSpace,
			);
			for (const key of Object.keys(record)) {
				// `case_name` is the one key that is a column rather than a
				// property, so it is deliberately absent from the type.
				if (key === "case_name") continue;
				expect(declared.has(key), `${key} missing from the case type`).toBe(
					true,
				);
			}
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

describe("usercaseRecord", () => {
	const worker = {
		id: "persona-1",
		username: "Amara",
		personName: "Amara Diallo",
		email: "",
		locationIds: [],
	};

	it("layers built-ins over authored values, the way HQ does", () => {
		// `_get_user_case_fields` layers its own keys over `UserData.to_dict()`,
		// and nothing reserves the built-in names against the slug grammar, so
		// an author CAN declare `language`. HQ's answer, and ours, is that the
		// built-in wins.
		const d = doc([{ uuid: "u-1", slug: "language", label: "Language" }]);
		const record = usercaseRecord(worker, { "u-1": "Wolof" }, d, "my-domain");
		expect(record.language).toBe("");
	});

	it("carries a declared property with no value as present and empty", () => {
		// `UserData.to_dict()` seeds every schema field blank before applying
		// anything, so declared-but-empty and undeclared are different states
		// and a `= ''` comparison can tell them apart.
		const d = doc([{ uuid: "u-1", slug: "cadre", label: "Cadre" }]);
		const record = usercaseRecord(worker, {}, d, "my-domain");
		expect(record.cadre).toBe("");
		expect(Object.hasOwn(record, "undeclared")).toBe(false);
	});

	it("carries the assignment, most important place first", () => {
		// `_get_user_case_fields` writes all three in the same pass as every
		// other built-in, so they belong to the worker's facts rather than to an
		// overlay a caller remembers to apply. Nova has no separate
		// primary-sharing concept, so that key is the primary location.
		const assigned = usercaseRecord(
			{ ...worker, locationIds: ["place-a", "place-b"] },
			{},
			doc([]),
			"my-domain",
		);
		expect(assigned.commcare_location_id).toBe("place-a");
		expect(assigned.commcare_location_ids).toBe("place-a place-b");
		expect(assigned.commcare_primary_case_sharing_id).toBe("place-a");
	});

	it("carries the assignment keys present and empty for a worker with none", () => {
		// HQ's explicit `else ''` branch. Absent and empty answer differently to
		// a `= ''` comparison, and a device reading an unassigned worker gets
		// the empty one.
		const unassigned = usercaseRecord(worker, {}, doc([]), "my-domain");
		expect(unassigned.commcare_location_id).toBe("");
		expect(unassigned.commcare_location_ids).toBe("");
		expect(unassigned.commcare_primary_case_sharing_id).toBe("");
	});

	it("omits commcare_project when Nova does not know the project space", () => {
		// HQ writes the domain unconditionally, but a domain is never empty on
		// a device. Emitting "" would make `#user/commcare_project = ''` fire
		// in Preview and never in the field, which is the opposite of what an
		// absent key does.
		expect(
			Object.hasOwn(
				usercaseRecord(worker, {}, doc([]), null),
				"commcare_project",
			),
		).toBe(false);
		expect(
			usercaseRecord(worker, {}, doc([]), "my-domain").commcare_project,
		).toBe("my-domain");
	});
});

describe("usercaseChangedFields", () => {
	it("returns only what differs", () => {
		expect(
			usercaseChangedFields(
				{ cadre: "nurse", language: "" },
				{ cadre: "nurse", language: "en" },
			),
		).toEqual({ language: "en" });
	});

	it("never removes a key the stored row has and the desired record lacks", () => {
		// THE never-clobber contract. A form wrote `visits_done` through
		// `usercase_update`; a later persona edit must not erase it just
		// because the persona's own record has nothing to say about it.
		expect(
			usercaseChangedFields({ visits_done: "12" }, { cadre: "nurse" }),
		).toEqual({ cadre: "nurse" });
	});

	it("overwrites a form-written value when the persona edit names it", () => {
		// The other half: a property the persona DOES declare is the persona's
		// to set, so an edit that changes it wins over what a form left there.
		expect(
			usercaseChangedFields({ cadre: "driver" }, { cadre: "nurse" }),
		).toEqual({ cadre: "nurse" });
	});

	it("writes a key the stored row is missing entirely", () => {
		expect(usercaseChangedFields({}, { cadre: "nurse" })).toEqual({
			cadre: "nurse",
		});
	});

	it("settles rather than rewriting a row whose stored value is not a string", () => {
		// A JSONB read can return a number for a row written before every slot
		// was text. Comparing untouched would mark it changed on every sync,
		// forever.
		expect(usercaseChangedFields({ visits: 12 }, { visits: "12" })).toEqual({});
	});

	it("treats a stored null as absent rather than as the empty string", () => {
		// Null is the absence of a value; "" is a value HQ writes deliberately
		// for a declared-but-empty slot. Collapsing them would leave a declared
		// slot unwritten on a row that has never carried it.
		expect(usercaseChangedFields({ cadre: null }, { cadre: "" })).toEqual({
			cadre: "",
		});
	});
});

describe("usercaseName", () => {
	it("uses the worker's display name", () => {
		expect(
			usercaseName({
				id: "p-1",
				username: "amara",
				personName: "Amara Diallo",
			}),
		).toBe("Amara Diallo");
	});

	it("falls back to the login when the display name is blank", () => {
		// HQ's own fallback, `user.name or user.raw_username`. Nova needs it for
		// a second reason it cannot decline: `cases.case_name` is NOT NULL, so a
		// blank name is a failed INSERT rather than an ugly row.
		expect(
			usercaseName({
				id: "p-1",
				username: "amara",
				personName: "   ",
			}),
		).toBe("amara");
	});

	it("falls back to the id when the worker has neither", () => {
		expect(usercaseName({ id: "p-1", username: "", personName: "" })).toBe(
			"p-1",
		);
	});

	it("normalizes through the same scalar contract every other case write uses", () => {
		// The contract is Java `String.trim()` — boundary code units U+0000
		// through U+0020, NOT regex whitespace — because CommCare Core is what
		// trims the value in the field. A zero-width space (U+200B) is
		// deliberately NOT stripped, here or on an authored case name; the
		// worker's case must not be the one row in the store that normalizes
		// differently from the rest.
		expect(
			usercaseName({
				id: "p-1",
				username: "amara",
				personName: "\u0001Amara\u0002",
			}),
		).toBe("Amara");
		expect(
			usercaseName({
				id: "p-1",
				username: "amara",
				personName: "\u200bAmara",
			}),
		).toBe("\u200bAmara");
	});
});
