// lib/case-store/sample/__tests__/heuristic.test.ts
//
// Unit tests for `HeuristicCaseGenerator` and the seeded PRNG
// helpers it composes against. The generator is pure — no
// database, no clock reads — so these tests run against the
// in-process generator directly, without any Postgres harness.
//
// Coverage:
//
//   - Determinism: same `(appId, caseType, seed)` yields the same
//     `properties` documents on every call. Different seeds yield
//     different documents.
//   - JSON Schema validity: every generated row's `properties`
//     validates against the case-type's JSON Schema (the same
//     `caseTypeToJsonSchema` the case store runs against at
//     insert time).
//   - Per-`data_type` heuristic dispatch: each `CasePropertyDataType`
//     produces a value of the expected JS shape.
//   - Property-name heuristic: name-shape inputs produce the
//     matching pool variant (e.g. "age" → uniform 15-80).
//   - Parent linkage: child case types resolve `parent_case_id`
//     from `parentRefs`; orphan case types produce `null`.

import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import type { CaseType } from "@/lib/domain";
import { caseTypeToJsonSchema } from "@/lib/domain/predicate/jsonSchema";
import type { JsonObject } from "../../sql/database";
import { HeuristicCaseGenerator } from "../heuristic";
import { createSeededPrng, hashStringToUint32 } from "../prng";

// ---------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------

/**
 * A patient case-type covering every `data_type` arm — the broad
 * coverage doubles as a heuristic-dispatch test fixture.
 */
const PATIENT_CASE_TYPE: CaseType = {
	name: "patient",
	properties: [
		{ name: "name", label: "Name", data_type: "text" },
		{ name: "age", label: "Age", data_type: "int" },
		{ name: "weight", label: "Weight (kg)", data_type: "decimal" },
		{ name: "dob", label: "DOB", data_type: "date" },
		{
			name: "registered_on",
			label: "Registered",
			data_type: "datetime",
		},
		{ name: "visit_time", label: "Visit Time", data_type: "time" },
		{
			name: "color",
			label: "Color",
			data_type: "single_select",
			options: [
				{ value: "red", label: "Red" },
				{ value: "blue", label: "Blue" },
				{ value: "green", label: "Green" },
			],
		},
		{
			name: "tags",
			label: "Tags",
			data_type: "multi_select",
			options: [
				{ value: "urgent", label: "Urgent" },
				{ value: "followup", label: "Followup" },
				{ value: "stable", label: "Stable" },
				{ value: "review", label: "Review" },
			],
		},
		{
			name: "home_location",
			label: "Home Location",
			data_type: "geopoint",
		},
	],
};

const HOUSEHOLD_CASE_TYPE: CaseType = {
	name: "household",
	properties: [{ name: "region", label: "Region", data_type: "text" }],
};

const PATIENT_WITH_PARENT_CASE_TYPE: CaseType = {
	name: "patient",
	parent_type: "household",
	properties: [{ name: "name", label: "Name", data_type: "text" }],
};

// ---------------------------------------------------------------
// PRNG helpers — algorithm-level pins
// ---------------------------------------------------------------

describe("hashStringToUint32", () => {
	it("returns the same hash for the same input", () => {
		expect(hashStringToUint32("abc")).toBe(hashStringToUint32("abc"));
	});

	it("returns different hashes for different inputs", () => {
		expect(hashStringToUint32("abc")).not.toBe(hashStringToUint32("def"));
	});

	it("returns an unsigned 32-bit integer", () => {
		const hash = hashStringToUint32("test");
		expect(hash).toBeGreaterThanOrEqual(0);
		expect(hash).toBeLessThanOrEqual(0xffffffff);
		expect(Number.isInteger(hash)).toBe(true);
	});
});

describe("createSeededPrng", () => {
	it("produces the same sequence for the same seed", () => {
		const prngA = createSeededPrng("seed-1");
		const prngB = createSeededPrng("seed-1");
		const sequenceA = Array.from({ length: 10 }, () => prngA.pickFloat());
		const sequenceB = Array.from({ length: 10 }, () => prngB.pickFloat());
		expect(sequenceA).toEqual(sequenceB);
	});

	it("produces a different sequence for a different seed", () => {
		const prngA = createSeededPrng("seed-1");
		const prngB = createSeededPrng("seed-2");
		const sequenceA = Array.from({ length: 10 }, () => prngA.pickFloat());
		const sequenceB = Array.from({ length: 10 }, () => prngB.pickFloat());
		expect(sequenceA).not.toEqual(sequenceB);
	});

	it("pickFloat returns values in [0, 1)", () => {
		const prng = createSeededPrng("range-check");
		for (let i = 0; i < 1000; i++) {
			const value = prng.pickFloat();
			expect(value).toBeGreaterThanOrEqual(0);
			expect(value).toBeLessThan(1);
		}
	});

	it("pickIndex returns values in [0, max)", () => {
		const prng = createSeededPrng("index-check");
		for (let i = 0; i < 1000; i++) {
			const value = prng.pickIndex(10);
			expect(value).toBeGreaterThanOrEqual(0);
			expect(value).toBeLessThan(10);
			expect(Number.isInteger(value)).toBe(true);
		}
	});
});

