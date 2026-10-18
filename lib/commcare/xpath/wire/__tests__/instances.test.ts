import { describe, expect, it } from "vitest";
import {
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { parseLookupRevision } from "@/lib/lookup/schema";
import { lookupWireNaming } from "../../../lookup/naming";
import {
	caseDbInstance,
	InstanceSink,
	locationsInstance,
	lookupInstance,
	resultsInstance,
	searchInputInstance,
	selectedCasesInstance,
	sessionInstance,
} from "../instances";

const tableId = lookupTableIdSchema.parse(
	"018f3e8a-7b2c-7def-8abc-1234567890ab",
);
const columnId = lookupColumnIdSchema.parse(
	"018f3e8a-7b2c-7def-8abc-1234567890ad",
);
const naming = lookupWireNaming([
	{
		id: tableId,
		name: "Statuses",
		tag: "statuses",
		definitionRevision: parseLookupRevision("3"),
		columns: [
			{ id: columnId, wireName: "value", label: "Value", dataType: "text" },
		],
	},
]);

describe("wire instance declarations", () => {
	it.each([
		[caseDbInstance(), "casedb", "jr://instance/casedb"],
		[sessionInstance(), "commcaresession", "jr://instance/session"],
		[locationsInstance(), "locations", "jr://fixture/locations"],
		[resultsInstance("results"), "results", "jr://instance/remote/results"],
		[
			resultsInstance("results:inline"),
			"results:inline",
			"jr://instance/remote/results:inline",
		],
		[
			searchInputInstance("search-input:results"),
			"search-input:results",
			"jr://instance/search-input/results",
		],
		[
			searchInputInstance("search-input:results:inline"),
			"search-input:results:inline",
			"jr://instance/search-input/results:inline",
		],
		[
			selectedCasesInstance("parent_selected_cases_visit"),
			"parent_selected_cases_visit",
			"jr://instance/selected-entities/parent_selected_cases_visit",
		],
	] as const)("declares %s at its Core source", (declaration, id, src) => {
		expect(declaration).toEqual({ id, src });
	});

	it("uses distinct lookup ids for forms and suites with one fixture source", () => {
		expect(lookupInstance(tableId, naming, "xform")).toEqual({
			id: "statuses",
			src: "jr://fixture/item-list:statuses",
		});
		expect(lookupInstance(tableId, naming, "suite")).toEqual({
			id: "item-list:statuses",
			src: "jr://fixture/item-list:statuses",
		});
		expect(() => lookupInstance(tableId, undefined, "xform")).toThrow(
			"validated table definitions were not supplied",
		);
		expect(() =>
			lookupInstance(tableId, lookupWireNaming([]), "suite"),
		).toThrow("is not part of the validated definitions snapshot");
	});

	it("unions exact declarations in emission order without inferring a session read", () => {
		const sink = new InstanceSink([locationsInstance(), caseDbInstance()]);
		sink.add([caseDbInstance(), lookupInstance(tableId, naming, "suite")]);
		expect(sink.declarations().map(({ id }) => id)).toEqual([
			"casedb",
			"item-list:statuses",
			"locations",
		]);
		sink.addOne(sessionInstance());
		expect(sink.declarations().map(({ id }) => id)).toEqual([
			"casedb",
			"commcaresession",
			"item-list:statuses",
			"locations",
		]);
	});

	it("refuses two sources under the same id", () => {
		const sink = new InstanceSink([caseDbInstance()]);
		expect(() =>
			sink.addOne({ id: "casedb", src: "jr://instance/session" }),
		).toThrow("two different sources");
	});
});
