// Client-side projection and typed-result contracts.
// Synthetic rows exercise coercion directly; database behavior belongs to the Postgres suite.
import { describe, expect, it } from "vitest";
import {
	CaptureSubmissionRejectedError,
	CaseNotFoundError,
	CasePropertiesValidationError,
	type CasePropertyFailure,
	type CaseRow,
	CaseTypeNotInBlueprintError,
	type JsonObject,
	SchemaNotSyncedError,
} from "@/lib/case-store";
import { buildSimpleBlueprint } from "@/lib/case-store/__tests__/fixtures/simpleBlueprint";
import type { CaseType } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import {
	caseDatabaseToFormPreloads,
	caseRowDisplayValue,
	caseRowsToFormPreloads,
	caseRowToFormPreload,
	mapFilterPreviewError,
	mapPopulateSampleCasesError,
	mapSubmitFormError,
	pickBlueprintDoc,
} from "../caseDataBindingClient";

const APP_ID = "app-binding";

const OWNER_A = "owner-a";

const ALICE_CASE_ID = "40000000-0000-0000-0000-000000000001";

const PATIENT_CASE_TYPE: CaseType = {
	name: "patient",
	properties: [{ name: "age", label: proseText("Age"), data_type: "int" }],
};

const _VISIT_CASE_TYPE: CaseType = {
	name: "visit",
	parent_type: "patient",
	properties: [{ name: "notes", label: proseText("Notes"), data_type: "text" }],
};

const _HOUSEHOLD_CASE_TYPE: CaseType = {
	name: "household",
	properties: [{ name: "head_name", label: proseText("Head of household") }],
};

const _FORMATTED_PROPS_CASE_TYPE: CaseType = {
	name: "patient",
	properties: [
		{ name: "age", label: proseText("Age"), data_type: "int" },
		{ name: "weight", label: proseText("Weight"), data_type: "decimal" },
		{ name: "dob", label: proseText("DOB"), data_type: "date" },
		{ name: "wake_time", label: proseText("Wake time"), data_type: "time" },
		{ name: "last_seen", label: proseText("Last seen"), data_type: "datetime" },
		{ name: "home_location", label: proseText("Home"), data_type: "geopoint" },
	],
};

function buildSyntheticRow(properties: JsonObject): CaseRow {
	return {
		case_id: "test-id",
		app_id: APP_ID,
		case_type: "patient",
		owner_id: OWNER_A,
		status: "open",
		opened_on: null,
		modified_on: null,
		closed_on: null,
		case_name: "Synthetic Case",
		external_id: null,
		parent_case_id: null,
		properties,
	};
}

describe("caseRowToFormPreload", () => {
	it("coerces every JsonValue branch to its string form", () => {
		const row = buildSyntheticRow({
			str_prop: "hello",
			num_prop: 42,
			bool_prop: true,
			null_prop: null,
			array_prop: ["a", "b"],
			object_prop: { nested: "value" },
		});

		const preload = caseRowToFormPreload(row);
		expect(preload.get("str_prop")).toBe("hello");
		expect(preload.get("num_prop")).toBe("42");
		// Booleans stringify via String() — `true` / `false` become
		// `"true"` / `"false"`.
		expect(preload.get("bool_prop")).toBe("true");
		// `null` collapses to the empty string — the form engine
		// treats absent and empty as the same domain state.
		expect(preload.get("null_prop")).toBe("");
		// Arrays are multi_select values and preload in the FORM value
		// convention — space-separated tokens (`SelectMultiField` splits
		// on " ", and submit's coerceValueForProperty splits on /\s+/) —
		// so the stored selections round-trip: options render checked and
		// an untouched submit writes the same array back.
		expect(preload.get("array_prop")).toBe("a b");
		expect(preload.get("object_prop")).toBe('{"nested":"value"}');
	});
});

