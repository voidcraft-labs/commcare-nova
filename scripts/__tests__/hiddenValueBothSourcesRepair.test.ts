import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { evaluateCommit } from "@/lib/commcare/validator/gate";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	buildHiddenValueBothSourcesScanReport,
	planHiddenValueBothSourcesRepair,
	renderHiddenValueBothSourcesScanReport,
	scanHiddenValueBothSources,
} from "../lib/hiddenValueBothSourcesScan";

const FORM_A = testUuid("form-a");
const FORM_B = testUuid("form-b");
const BOTH_A = testUuid("both-a");
const BOTH_B = testUuid("both-b");
const CALC_ONLY = testUuid("calc-only");
const DEFAULT_ONLY = testUuid("default-only");
const GROUP = testUuid("group");
const TEXT_WITH_DEFAULT = testUuid("text-with-default");

/** Two forms; one offender at the root of each (the second nested in a
 *  group), beside a calculate-only hidden, a default-only hidden, and a text
 *  field whose `default_value` is legal and must survive. */
function fixture() {
	return toPersistableDoc(
		buildDoc({
			appName: "Fleet",
			modules: [
				{
					name: "Visits",
					forms: [
						{
							uuid: FORM_A,
							name: "Visit",
							type: "survey",
							fields: [
								f({
									uuid: TEXT_WITH_DEFAULT,
									kind: "text",
									id: "note",
									label: "Note",
									default_value: "'hello'",
								}),
								f({
									uuid: BOTH_A,
									kind: "hidden",
									id: "stamp",
									calculate: "today()",
									default_value: "''",
								}),
								f({
									uuid: CALC_ONLY,
									kind: "hidden",
									id: "calc",
									calculate: "1 + 1",
								}),
							],
						},
						{
							uuid: FORM_B,
							name: "Review",
							type: "survey",
							fields: [
								f({
									uuid: DEFAULT_ONLY,
									kind: "hidden",
									id: "seed",
									default_value: "now()",
								}),
								f({
									uuid: GROUP,
									kind: "group",
									id: "details",
									label: "Details",
									children: [
										f({
											uuid: BOTH_B,
											kind: "hidden",
											id: "nested",
											calculate: "2",
											default_value: "3",
										}),
									],
								}),
							],
						},
					],
				},
			],
		}),
	);
}

describe("scanHiddenValueBothSources", () => {
	it("names exactly the hidden fields holding both slots, by form and field identity, sorted", () => {
		const findings = scanHiddenValueBothSources(
			hydratePersistedBlueprint(fixture()),
		);
		expect(findings).toEqual(
			[
				{ formUuid: FORM_A, fieldUuid: BOTH_A },
				{ formUuid: FORM_B, fieldUuid: BOTH_B },
			].sort(
				(a, b) =>
					a.formUuid.localeCompare(b.formUuid) ||
					a.fieldUuid.localeCompare(b.fieldUuid),
			),
		);
	});

	it("reports nothing on a document with one value source per hidden field", () => {
		const clean = planHiddenValueBothSourcesRepair(fixture()).targetDoc;
		expect(
			scanHiddenValueBothSources(hydratePersistedBlueprint(clean)),
		).toEqual([]);
	});
});

describe("buildHiddenValueBothSourcesScanReport + render", () => {
	it("counts apps and fields, exits 1 on any finding or unreadable app, and prints identities only", () => {
		const report = buildHiddenValueBothSourcesScanReport(
			[
				{
					appId: "app-b",
					findings: [{ formUuid: FORM_B, fieldUuid: BOTH_B }],
				},
				{ appId: "app-a", findings: [] },
				{
					appId: "app-c",
					findings: [
						{ formUuid: FORM_A, fieldUuid: BOTH_A },
						{ formUuid: FORM_B, fieldUuid: BOTH_B },
					],
				},
			],
			["app-z", "app-z"],
		);
		expect(report).toMatchObject({
			scannedApps: 4,
			affectedApps: 2,
			affectedFields: 3,
			unreadableAppIds: ["app-z"],
			exitCode: 1,
		});
		expect(report.findings.map((finding) => finding.appId)).toEqual([
			"app-b",
			"app-c",
			"app-c",
		]);
		const text = renderHiddenValueBothSourcesScanReport(report);
		expect(text).toContain(
			"4 persisted app(s) scanned; 2 affected app(s); 3 hidden field(s)",
		);
		expect(text).toContain(`app app-b\n  form ${FORM_B}; field ${BOTH_B}`);
		expect(text).toContain("Apps that could not be scanned\napp app-z");
		expect(text).toContain(
			"Do not activate HIDDEN_VALUE_BOTH_SOURCES until this scan returns clean.",
		);
		expect(text).not.toContain("CLEAN");
		// Authored content never enters the report.
		expect(text).not.toContain("today()");
	});

	it("prints CLEAN with exit 0 when nothing is affected and everything was readable", () => {
		const report = buildHiddenValueBothSourcesScanReport([
			{ appId: "app-a", findings: [] },
		]);
		expect(report.exitCode).toBe(0);
		const text = renderHiddenValueBothSourcesScanReport(report);
		expect(text).toContain("CLEAN");
		expect(text).not.toContain("Do not activate");
	});

	it("exits 1 for an unreadable app even with zero findings", () => {
		expect(
			buildHiddenValueBothSourcesScanReport([], ["app-broken"]).exitCode,
		).toBe(1);
	});
});

describe("planHiddenValueBothSourcesRepair", () => {
	it("drops exactly default_value on each offender, leaves every other field byte-identical, and lands gate-clean", () => {
		const doc = fixture();
		const before = structuredClone(doc);
		const plan = planHiddenValueBothSourcesRepair(doc);

		// Pure: the input is untouched.
		expect(doc).toEqual(before);
		expect(plan.cleared).toEqual(
			scanHiddenValueBothSources(hydratePersistedBlueprint(doc)),
		);

		const expected = structuredClone(doc);
		for (const uuid of [BOTH_A, BOTH_B]) {
			const field = expected.fields[uuid] as Record<string, unknown>;
			delete field.default_value;
		}
		expect(plan.targetDoc).toEqual(expected);
		// The offenders keep their calculate; the survivors keep their slot.
		expect(plan.targetDoc.fields[BOTH_A]).toHaveProperty("calculate");
		expect(plan.targetDoc.fields[BOTH_A]).not.toHaveProperty("default_value");
		expect(plan.targetDoc.fields[DEFAULT_ONLY]).toHaveProperty("default_value");
		expect(plan.targetDoc.fields[TEXT_WITH_DEFAULT]).toHaveProperty(
			"default_value",
		);

		const verdict = evaluateCommit({
			nextDoc: hydratePersistedBlueprint(plan.targetDoc),
			lookupContext: LOOKUP_CONTEXT_UNAVAILABLE,
		});
		expect(verdict.ok ? [] : verdict.findings.map((e) => e.message)).toEqual(
			[],
		);
	});

	it("returns an equal document and no clears when there is nothing to repair", () => {
		const clean = planHiddenValueBothSourcesRepair(fixture()).targetDoc;
		const plan = planHiddenValueBothSourcesRepair(clean);
		expect(plan.cleared).toEqual([]);
		expect(plan.targetDoc).toEqual(clean);
	});
});