// ---------------------------------------------------------------
// HeuristicCaseGenerator — determinism + schema validity
// ---------------------------------------------------------------

describe("HeuristicCaseGenerator", () => {
	const generator = new HeuristicCaseGenerator();

	it("produces the same output for the same seed", () => {
		const args = {
			appId: "app-1",
			caseType: PATIENT_CASE_TYPE,
			count: 10,
			seed: "deterministic",
		};
		const first = generator.generate(args);
		const second = generator.generate(args);
		expect(first).toEqual(second);
	});

	it("produces different output for different seeds", () => {
		const first = generator.generate({
			appId: "app-1",
			caseType: PATIENT_CASE_TYPE,
			count: 10,
			seed: "seed-A",
		});
		const second = generator.generate({
			appId: "app-1",
			caseType: PATIENT_CASE_TYPE,
			count: 10,
			seed: "seed-B",
		});
		expect(first).not.toEqual(second);
	});

	it("produces different output for different case-types", () => {
		// Same seed, different `caseType.name` qualifier in the PRNG
		// seed — output must differ. The check guards against the
		// determinism contract collapsing into "same seed string =
		// same output regardless of context."
		const patient = generator.generate({
			appId: "app-1",
			caseType: PATIENT_CASE_TYPE,
			count: 5,
			seed: "shared-seed",
		});
		// Use a single-property household to compare structurally
		// against the patient's name property.
		const household = generator.generate({
			appId: "app-1",
			caseType: HOUSEHOLD_CASE_TYPE,
			count: 5,
			seed: "shared-seed",
		});
		// Compare the regions vs. names — different data sources.
		// The non-equality check is the behavior pin: distinct
		// `caseType.name` qualifiers must seed distinct PRNG streams.
		expect(patient).not.toEqual(household);
	});

	it("returns the requested count of rows", () => {
		const five = generator.generate({
			appId: "app-1",
			caseType: PATIENT_CASE_TYPE,
			count: 5,
			seed: "count-five",
		});
		const thirty = generator.generate({
			appId: "app-1",
			caseType: PATIENT_CASE_TYPE,
			count: 30,
			seed: "count-thirty",
		});
		expect(five).toHaveLength(5);
		expect(thirty).toHaveLength(30);
	});

	it("fills every row with a deterministic, unique top-level external ID", () => {
		const args = {
			appId: "app-1",
			caseType: PATIENT_CASE_TYPE,
			count: 30,
			seed: "external-id-regression",
		};
		const first = generator.generate(args);
		const second = generator.generate(args);
		const externalIds = first.map((row) => row.external_id);

		expect(externalIds).toEqual(second.map((row) => row.external_id));
		expect(new Set(externalIds).size).toBe(first.length);
		expect(externalIds[0]).toBe("PAT-5777");
		expect(externalIds.at(-1)).toBe("PAT-5806");
		for (const row of first) {
			expect(row.external_id).toMatch(/^PAT-\d{4,}$/);
			expect(row.properties).not.toHaveProperty("external_id");
		}
	});

	it("does not consume the existing property, name, or parent PRNG stream", () => {
		const rows = generator.generate({
			appId: "app-1",
			caseType: {
				name: "patient",
				properties: [
					{ name: "name", label: "Name", data_type: "text" },
					{ name: "age", label: "Age", data_type: "int" },
					{ name: "dob", label: "DOB", data_type: "date" },
				],
			},
			count: 2,
			seed: "external-id-regression",
		});

		// These are the generator's values from before `external_id` was
		// added. Keeping its PRNG on a separate seed stream preserves them.
		expect(
			rows.map((row) => ({
				case_name: row.case_name,
				properties: row.properties,
				parent_case_id: row.parent_case_id,
			})),
		).toEqual([
			{
				case_name: "Kofi Hassan",
				properties: {
					name: "Mei Reddy",
					age: 68,
					dob: "1952-03-22",
				},
				parent_case_id: null,
			},
			{
				case_name: "Gita Tran",
				properties: {
					name: "Rashid Zhang",
					age: 19,
					dob: "1963-06-29",
				},
				parent_case_id: null,
			},
		]);
	});

	it("generated rows validate against the case-type JSON Schema", () => {
		// Pin every row against the same schema validator the case
		// store uses at insert time. A heuristic that emits an
		// out-of-shape value (e.g. an int outside the schema's
		// integer arm) would surface here without ever needing the
		// database.
		const rows = generator.generate({
			appId: "app-1",
			caseType: PATIENT_CASE_TYPE,
			count: 30,
			seed: "schema-validity",
		});

		const ajv = new Ajv2020({ strict: false });
		addFormats(ajv);
		const schema = caseTypeToJsonSchema(PATIENT_CASE_TYPE);
		const validate = ajv.compile(schema);

		for (const row of rows) {
			const ok = validate(row.properties);
			if (!ok) {
				throw new Error(
					`row failed JSON Schema validation: ${JSON.stringify(row.properties)}; errors: ${JSON.stringify(validate.errors)}`,
				);
			}
		}
	});

	it("each generated property has the expected JS shape per data_type", () => {
		const rows = generator.generate({
			appId: "app-1",
			caseType: PATIENT_CASE_TYPE,
			count: 10,
			seed: "shape-check",
		});
		for (const row of rows) {
			// Narrow `CaseInsert.properties` from `JsonObject | string` to
			// the object arm — the generator always emits an object (the
			// implementation builds a `JsonObject` accumulator before push).
			const props = row.properties as JsonObject;
			// text → non-empty string
			expect(typeof props.name).toBe("string");
			expect((props.name as string).length).toBeGreaterThan(0);
			// int → integer in working-age band [15, 80)
			expect(Number.isInteger(props.age)).toBe(true);
			expect(props.age as number).toBeGreaterThanOrEqual(15);
			expect(props.age as number).toBeLessThan(80);
			// decimal → number
			expect(typeof props.weight).toBe("number");
			// date → YYYY-MM-DD
			expect(props.dob).toMatch(/^\d{4}-\d{2}-\d{2}$/);
			// datetime → ISO datetime
			expect(props.registered_on).toMatch(
				/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
			);
			// time → HH:MM:SSZ in 08:00-18:00 working-hours range
			// (the trailing `Z` satisfies AJV's strict
			// `format: time` validator).
			expect(props.visit_time).toMatch(/^\d{2}:\d{2}:\d{2}Z$/);
			const [hourStr] = (props.visit_time as string).split(":");
			const hour = Number.parseInt(hourStr ?? "0", 10);
			expect(hour).toBeGreaterThanOrEqual(8);
			expect(hour).toBeLessThan(18);
			// single_select → string from the option set
			expect(["red", "blue", "green"]).toContain(props.color);
			// multi_select → array of strings drawn from the option set
			expect(Array.isArray(props.tags)).toBe(true);
			for (const tag of props.tags as string[]) {
				expect(["urgent", "followup", "stable", "review"]).toContain(tag);
			}
			// geopoint → CCHQ wire format (4 space-separated decimals)
			expect(props.home_location).toMatch(/^-?\d+\.\d+ -?\d+\.\d+ \d+ \d+$/);
		}
	});
});