describe("caseRowsToFormPreloads", () => {
	it("binds each reachable namespace to the row at its blueprint depth", () => {
		const patient = {
			...buildSyntheticRow({}),
			case_type: "patient",
			case_name: "Alice",
		};
		const household = {
			...buildSyntheticRow({ head_name: "John Smith" }),
			case_id: "test-household",
			case_type: "household",
		};

		const byType = caseRowsToFormPreloads(
			patient,
			[household],
			[
				{ name: "patient", depth: 0 },
				{ name: "household", depth: 1 },
			],
		);
		expect([...byType.keys()]).toEqual(["patient", "household"]);
		expect(byType.get("patient")?.get("case_name")).toBe("Alice");
		expect(byType.get("household")?.get("head_name")).toBe("John Smith");
		// Canonical scalar names flatten per row — an ancestor's
		// `case_id` is addressable as `#household/case_id`.
		expect(byType.get("household")?.get("case_id")).toBe("test-household");
	});

	it("binds by depth, not row type — the wire's positional walk", () => {
		// Blueprint chain visit → patient → household, but the live data
		// chain skips a level (visit's parent IS a household row — data
		// predating a hierarchy edit, or a re-parented case). The wire's
		// `index/parent × depth` walk has NO case-type filter: depth 1
		// lands on the household row for #patient refs, and depth 2
		// walks past the chain's end for #household refs. The preview
		// must read the same rows, not same-named rows elsewhere.
		const visit = {
			...buildSyntheticRow({ notes: "initial" }),
			case_type: "visit",
		};
		const household = {
			...buildSyntheticRow({ head_name: "John Smith" }),
			case_id: "test-household",
			case_type: "household",
		};

		const byType = caseRowsToFormPreloads(
			visit,
			[household],
			[
				{ name: "visit", depth: 0 },
				{ name: "patient", depth: 1 },
				{ name: "household", depth: 2 },
			],
		);
		expect(byType.get("visit")?.get("notes")).toBe("initial");
		expect(byType.get("patient")?.get("head_name")).toBe("John Smith");
		expect(byType.has("household")).toBe(false);
	});

	it("addresses the loaded case at depth 0 on a self-parented chain", () => {
		// `reachableCaseTypes`' cycle guard emits a self-parented type
		// once, at depth 0 — so the deeper same-type row is unaddressed,
		// matching the wire (where #person/ refs always mean the loaded
		// case).
		const person = {
			...buildSyntheticRow({ nickname: "child" }),
			case_type: "person",
		};
		const parentPerson = {
			...buildSyntheticRow({ nickname: "parent" }),
			case_id: "test-parent",
			case_type: "person",
		};

		const byType = caseRowsToFormPreloads(
			person,
			[parentPerson],
			[{ name: "person", depth: 0 }],
		);
		expect(byType.get("person")?.get("nickname")).toBe("child");
		expect(byType.size).toBe(1);
	});

	it("reconstructs the positional parent chain from one captured device database", () => {
		const patient = {
			...buildSyntheticRow({ risk: "high" }),
			case_id: "patient-1",
			case_type: "patient",
		};
		const household = {
			...buildSyntheticRow({ district: "north" }),
			case_id: "household-1",
			case_type: "household",
		};
		const result = caseDatabaseToFormPreloads(
			{
				rows: [patient, household],
				indices: [
					{
						case_id: "patient-1",
						ancestor_id: "household-1",
						identifier: "parent",
						depth: 1,
					},
				],
			},
			"patient-1",
			[
				{ name: "patient", depth: 0 },
				{ name: "household", depth: 1 },
			],
		);

		expect(result?.get("patient")?.get("risk")).toBe("high");
		expect(result?.get("household")?.get("district")).toBe("north");
		expect(
			caseDatabaseToFormPreloads(
				{ rows: [household], indices: [] },
				"patient-1",
				[{ name: "patient", depth: 0 }],
			),
		).toBeUndefined();
	});
});

