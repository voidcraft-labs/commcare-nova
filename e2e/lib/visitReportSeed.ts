import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { asUuid, type BlueprintDoc, type Uuid } from "@/lib/domain";
import { buildUrl } from "@/lib/routing/location";

export const visitReport = {
	appName: "Outreach visits",
	menu: asUuid("0ab48a75-e45a-40c1-91ab-d18b03b19d6b"),
	form: asUuid("441c9826-c3cd-4202-a247-a946140ecb68"),
	message: asUuid("dc598ffd-3cac-40ae-855f-01d11a9e4fe0"),
	repeat: asUuid("dccdf16c-06fe-4bc6-bf14-78c23949c06b"),
	source: asUuid("fa0d79dd-ed01-4dd3-8c15-c10db5530911"),
};

export function visitReportRoute(appId: string, selectedUuid?: Uuid) {
	return buildUrl(`/build/${appId}`, {
		kind: "form",
		moduleUuid: visitReport.menu,
		formUuid: visitReport.form,
		...(selectedUuid && { selectedUuid }),
	});
}

export function buildVisitReport(appId: string): BlueprintDoc {
	return buildDoc({
		appId,
		appName: visitReport.appName,
		modules: [
			{
				uuid: visitReport.menu,
				name: "Outreach",
				forms: [
					{
						uuid: visitReport.form,
						name: "Visit report",
						type: "survey",
						postSubmit: "module",
						fields: [
							f({
								kind: "label",
								uuid: visitReport.message,
								id: "consent",
								label: "The family agreed to participate",
							}),
							f({
								kind: "repeat",
								uuid: visitReport.repeat,
								id: "place",
								label: "Place",
								repeat_mode: "user_controlled",
								children: [
									f({ kind: "text", id: "village", label: "Village" }),
								],
							}),
							f({ kind: "text", id: "notes", label: "Final notes" }),
							f({
								kind: "hidden",
								uuid: visitReport.source,
								id: "source",
								default_value: "'outreach'",
							}),
						],
					},
				],
			},
		],
	});
}
