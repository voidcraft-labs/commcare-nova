import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { largeFormInitialCollapsedUuids } from "@/lib/doc/hooks/useOrderedFields";
import { assertAdmittedDoc } from "./admittedDoc";

const form = testUuid("collapse-form");
const group = testUuid("collapse-group");
const repeat = testUuid("collapse-repeat");
function fields(count: number) {
	return Array.from({ length: count }, (_, index) => ({
		kind: "text" as const,
		id: `answer_${index}`,
		label: `Answer ${index}`,
	}));
}
describe("initial large-form outline", () => {
	it.each([49, 50])("collapses only at the 50-field boundary (%i)", (count) => {
		const doc = buildDoc({
			appName: "Interview",
			modules: [
				{
					name: "Survey",
					forms: [
						{
							uuid: form,
							name: "Profile",
							type: "survey",
							fields: fields(count),
						},
					],
				},
			],
		});
		assertAdmittedDoc(doc);
		expect(largeFormInitialCollapsedUuids(doc)).toEqual(
			new Set(count === 50 ? [form] : []),
		);
	});
	it("counts the whole tree and summarizes every populated nested container", () => {
		const doc = buildDoc({
			appName: "Interview",
			modules: [
				{
					name: "Survey",
					forms: [
						{
							uuid: form,
							name: "Profile",
							type: "survey",
							fields: [
								{
									uuid: group,
									kind: "group",
									id: "details",
									children: [
										{
											uuid: repeat,
											kind: "repeat",
											id: "visits",
											repeat_mode: "user_controlled",
											children: fields(48),
										},
									],
								},
							],
						},
					],
				},
			],
		});
		assertAdmittedDoc(doc);
		expect(largeFormInitialCollapsedUuids(doc)).toEqual(
			new Set([form, group, repeat]),
		);
	});
});