describe("caseRowDisplayValue", () => {
	it("coerces every JsonValue branch to its display string", () => {
		const row = buildSyntheticRow({
			bool_prop: false,
			null_prop: null,
			array_prop: [1, 2, 3],
			object_prop: { a: 1, b: "two" },
		});

		expect(caseRowDisplayValue(row, "bool_prop")).toBe("false");
		expect(caseRowDisplayValue(row, "null_prop")).toBe("");
		expect(caseRowDisplayValue(row, "array_prop")).toBe("[1,2,3]");
		expect(caseRowDisplayValue(row, "object_prop")).toBe('{"a":1,"b":"two"}');
	});

	// Each canonical scalar column has a dedicated dispatch arm so the
	// helper reads the authoritative column rather than the JSONB document.
	it.each([
		["case_id", "real-row-id"],
		["case_type", "patient"],
		["owner_id", "real-owner"],
		["status", "open"],
		["case_name", "Real Name"],
	])(
		"caseRowDisplayValue resolves canonical scalar %s from its column",
		(field, columnValue) => {
			const row: CaseRow = {
				case_id: field === "case_id" ? columnValue : "test-id",
				app_id: APP_ID,
				case_type: field === "case_type" ? columnValue : "patient",
				owner_id: field === "owner_id" ? columnValue : OWNER_A,
				status: field === "status" ? columnValue : "open",
				opened_on: null,
				modified_on: null,
				closed_on: null,
				case_name: field === "case_name" ? columnValue : "Synthetic Case",
				external_id: null,
				parent_case_id: null,
				properties: {},
			};
			expect(caseRowDisplayValue(row, field)).toBe(columnValue);
		},
	);

	it("resolves only Nova's exact canonical names onto scalar columns", () => {
		const opened = new Date("2026-01-02T03:04:05.000Z");
		const modified = new Date("2026-02-03T04:05:06.000Z");
		const row: CaseRow = {
			case_id: "test-id",
			app_id: APP_ID,
			case_type: "patient",
			owner_id: OWNER_A,
			status: "open",
			opened_on: opened,
			modified_on: modified,
			closed_on: null,
			case_name: "Real Name",
			external_id: "EXT-1",
			parent_case_id: null,
			properties: {},
		};
		expect(caseRowDisplayValue(row, "case_name")).toBe("Real Name");
		expect(caseRowDisplayValue(row, "external_id")).toBe("EXT-1");
		expect(caseRowDisplayValue(row, "date_opened")).toBe(opened.toISOString());
		expect(caseRowDisplayValue(row, "last_modified")).toBe(
			modified.toISOString(),
		);
	});

	it.each([["owner_id"], ["status"]])(
		"caseRowDisplayValue surfaces null for nullable reserved column %s",
		(field) => {
			// `owner_id` and `status` are nullable on `cases`; the
			// helper coerces a `null` column read to the empty string
			// (consistent with `jsonValueToString`'s `null` arm) so
			// case-list table cells render empty rather than the literal
			// "null".
			const row: CaseRow = {
				case_id: "test-id",
				app_id: APP_ID,
				case_type: "patient",
				owner_id: field === "owner_id" ? null : OWNER_A,
				status: field === "status" ? null : "open",
				opened_on: null,
				modified_on: null,
				closed_on: null,
				case_name: "Synthetic Case",
				external_id: null,
				parent_case_id: null,
				properties: {},
			};
			expect(caseRowDisplayValue(row, field)).toBe("");
		},
	);
});

describe("pickBlueprintDoc", () => {
	it("strips function-typed extras off a doc-store-shaped state", () => {
		// `BlueprintDocState` (the doc store's shape) carries action
		// methods alongside the data fields. Server Actions reject
		// function values during RSC serialization, so the
		// projection has to drop them. Verify by extending a
		// `BlueprintDoc` with a function-typed key and checking it's
		// absent from the result.
		const blueprint = buildSimpleBlueprint([PATIENT_CASE_TYPE], APP_ID);
		const stateShaped = {
			...blueprint,
			// Synthetic action method the projection must strip.
			applyMany: () => {
				/* no-op */
			},
		};
		const projected = pickBlueprintDoc(stateShaped) as Record<string, unknown>;
		expect(projected.applyMany).toBeUndefined();
	});

	it("preserves every BlueprintDoc data field including fieldParent", () => {
		// `BlueprintDoc` extends `PersistableDoc` (the schema-defined
		// shape) with `fieldParent` (in-memory only, derived from
		// `fieldOrder`). The projection re-attaches `fieldParent` from
		// the source state so the running-app `loadCasesAction` (which
		// never parses) can read it; the parsing preview actions strip
		// it back off before their `.strict()` parse via
		// `toPersistableDoc`. Verify the reverse-index round-trips here.
		const blueprint = buildSimpleBlueprint([PATIENT_CASE_TYPE], APP_ID);
		const withFieldParent = {
			...blueprint,
			fieldParent: { "child-uuid": "parent-uuid" },
		};
		const projected = pickBlueprintDoc(withFieldParent);
		expect(projected).toEqual(withFieldParent);
	});
});