// ---------------------------------------------------------------
// HeuristicCaseGenerator — property-name heuristic
// ---------------------------------------------------------------

describe("HeuristicCaseGenerator property-name heuristic", () => {
	const generator = new HeuristicCaseGenerator();
	const medicationExamples = new Set([
		"Amoxicillin",
		"Paracetamol",
		"Metformin",
		"Oral rehydration salts",
		"Iron and folic acid",
		"Artemether-lumefantrine",
	]);
	const facilityExamples = new Set([
		"Riverside Health Centre",
		"Central Community Clinic",
		"North District Hospital",
		"Hillview Medical Centre",
		"Lakeside Health Post",
		"Green Valley Clinic",
	]);
	const genericTextExamples = new Set([
		"Follow-up needed",
		"Ready for review",
		"Information confirmed",
		"No concerns reported",
		"Details updated",
		"Awaiting confirmation",
	]);
	const medicationDoseExamples = new Set([
		"500 mg",
		"250 mg",
		"10 mL",
		"1 tablet",
		"2 tablets",
		"5 mg once daily",
	]);
	const medicationStatusExamples = new Set([
		"Active",
		"Completed",
		"Paused",
		"Stopped",
		"Awaiting refill",
	]);
	const medicationNoteExamples = new Set([
		"Take with food",
		"Morning dose confirmed",
		"No side effects reported",
		"Review at next visit",
		"Refill requested",
	]);

	it("'age' produces ints uniformly in [15, 80)", () => {
		const caseType: CaseType = {
			name: "person",
			properties: [{ name: "age", label: "Age", data_type: "int" }],
		};
		const rows = generator.generate({
			appId: "app-1",
			caseType,
			count: 100,
			seed: "age-pool",
		});
		for (const row of rows) {
			const value = (row.properties as JsonObject).age;
			expect(Number.isInteger(value)).toBe(true);
			expect(value as number).toBeGreaterThanOrEqual(15);
			expect(value as number).toBeLessThan(80);
		}
	});

	it("'count' / 'quantity' / 'total' produce ints in [0, 1000)", () => {
		const caseType: CaseType = {
			name: "stock",
			properties: [
				{ name: "item_count", label: "Count", data_type: "int" },
				{ name: "total_quantity", label: "Quantity", data_type: "int" },
			],
		};
		const rows = generator.generate({
			appId: "app-1",
			caseType,
			count: 30,
			seed: "count-pool",
		});
		for (const row of rows) {
			// Narrow `CaseInsert.properties` from `JsonObject | string` to
			// the object arm — the generator always emits an object (the
			// implementation builds a `JsonObject` accumulator before push).
			const props = row.properties as JsonObject;
			expect(props.item_count as number).toBeLessThan(1000);
			expect(props.total_quantity as number).toBeLessThan(1000);
		}
	});

	it("'temperature' decimal produces values in clinical body-temp range", () => {
		const caseType: CaseType = {
			name: "vital",
			properties: [
				{ name: "temperature", label: "Temp", data_type: "decimal" },
			],
		};
		const rows = generator.generate({
			appId: "app-1",
			caseType,
			count: 30,
			seed: "temp-pool",
		});
		for (const row of rows) {
			const value = (row.properties as JsonObject).temperature;
			expect(value as number).toBeGreaterThanOrEqual(35.5);
			expect(value as number).toBeLessThanOrEqual(40.5);
		}
	});

	it("'name' text is a multi-word string", () => {
		const caseType: CaseType = {
			name: "person",
			properties: [{ name: "name", label: "Name", data_type: "text" }],
		};
		const rows = generator.generate({
			appId: "app-1",
			caseType,
			count: 30,
			seed: "name-pool",
		});
		for (const row of rows) {
			const value = (row.properties as JsonObject).name as string;
			expect(value.split(" ")).toHaveLength(2);
		}
	});

	it("'first_name' text is a single token (no space)", () => {
		const caseType: CaseType = {
			name: "person",
			properties: [
				{ name: "first_name", label: "First Name", data_type: "text" },
			],
		};
		const rows = generator.generate({
			appId: "app-1",
			caseType,
			count: 30,
			seed: "first-name-pool",
		});
		for (const row of rows) {
			const value = (row.properties as JsonObject).first_name as string;
			expect(value).not.toContain(" ");
			expect(value.length).toBeGreaterThan(0);
		}
	});

	it("medication, drug, and treatment fields use readable medication examples", () => {
		const caseType: CaseType = {
			name: "prescription",
			properties: [
				{
					name: "medication_name",
					label: "Medication",
					data_type: "text",
				},
				{ name: "drug_given", label: "Drug", data_type: "text" },
				{ name: "treatment", label: "Treatment", data_type: "text" },
			],
		};
		const rows = generator.generate({
			appId: "app-1",
			caseType,
			count: 30,
			seed: "medication-examples",
		});

		for (const row of rows) {
			const props = row.properties as JsonObject;
			expect(medicationExamples.has(props.medication_name as string)).toBe(
				true,
			);
			expect(medicationExamples.has(props.drug_given as string)).toBe(true);
			expect(medicationExamples.has(props.treatment as string)).toBe(true);
		}
	});

	it("does not mistake medication dose, status, or notes for a medicine name", () => {
		const caseType: CaseType = {
			name: "prescription",
			properties: [
				{ name: "medication_dose", label: "Dose", data_type: "text" },
				{ name: "drug_status", label: "Status", data_type: "text" },
				{ name: "treatment_notes", label: "Notes", data_type: "text" },
			],
		};
		const rows = generator.generate({
			appId: "app-1",
			caseType,
			count: 30,
			seed: "medication-roles",
		});

		for (const row of rows) {
			const props = row.properties as JsonObject;
			expect(medicationDoseExamples.has(props.medication_dose as string)).toBe(
				true,
			);
			expect(medicationStatusExamples.has(props.drug_status as string)).toBe(
				true,
			);
			expect(medicationNoteExamples.has(props.treatment_notes as string)).toBe(
				true,
			);
			expect(medicationExamples.has(props.medication_dose as string)).toBe(
				false,
			);
		}
	});

	it("gives identifiers compact realistic values instead of prose", () => {
		const caseType: CaseType = {
			name: "patient",
			properties: [
				{ name: "patient_id", label: "Patient ID", data_type: "text" },
				{ name: "record_number", label: "Record number", data_type: "text" },
				{ name: "external_code", label: "External code", data_type: "text" },
			],
		};
		const rows = generator.generate({
			appId: "app-1",
			caseType,
			count: 30,
			seed: "identifier-examples",
		});

		for (const row of rows) {
			const props = row.properties as JsonObject;
			expect(props.patient_id).toMatch(/^PAT-\d{4}$/);
			expect(props.record_number).toMatch(/^REC-\d{4}$/);
			expect(props.external_code).toMatch(/^EXT-\d{4}$/);
			expect(genericTextExamples.has(props.patient_id as string)).toBe(false);
		}
	});

	it("clinic, facility, and site fields use readable facility examples", () => {
		const caseType: CaseType = {
			name: "visit",
			properties: [
				{ name: "clinic_name", label: "Clinic", data_type: "text" },
				{ name: "facility", label: "Facility", data_type: "text" },
				{ name: "site", label: "Site", data_type: "text" },
			],
		};
		const rows = generator.generate({
			appId: "app-1",
			caseType,
			count: 30,
			seed: "facility-examples",
		});

		for (const row of rows) {
			const props = row.properties as JsonObject;
			expect(facilityExamples.has(props.clinic_name as string)).toBe(true);
			expect(facilityExamples.has(props.facility as string)).toBe(true);
			expect(facilityExamples.has(props.site as string)).toBe(true);
		}
	});

	it("generic text fallbacks are readable, deterministic, and schema-valid", () => {
		const caseType: CaseType = {
			name: "follow_up",
			properties: [
				{ name: "notes", label: "Notes", data_type: "text" },
				{
					name: "clinical_notes",
					label: "Clinical notes",
					data_type: "text",
				},
			],
		};
		const args = {
			appId: "app-1",
			caseType,
			count: 30,
			seed: "generic-text-examples",
		};
		const first = generator.generate(args);
		const second = generator.generate(args);
		expect(first).toEqual(second);

		const ajv = new Ajv2020({ strict: false });
		addFormats(ajv);
		const validate = ajv.compile(caseTypeToJsonSchema(caseType));
		for (const row of first) {
			const props = row.properties as JsonObject;
			const notes = props.notes as string;
			const clinicalNotes = props.clinical_notes as string;
			expect(genericTextExamples.has(notes)).toBe(true);
			expect(genericTextExamples.has(clinicalNotes)).toBe(true);
			expect(facilityExamples.has(clinicalNotes)).toBe(false);
			expect(notes).not.toMatch(/^notes_\d{4}$/);
			expect(validate(row.properties)).toBe(true);
		}
	});
});

