/**
 * Lookup-backed choices as engine values — the S07a read-side
 * lifecycle: computed at init, recomputed when a filter dependency
 * changes (the runtime DAG edges promoted from the cycle proof),
 * dropped selections unselected, downstream dependents cascading in
 * the same pass, and the loud invariant when a carrier-bearing form
 * evaluates without a lookup snapshot.
 */
import { describe, expect, it } from "vitest";
import type {
	Field,
	FieldKind,
	Form,
	FormType,
	LookupColumnId,
	LookupOptionsSource,
	LookupTableId,
	Uuid,
} from "@/lib/domain";
import { asUuid } from "@/lib/domain";
import { eq, formField, tableColumn, term } from "@/lib/domain/predicate";
import type {
	LookupFixtureRow,
	LookupTableDefinition,
} from "@/lib/lookup/types";
import { FormEngine, type FormEngineInput } from "../formEngine";
import { type PreviewLookupData, previewLookupData } from "../lookupEvaluation";

const TABLE = "018f0000-0000-7000-8000-000000000001" as LookupTableId;
const COL_CODE = "018f0000-0000-7000-8000-0000000000c1" as LookupColumnId;
const COL_NAME = "018f0000-0000-7000-8000-0000000000c2" as LookupColumnId;
const COL_REGION = "018f0000-0000-7000-8000-0000000000c4" as LookupColumnId;

const DEFINITION: LookupTableDefinition = {
	id: TABLE,
	name: "Clinics",
	tag: "clinics",
	definitionRevision: "1" as LookupTableDefinition["definitionRevision"],
	columns: [
		{ id: COL_CODE, wireName: "code", label: "Code", dataType: "text" },
		{ id: COL_NAME, wireName: "clinic_name", label: "Name", dataType: "text" },
		{ id: COL_REGION, wireName: "region", label: "Region", dataType: "text" },
	],
};

function clinicRow(
	id: string,
	code: string,
	name: string,
	region: string,
): LookupFixtureRow {
	return {
		id: id as LookupFixtureRow["id"],
		values: { [COL_CODE]: code, [COL_NAME]: name, [COL_REGION]: region },
	};
}

const ROWS: readonly LookupFixtureRow[] = [
	clinicRow("018f0000-0000-7000-8000-0000000000r1", "a1", "Arua", "north"),
	clinicRow("018f0000-0000-7000-8000-0000000000r2", "b2", "Bario", "south"),
	clinicRow("018f0000-0000-7000-8000-0000000000r3", "c3", "Cadu", "south"),
];

function lookupData(): PreviewLookupData {
	return previewLookupData({
		projectRevision: "7",
		definitions: [DEFINITION],
		rowsByTable: new Map([[TABLE, ROWS]]),
	});
}

interface DField {
	id: string;
	kind: FieldKind;
	label?: string;
	calculate?: string;
	optionsSource?: LookupOptionsSource;
	options?: Array<{ value: string; label: string }>;
}

function dTree(
	fields: DField[],
	formType: FormType = "survey",
): FormEngineInput {
	const formUuid = asUuid("test-form-uuid");
	const form: Form = {
		uuid: formUuid,
		id: "test-form",
		name: "Test Form",
		type: formType,
	};
	const fieldMap: Record<string, Field> = {};
	const order: Uuid[] = [];
	for (const n of fields) {
		const uuid = asUuid(`form.${n.id}`);
		order.push(uuid);
		fieldMap[uuid as string] = { uuid, ...n } as Field;
	}
	return {
		form,
		formUuid,
		fields: fieldMap,
		fieldOrder: { [formUuid as string]: order },
	};
}

const REGION_FIELD_UUID = asUuid("form.region");

function clinicSelect(
	kind: "single_select" | "multi_select",
	filtered: boolean,
): DField {
	return {
		id: "clinic",
		kind,
		label: "Clinic",
		optionsSource: {
			kind: "lookup-table",
			tableId: TABLE,
			valueColumnId: COL_CODE,
			labelColumnId: COL_NAME,
			...(filtered && {
				filter: eq(
					term(tableColumn(TABLE, COL_REGION)),
					term(formField(REGION_FIELD_UUID)),
				),
			}),
		},
		// The inline rolling-receiver fallback options the schema requires.
		options: [
			{ value: "a1", label: "Arua" },
			{ value: "b2", label: "Bario" },
		],
	};
}