describe("mapFilterPreviewError", () => {
	// Typed case-store errors get stable result arms for the inspector.

	it("maps CaseTypeNotInBlueprintError to the missing-case-type arm", () => {
		const err = new CaseTypeNotInBlueprintError("app-1", "patient");
		expect(mapFilterPreviewError(err)).toEqual({
			kind: "missing-case-type",
			caseType: "patient",
		});
	});

	it("maps SchemaNotSyncedError to the schema-not-synced arm", () => {
		const err = new SchemaNotSyncedError("app-1", "patient");
		expect(mapFilterPreviewError(err)).toEqual({
			kind: "schema-not-synced",
			caseType: "patient",
		});
	});

	it("falls through to the generic error arm for an unrelated Error", () => {
		const err = new Error("connection refused");
		const result = mapFilterPreviewError(err);
		expect(result.kind).toBe("error");
		if (result.kind !== "error") return;
		expect(result.message).toBe("connection refused");
	});

	it("falls through to the generic error arm with a default message for non-Error throws", () => {
		const result = mapFilterPreviewError("some string");
		expect(result.kind).toBe("error");
		if (result.kind !== "error") return;
		expect(result.message).toMatch(/\S/);
	});
});

describe("mapPopulateSampleCasesError", () => {
	// The Server Action's catch block delegates to this helper so
	// the typed-error → typed-result-arm mapping is testable
	// without driving `getSession` + `withProjectContext`. The
	// integration tests above already exercise the round-trip
	// through `seedSampleCases`; these tests pin the discriminator
	// shape one more layer down.

	it("maps CaseTypeNotInBlueprintError to the missing-case-type arm carrying the case type", () => {
		const err = new CaseTypeNotInBlueprintError("app-1", "patient");
		const result = mapPopulateSampleCasesError(err);
		expect(result).toEqual({ kind: "missing-case-type", caseType: "patient" });
	});

	it("maps SchemaNotSyncedError to the schema-not-synced arm carrying the case type", () => {
		const err = new SchemaNotSyncedError("app-1", "patient");
		const result = mapPopulateSampleCasesError(err);
		expect(result).toEqual({ kind: "schema-not-synced", caseType: "patient" });
	});

	it("maps CasePropertiesValidationError to the validation-failure arm carrying the structured failures", () => {
		// AJV's per-field failure list is the user-actionable shape;
		// the mapping helper preserves it verbatim onto the arm so
		// the consumer renders one entry per offending field. Without
		// this branch, the running-app view's error toast would show
		// the wrapped invariant body (internal vocabulary), defeating
		// the typed-error pattern's purpose.
		const failures: ReadonlyArray<CasePropertyFailure> = [
			{ path: "/age", message: "must be integer" },
			{ path: "/age", message: "must NOT have fewer than 1 characters" },
		];
		const err = new CasePropertiesValidationError("app-1", "patient", failures);
		const result = mapPopulateSampleCasesError(err);
		expect(result).toEqual({
			kind: "validation-failure",
			caseType: "patient",
			failures,
		});
	});

	it("falls through to the generic error arm for an unrelated Error instance", () => {
		const err = new Error("connection refused");
		const result = mapPopulateSampleCasesError(err);
		expect(result.kind).toBe("error");
		if (result.kind !== "error") return;
		expect(result.message).toBe("connection refused");
	});

	it("falls through to the generic error arm with a default message for non-Error throws", () => {
		// JS allows `throw "foo"`. The case-store doesn't, but the
		// catch block has to handle every shape — RSC framework
		// errors in particular can surface as non-Error objects.
		const result = mapPopulateSampleCasesError("some string");
		expect(result.kind).toBe("error");
		if (result.kind !== "error") return;
		expect(result.message).toMatch(/\S/);
	});

	// `CaseTypeNotInBlueprintError` is no longer thrown by
	// `seedSampleCases` itself — the helper accepts the resolved
	// `CaseType` directly, so the missing-from-blueprint case lives
	// at the Server Action layer (`populateSampleCasesAction`'s
	// boundary resolution). The synthetic mapping test above already
	// pins the typed-arm shape.
});