// ---------------------------------------------------------------
// HeuristicCaseGenerator — parent linkage
// ---------------------------------------------------------------

describe("HeuristicCaseGenerator parent linkage", () => {
	const generator = new HeuristicCaseGenerator();

	it("resolves parent_case_id from parentRefs for child case types", () => {
		const householdIds = ["household-1", "household-2", "household-3"];
		const rows = generator.generate({
			appId: "app-1",
			caseType: PATIENT_WITH_PARENT_CASE_TYPE,
			count: 30,
			seed: "with-parents",
			parentRefs: new Map([["household", householdIds]]),
		});
		for (const row of rows) {
			expect(row.parent_case_id).not.toBeNull();
			expect(householdIds).toContain(row.parent_case_id);
		}
	});

	it("emits null parent_case_id when no parent type is declared", () => {
		// `PATIENT_CASE_TYPE` has no `parent_type` — even with
		// parentRefs supplied, the generator should not assign a
		// parent.
		const rows = generator.generate({
			appId: "app-1",
			caseType: PATIENT_CASE_TYPE,
			count: 5,
			seed: "no-parent-type",
			parentRefs: new Map([["other", ["irrelevant-id"]]]),
		});
		for (const row of rows) {
			expect(row.parent_case_id).toBeNull();
		}
	});

	it("emits null parent_case_id when parent type has no existing rows", () => {
		// `parent_type` declared but `parentRefs` carries no entry —
		// child rows are orphans; not an error.
		const rows = generator.generate({
			appId: "app-1",
			caseType: PATIENT_WITH_PARENT_CASE_TYPE,
			count: 5,
			seed: "no-parents-yet",
		});
		for (const row of rows) {
			expect(row.parent_case_id).toBeNull();
		}
	});
});
