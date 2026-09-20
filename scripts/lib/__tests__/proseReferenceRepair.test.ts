import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { validateXForm } from "@/lib/commcare/validator/xformOracle";
import { buildXForm } from "@/lib/commcare/xform/builder";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import {
	appLocalizationSchema,
	effectiveAppLocalization,
} from "@/lib/domain/localization";
import { proseText, resolveProseTemplate } from "@/lib/domain/prose";
import {
	proseTemplateToTiptapContent,
	tiptapContentToProseTemplate,
} from "@/lib/tiptap/proseTemplateCodec";
import { planProseReferenceRepair } from "../proseReferenceRepair";

function fixture() {
	return buildDoc({
		appName: "Reference repair",
		modules: [
			{
				name: "Survey",
				forms: [
					{
						name: "Measurements",
						type: "survey",
						fields: [
							f({
								kind: "group",
								id: "measurements",
								label: "Measurements",
								children: [f({ kind: "decimal", id: "muac", label: "MUAC" })],
							}),
							f({
								kind: "label",
								id: "summary",
								label:
									"**MUAC:** #form/measurements/muac cm. Again: #form/measurements/muac",
							}),
						],
					},
				],
			},
		],
	});
}

describe("historical prose repair", () => {
	it("binds the legacy own-case alias to the loaded case and refuses newly localized apps", () => {
		const doc = buildDoc({
			appName: "Household visit",
			caseTypes: [
				{
					name: "household",
					properties: [
						{ name: "case_name", label: proseText("Name"), data_type: "text" },
					],
				},
			],
			modules: [
				{
					name: "Households",
					caseType: "household",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Household" },
					]),
					forms: [
						{
							name: "Visit",
							type: "followup",
							fields: [
								f({
									kind: "label",
									id: "intro",
									label: "Household: #case/case_name",
								}),
							],
						},
					],
				},
			],
		});
		const baseline = toPersistableDoc(doc);
		expect(
			planProseReferenceRepair(baseline, baseline, "project", 1)?.changes[0]
				.after.parts,
		).toContainEqual({
			kind: "case-ref",
			caseType: "household",
			property: "case_name",
		});
		doc.localization = appLocalizationSchema.parse(
			effectiveAppLocalization(undefined),
		);
		expect(() =>
			planProseReferenceRepair(toPersistableDoc(doc), baseline, "project", 1),
		).toThrow("Localized app requires separate review");
	});
	it("preserves edited Markdown and resolves historical identity after a field rename through editor, runtime and wire", () => {
		const doc = fixture();
		const baseline = structuredClone(toPersistableDoc(doc));
		const measurement = Object.values(doc.fields).find(
			(field) => field.id === "muac",
		);
		const summary = Object.values(doc.fields).find(
			(field) => field.id === "summary",
		);
		if (!measurement || !summary || !("label" in summary))
			throw new Error("fixture missing");
		measurement.id = "arm_circumference";
		summary.label = proseText(
			"_MUAC:_ #form/measurements/muac cm. Again: #form/measurements/muac",
		);
		const entry = planProseReferenceRepair(
			toPersistableDoc(doc),
			baseline,
			"project",
			1,
		);
		expect(entry?.changes).toHaveLength(1);
		const repaired = entry?.changes[0]?.after;
		if (!repaired) throw new Error("repair missing");
		expect(repaired.parts).toEqual([
			{ kind: "text", text: "_MUAC:_ " },
			{ kind: "field-ref", uuid: measurement.uuid },
			{ kind: "text", text: " cm. Again: " },
			{ kind: "field-ref", uuid: measurement.uuid },
		]);
		expect(
			tiptapContentToProseTemplate(proseTemplateToTiptapContent(repaired)),
		).toEqual(repaired);
		expect(
			resolveProseTemplate(repaired, doc, (expression) => {
				expect(expression).toBe("#form/measurements/arm_circumference");
				return "12.5";
			}),
		).toBe("_MUAC:_ 12.5 cm. Again: 12.5");
		summary.label = repaired;
		const formUuid = Object.values(doc.forms)[0].uuid;
		const xml = buildXForm(doc, formUuid, { xmlns: "urn:prose-repair-test" });
		expect(validateXForm(xml, "Measurements", "Survey")).toEqual([]);
		expect(xml).toContain(
			'<output value="/data/measurements/arm_circumference"',
		);
		expect(xml).not.toContain("#form/measurements/muac");
		expect(
			planProseReferenceRepair(toPersistableDoc(doc), baseline, "project", 2),
		).toBeNull();
	});

	it("refuses new literal tokens and missing targets without guessing by suffix", () => {
		const doc = fixture();
		const baseline = structuredClone(toPersistableDoc(doc));
		const summary = Object.values(doc.fields).find(
			(field) => field.id === "summary",
		);
		if (!summary || !("label" in summary)) throw new Error("fixture missing");
		summary.label = proseText("#form/muac");
		expect(() =>
			planProseReferenceRepair(toPersistableDoc(doc), baseline, "project", 1),
		).toThrow("inventory changed");
		const unknownBaseline = structuredClone(toPersistableDoc(doc));
		expect(() =>
			planProseReferenceRepair(
				toPersistableDoc(doc),
				unknownBaseline,
				"project",
				1,
			),
		).toThrow("no longer resolves");
	});

	it("leaves existing reference atoms and ordinary literal prose untouched", () => {
		const doc = fixture();
		const summary = Object.values(doc.fields).find(
			(field) => field.id === "summary",
		);
		if (!summary || !("label" in summary)) throw new Error("fixture missing");
		const measurement = Object.values(doc.fields).find(
			(field) => field.id === "muac",
		);
		if (!measurement) throw new Error("fixture missing");
		summary.label = {
			parts: [
				{ kind: "text", text: "An ordinary # tag, `example`, and <markup>. " },
				{ kind: "field-ref", uuid: measurement.uuid },
			],
		};
		expect(
			planProseReferenceRepair(
				toPersistableDoc(doc),
				toPersistableDoc(doc),
				"project",
				1,
			),
		).toBeNull();
	});

	it("permits the approved MUAC correction only in the exact historical app and field", () => {
		const doc = fixture();
		const summary = Object.values(doc.fields).find(
			(field) => field.id === "summary",
		);
		if (!summary || !("label" in summary)) throw new Error("fixture missing");
		const oldUuid = summary.uuid;
		const approvedUuid =
			"e00ec2d2-466e-4d3c-b2e7-cd34a71a71e1" as typeof oldUuid;
		delete doc.fields[oldUuid];
		summary.uuid = approvedUuid;
		summary.label = proseText("MUAC: #form/muac");
		doc.fields[approvedUuid] = summary;
		for (const order of Object.values(doc.fieldOrder)) {
			const index = order.indexOf(oldUuid);
			if (index >= 0) order[index] = approvedUuid;
		}
		doc.appId = "Reaz6s4lyn0RYlUwumrM";
		const approved = toPersistableDoc(doc);
		expect(
			planProseReferenceRepair(approved, approved, "project", 1)?.changes[0]
				.after.parts[1],
		).toMatchObject({ kind: "field-ref" });
		doc.appId = "some-other-app";
		const other = toPersistableDoc(doc);
		expect(() => planProseReferenceRepair(other, other, "project", 1)).toThrow(
			"no longer resolves",
		);
	});
});