describe("mapSubmitFormError", () => {
	// Synthetic-error mapping — same shape as the
	// `mapPopulateSampleCasesError` block above. The Server Action's
	// catch block delegates to this helper so the typed-error →
	// typed-result-arm translation is testable without driving
	// `getSession` / `withProjectContext`.

	it("maps a capture admission rejection to its safe user-facing message", () => {
		const err = new CaptureSubmissionRejectedError(
			"This form entry was already submitted.",
		);
		expect(mapSubmitFormError(err)).toEqual({
			kind: "error",
			message: "This form entry was already submitted.",
		});
	});

	it("maps CaseNotFoundError to the case-not-found arm carrying the case id", () => {
		const err = new CaseNotFoundError(ALICE_CASE_ID);
		expect(mapSubmitFormError(err)).toEqual({
			kind: "case-not-found",
			caseId: ALICE_CASE_ID,
		});
	});

	it("maps CasePropertiesValidationError to the case-properties-validation arm carrying the failures", () => {
		const failures: ReadonlyArray<CasePropertyFailure> = [
			{ path: "/age", message: "must be integer" },
		];
		const err = new CasePropertiesValidationError(APP_ID, "patient", failures);
		expect(mapSubmitFormError(err)).toEqual({
			kind: "case-properties-validation",
			caseType: "patient",
			failures,
		});
	});

	it("maps CaseTypeNotInBlueprintError to the missing-case-type arm", () => {
		const err = new CaseTypeNotInBlueprintError(APP_ID, "patient");
		expect(mapSubmitFormError(err)).toEqual({
			kind: "missing-case-type",
			caseType: "patient",
		});
	});

	it("maps SchemaNotSyncedError to the schema-not-synced arm", () => {
		const err = new SchemaNotSyncedError(APP_ID, "patient");
		expect(mapSubmitFormError(err)).toEqual({
			kind: "schema-not-synced",
			caseType: "patient",
		});
	});

	it("falls through to the generic error arm for an unrelated Error instance", () => {
		const result = mapSubmitFormError(new Error("connection refused"));
		expect(result).toEqual({
			kind: "error",
			message: "connection refused",
		});
	});

	it("falls through to the generic error arm with a default message for non-Error throws", () => {
		// JS allows `throw "string"`; RSC framework errors can surface
		// as non-Error objects. The helper handles both.
		const result = mapSubmitFormError("plain string");
		expect(result).toEqual({
			kind: "error",
			message: expect.stringMatching(/\S/),
		});
	});
});

describe("caseRowToFormPreload scalar vocabulary", () => {
	it("flattens custom JSONB values and canonical scalar columns into one string-valued Map", () => {
		const opened = new Date("2026-01-02T03:04:05.000Z");
		const modified = new Date("2026-02-03T04:05:06.000Z");
		const row: CaseRow = {
			...buildSyntheticRow({ clinic_name: "Alice", age: 30 }),
			case_name: "Canonical case name",
			opened_on: opened,
			modified_on: modified,
		};

		const preload = caseRowToFormPreload(row);

		expect(preload.get("clinic_name")).toBe("Alice");
		expect(preload.get("case_name")).toBe("Canonical case name");
		expect(preload.get("age")).toBe("30");
		expect(preload.get("case_id")).toBe(row.case_id);
		expect(preload.get("status")).toBe("open");
		expect(preload.get("date_opened")).toBe(opened.toISOString());
		expect(preload.get("last_modified")).toBe(modified.toISOString());
	});
});

describe("caseRowDisplayValue scalar vocabulary", () => {
	it.each(["name", "external-id", "date-opened"])(
		"keeps retired spelling %s out of the live scalar-name map",
		(property) => {
			expect(caseRowToFormPreload(buildSyntheticRow({})).has(property)).toBe(
				false,
			);
		},
	);

	it("reads ordinary custom JSONB properties and renders an absent property as empty", () => {
		const row = buildSyntheticRow({ clinic_name: "Alice", age: 30 });

		expect(caseRowDisplayValue(row, "clinic_name")).toBe("Alice");
		expect(caseRowDisplayValue(row, "age")).toBe("30");
		expect(caseRowDisplayValue(row, "does_not_exist")).toBe("");
	});
});
