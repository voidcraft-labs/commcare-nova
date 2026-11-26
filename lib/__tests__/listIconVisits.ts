import { testUuid } from "@/__tests__/helpers/uuid";
import {
	type Column,
	imageMapColumn,
	type MediaAssetId,
	NEW_APP_SETTINGS,
	plainColumn,
	proseText,
} from "@/lib/domain";
import { buildDoc, f } from "./docHelpers";

const uuid = (name: string) => testUuid(`list-icon-visits-${name}`);
export const visitActionForm = uuid("visit");
export const visitActionModule = uuid("visits");

function caseListOf(columns: Column[]) {
	const order = columns.map((column) => column.uuid);
	return {
		columns,
		listColumnOrder: order,
		detailColumnOrder: [...order],
		searchInputs: [],
	};
}

export function listIconVisits(appId: string, assetId: MediaAssetId) {
	const form = uuid("visit");
	const label = uuid("mark");
	const endpoint = uuid("mark-link");
	const app = buildDoc({
		appId,
		appName: "Visit actions",
		caseTypes: [
			{
				name: "visit",
				properties: [
					{
						name: "visit_state",
						label: proseText("Visit status"),
						data_type: "text",
					},
				],
			},
		],
		appSettings: { ...NEW_APP_SETTINGS, runsOnlyOn: "web-apps" },
		modules: [
			{
				uuid: uuid("visits"),
				name: "Visits",
				caseType: "visit",
				caseListConfig: caseListOf([
					plainColumn(uuid("name"), "case_name", "Visit"),
					imageMapColumn(
						uuid("action"),
						"visit_state",
						"Record visit",
						[
							{
								uuid: uuid("ready-icon"),
								value: "ready",
								match: "exact",
								altText: "Record visit",
								assetId,
							},
						],
						{ entryPointUuid: endpoint },
					),
					plainColumn(uuid("state-display"), "visit_state", "Visit status"),
				]),
				forms: [
					{
						uuid: form,
						name: "Record visit",
						type: "followup",
						fields: [
							f({
								uuid: label,
								kind: "text",
								id: "state",
								label: proseText("Record this visit"),
								default_value: "'visited'",
								caseWrite: { caseType: "visit", property: "visit_state" },
							}),
						],
					},
				],
			},
		],
	});
	return {
		...app,
		forms: {
			...app.forms,
			[form]: {
				...app.forms[form],
				entryPoint: { uuid: endpoint, id: "mark-visit" },
				automaticSubmissionText: {
					carrier: { field: label, role: "field-label" as const },
				},
			},
		},
	};
}
