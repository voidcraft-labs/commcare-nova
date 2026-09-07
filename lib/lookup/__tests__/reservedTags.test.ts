import { describe, expect, it } from "vitest";
import {
	createLookupTableInputSchema,
	lookupWireNameSchema,
	updateLookupTableTagInputSchema,
} from "../schema";

const tableId = "01890f45-0000-7000-8000-000000000001";
const columns = [{ wireName: "label", label: "Label", dataType: "text" }];

// Parser admission for new tags and explicit tag changes. Native XForm consumer
// tests in lib/commcare own the demonstrated instance-name collision.
describe("lookup instance tag admission", () => {
	it.each([
		"selected_cases",
		"selected_cases_patient",
		"parent_selected_cases",
		"parent_parent_selected_cases_a",
		"search_selected_cases",
		"Selected_Cases",
		"PARENT_SELECTED_CASES_PATIENT",
		"SEARCH_SELECTED_CASES",
	])("refuses reserved virtual instance tag %s at create and rename", (tag) => {
		const create = { name: "Labels", tag: "labels", columns };
		const rename = { tableId, expectedTableRevision: "0", tag: "labels" };
		expect(createLookupTableInputSchema.parse(create)).toEqual(create);
		expect(updateLookupTableTagInputSchema.parse(rename)).toEqual(rename);
		expect(
			createLookupTableInputSchema.safeParse({ ...create, tag }).success,
		).toBe(false);
		expect(
			updateLookupTableTagInputSchema.safeParse({ ...rename, tag }).success,
		).toBe(false);
		expect(lookupWireNameSchema.parse(tag)).toBe(tag);
	});
	it.each([
		"selected_cases_",
		"selected_cases_1",
		"selected_cases__patient",
		"parent_search_selected_cases",
		"my_selected_cases",
		"selected_case",
		"selected_caseslabels",
		"parent_patient",
	])("preserves noncolliding table tag %s", (tag) => {
		const create = { name: "Labels", tag, columns };
		expect(createLookupTableInputSchema.parse(create)).toEqual(create);
		expect(
			updateLookupTableTagInputSchema.parse({
				tableId,
				expectedTableRevision: "0",
				tag,
			}).tag,
		).toBe(tag);
	});
});
