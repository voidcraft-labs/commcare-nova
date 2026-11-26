import { expect, it } from "vitest";
import { runValidation } from "@/lib/commcare/validator/runner";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { plainColumn } from "@/lib/domain/modules";
import { proseText } from "@/lib/domain/prose";
import { patients, uuid } from "../../caseList/__tests__/fixtures";
import {
	closedCodes,
	listOf,
	readLists,
	searchOf,
} from "../../caseList/__tests__/listReading";

it.each(["default filter", "dedicated setting"] as const)(
	"refuses case location and preserves a dynamic record ID in the %s",
	async (carrier) => {
		const useDefault = carrier === "default filter";
		const readProperty = (property: string) =>
			readLists(patients([], { search: {} }), {
				edit: (app) => {
					const config = app.modules[0].search_config;
					if (useDefault) {
						config.default_properties = [
							{
								property: "x_commcare_custom_related_case_property",
								defaultValue: `'${property}'`,
							},
						];
					} else {
						config.custom_related_case_property = property;
					}
				},
			});
		const location = await readProperty("location_id");
		expect(closedCodes(location), JSON.stringify(location.findings)).toEqual([
			"case-search/a-related-record-property-only-devices-hold",
		]);
		const worker = await readProperty("hq_user_id");
		expect(closedCodes(worker), JSON.stringify(worker.findings)).toEqual([]);
		if (useDefault) {
			expect(listOf(worker).searchFilters).toMatchObject([
				{ kind: "related-record-id", property: "hq_user_id" },
			]);
		} else {
			expect(searchOf(worker)).toMatchObject({
				relatedRecordIdProperty: "hq_user_id",
			});
		}

		const findingsFor = (property: string) => {
			const columns = [plainColumn(uuid(1), "hq_user_id", "Linked worker")];
			const doc = useDefault
				? patients(columns, {
						search: {},
						list: {
							searchFilters: [
								{ uuid: uuid(34), kind: "related-record-id", property },
							],
						},
					})
				: patients(columns, { search: { relatedRecordIdProperty: property } });
			const caseTypes = [
				...(doc.caseTypes ?? []).filter((type) => type.name !== "patient"),
				{
					name: "patient",
					properties: [
						{
							name: "hq_user_id",
							label: proseText("Linked worker"),
							data_type: "text" as const,
						},
						{
							name: "location_id",
							label: proseText("Location"),
							data_type: "text" as const,
						},
					],
				},
			];
			return runValidation({ ...doc, caseTypes }, LOOKUP_CONTEXT_UNAVAILABLE);
		};
		expect(findingsFor("location_id")).toEqual([
			expect.objectContaining({
				code: "CASE_SEARCH_FILTER_INVALID",
				details: {
					reason: "related-record-id-device-only",
					property: "location_id",
				},
			}),
		]);
		expect(findingsFor("hq_user_id")).toEqual([]);
	},
);