describe("lookup-backed choices in the engine", () => {
	it("computes unfiltered choices at init", () => {
		const engine = new FormEngine(
			dTree([clinicSelect("single_select", false)]),
			undefined,
			undefined,
			null,
			lookupData(),
		);
		expect(engine.getState("/data/clinic").choices).toEqual([
			{
				key: "018f0000-0000-7000-8000-0000000000r1",
				value: "a1",
				label: "Arua",
			},
			{
				key: "018f0000-0000-7000-8000-0000000000r2",
				value: "b2",
				label: "Bario",
			},
			{
				key: "018f0000-0000-7000-8000-0000000000r3",
				value: "c3",
				label: "Cadu",
			},
		]);
	});

	it("recomputes filtered choices when the referenced answer changes", () => {
		const engine = new FormEngine(
			dTree([
				{ id: "region", kind: "text", label: "Region" },
				clinicSelect("single_select", true),
			]),
			undefined,
			undefined,
			null,
			lookupData(),
		);
		// Unanswered region matches no row (raw eq against non-blank cells).
		expect(engine.getState("/data/clinic").choices).toEqual([]);

		engine.setValue("/data/region", "south");
		expect(engine.getState("/data/clinic").choices).toEqual([
			{
				key: "018f0000-0000-7000-8000-0000000000r2",
				value: "b2",
				label: "Bario",
			},
			{
				key: "018f0000-0000-7000-8000-0000000000r3",
				value: "c3",
				label: "Cadu",
			},
		]);

		engine.setValue("/data/region", "north");
		expect(engine.getState("/data/clinic").choices).toEqual([
			{
				key: "018f0000-0000-7000-8000-0000000000r1",
				value: "a1",
				label: "Arua",
			},
		]);
	});

	it("unselects a single-select value the rebuilt choices no longer offer", () => {
		const engine = new FormEngine(
			dTree([
				{ id: "region", kind: "text", label: "Region" },
				clinicSelect("single_select", true),
				{ id: "echo", kind: "hidden", calculate: "#form/clinic" },
			]),
			undefined,
			undefined,
			null,
			lookupData(),
		);
		engine.setValue("/data/region", "south");
		engine.setValue("/data/clinic", "b2");
		expect(engine.getState("/data/echo").value).toBe("b2");

		engine.setValue("/data/region", "north");
		expect(engine.getState("/data/clinic").value).toBe("");
		// The downstream calculate cascades in the same pass.
		expect(engine.getState("/data/echo").value).toBe("");
	});

	it("keeps surviving multi-select tokens and drops removed ones", () => {
		const engine = new FormEngine(
			dTree([
				{ id: "region", kind: "text", label: "Region" },
				clinicSelect("multi_select", true),
			]),
			undefined,
			undefined,
			null,
			lookupData(),
		);
		engine.setValue("/data/region", "south");
		engine.setValue("/data/clinic", "b2 c3");

		// Both south rows survive a re-set of the same region.
		engine.setValue("/data/region", "south");
		expect(engine.getState("/data/clinic").value).toBe("b2 c3");

		engine.setValue("/data/region", "north");
		expect(engine.getState("/data/clinic").value).toBe("");
	});

	it("keeps the selected value when the rebuilt choices still offer it", () => {
		const engine = new FormEngine(
			dTree([
				{ id: "region", kind: "text", label: "Region" },
				clinicSelect("single_select", true),
			]),
			undefined,
			undefined,
			null,
			lookupData(),
		);
		engine.setValue("/data/region", "south");
		engine.setValue("/data/clinic", "c3");
		engine.setValue("/data/region", "south");
		expect(engine.getState("/data/clinic").value).toBe("c3");
	});

	it("leaves choices undefined (loading) without a snapshot, unselecting nothing", () => {
		const engine = new FormEngine(
			dTree([clinicSelect("single_select", false)]),
		);
		engine.setValue("/data/clinic", "b2");
		expect(engine.getState("/data/clinic").choices).toBeUndefined();
		expect(engine.getState("/data/clinic").value).toBe("b2");
	});

	it("a source the snapshot doesn't cover degrades to loading, and coverage reports the gap", () => {
		/* A validly committed edit can reference a table the captured
		 * snapshot predates — that is a COVERAGE gap (loading state +
		 * controller heal), never the validation-bypass throw, which fires
		 * only from evaluateLookupChoices under a covering snapshot. */
		const orphanSelect = clinicSelect("single_select", false);
		orphanSelect.optionsSource = {
			...(orphanSelect.optionsSource as LookupOptionsSource),
			tableId: "018f0000-0000-7000-8000-00000000dead" as LookupTableId,
		};
		const engine = new FormEngine(
			dTree([orphanSelect]),
			undefined,
			undefined,
			null,
			lookupData(),
		);
		expect(engine.getState("/data/clinic").choices).toBeUndefined();
		expect(engine.lookupDataCoversForm()).toBe(false);
	});

	it("coverage holds for a covered snapshot and fails without one", () => {
		const covered = new FormEngine(
			dTree([
				{ id: "region", kind: "text", label: "Region" },
				clinicSelect("single_select", true),
			]),
			undefined,
			undefined,
			null,
			lookupData(),
		);
		expect(covered.lookupDataCoversForm()).toBe(true);
		const uncaptured = new FormEngine(
			dTree([clinicSelect("single_select", false)]),
		);
		expect(uncaptured.lookupDataCoversForm()).toBe(false);
		const carrierFree = new FormEngine(
			dTree([{ id: "name", kind: "text", label: "Name" }]),
		);
		expect(carrierFree.lookupDataCoversForm()).toBe(true);
	});

	it("a carrier-free form needs no snapshot", () => {
		const engine = new FormEngine(
			dTree([{ id: "name", kind: "text", label: "Name" }]),
		);
		expect(engine.getState("/data/name").visible).toBe(true);
		expect(engine.usesLookupData()).toBe(false);
	});

	it("reports carrier presence for the controller's rebuild decision", () => {
		const engine = new FormEngine(
			dTree([clinicSelect("single_select", false)]),
			undefined,
			undefined,
			null,
			lookupData(),
		);
		expect(engine.usesLookupData()).toBe(true);
		expect(engine.hasLookupData()).toBe(true);
	});
});
