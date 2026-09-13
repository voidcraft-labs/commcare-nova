import { expect, it } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { proseText } from "@/lib/domain/prose";
import { appOverview } from "../appOverview";
import { buildAppStateMessage } from "../prompts";

it("orients an edit without sending every question's content", () => {
	const doc = buildDoc({
		appId: "overview-app",
		appName: "Clinic intake",
		modules: [
			{
				name: "Visits",
				forms: [
					{
						name: "Intake",
						type: "survey",
						fields: Array.from({ length: 220 }, (_, index) => ({
							kind: "text" as const,
							id: `question_${index}`,
							label: `Question ${index}`,
						})),
					},
				],
			},
		],
	});
	const moduleUuid = doc.moduleOrder[0];
	const formUuid = doc.formOrder[moduleUuid][0];
	const overview = appOverview(doc);
	expect(overview).toMatchObject({
		appId: "overview-app",
		name: "Clinic intake",
		modules: [
			{
				uuid: moduleUuid,
				name: "Visits",
				forms: [
					{ uuid: formUuid, name: "Intake", type: "survey", fields: 220 },
				],
			},
		],
	});
	const verbose = structuredClone(doc);
	for (const field of Object.values(verbose.fields)) {
		if (field.kind === "text")
			field.label = proseText(
				"Detailed clinical question guidance. ".repeat(100),
			);
	}
	expect(appOverview(verbose)).toEqual(overview);
	expect(buildAppStateMessage(verbose)).toEqual(buildAppStateMessage(doc));
	expect(JSON.stringify(buildAppStateMessage(doc))).not.toContain(
		"question_219",
	);
});
