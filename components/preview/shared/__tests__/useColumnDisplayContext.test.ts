import { describe, expect, it } from "vitest";
import { projectLocalizedCaseProperties } from "@/components/preview/shared/useColumnDisplayContext";
import {
	casePropertyOptionTranslationUnitId,
	type LocalizedValue,
	makeTranslationUnitId,
	proseText,
	type TranslationUnitId,
} from "@/lib/domain";

describe("projectLocalizedCaseProperties", () => {
	it("keeps the effective structure while projecting localized option labels", () => {
		const translations = new Map<TranslationUnitId, LocalizedValue>([
			[
				makeTranslationUnitId(
					"case-property-option",
					"patient",
					"status",
					"open",
				),
				proseText("Abierto"),
			],
		]);

		const projected = projectLocalizedCaseProperties(
			"patient",
			[
				{
					name: "status",
					label: proseText("Status"),
					data_type: "multi_select",
					options: [
						{ value: "open", label: proseText("Open") },
						{ value: "closed", label: proseText("Closed") },
					],
				},
			],
			translations,
		);

		expect(projected).toEqual([
			{
				name: "status",
				label: proseText("Status"),
				data_type: "multi_select",
				options: [
					{ value: "open", label: proseText("Abierto") },
					{ value: "closed", label: proseText("Closed") },
				],
			},
		]);
	});

	it("projects repeated stored values through distinct occurrence identities", () => {
		const translations = new Map<TranslationUnitId, LocalizedValue>([
			[
				casePropertyOptionTranslationUnitId("patient", "status", "same", 0),
				proseText("Primero"),
			],
			[
				casePropertyOptionTranslationUnitId("patient", "status", "same", 1),
				proseText("Segundo"),
			],
		]);
		const [property] = projectLocalizedCaseProperties(
			"patient",
			[
				{
					name: "status",
					label: proseText("Status"),
					data_type: "multi_select",
					options: [
						{ value: "same", label: proseText("First") },
						{ value: "same", label: proseText("Second") },
					],
				},
			],
			translations,
		);
		expect(property?.options?.map((option) => option.label)).toEqual([
			proseText("Primero"),
			proseText("Segundo"),
		]);
	});
});
