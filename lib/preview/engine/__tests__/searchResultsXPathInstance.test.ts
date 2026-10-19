import { describe, expect, it } from "vitest";
import type { CaseType } from "@/lib/domain";
import { proseText } from "@/lib/domain";
import { evaluate } from "../../xpath/evaluator";
import type { XPathInstance, XPathNode } from "../../xpath/runtimeValues";
import { isXPathDate } from "../../xpath/types";
import {
	caseDatabaseXPathInstance,
	type SearchResultRow,
	searchResultsXPathInstance,
} from "../xpathInstances";

/**
 * The shape HQ gives the inline search's results instance
 * (`corehq/ex-submodules/casexml/apps/case/xml/generator.py::CaseDBXMLGenerator`),
 * held against Preview's builder over fixed rows. A device reads this
 * instance's text exactly as HQ wrote it, which is not how Core types a
 * casedb row (`DateData` days), so a casedb-shaped row standing in for a
 * results row would change what a form reads.
 */

const patient: CaseType = {
	name: "patient",
	properties: [
		{ name: "district", label: proseText("District") },
		{ name: "seen_at", label: proseText("Seen at"), data_type: "datetime" },
		{ name: "weight", label: proseText("Weight"), data_type: "decimal" },
	],
};

function result(overrides: Partial<SearchResultRow> = {}): SearchResultRow {
	return {
		case_id: "p-1",
		case_type: "patient",
		owner_id: "worker-1",
		case_name: "Ada",
		opened_on: "2026-08-01T23:30:00.000Z",
		modified_on: "2026-08-02T04:05:06.789Z",
		external_id: null,
		properties: {
			district: "north",
			seen_at: "2026-08-02T04:30:00+05:00",
			weight: 3,
		},
		indices: [],
		...overrides,
	};
}

const rows = [
	result(),
	result({
		case_id: "p-2",
		case_name: "Grace",
		external_id: "EXT-2",
		properties: { district: "south" },
		indices: [
			{
				identifier: "parent",
				ancestor_id: "h-1",
				target_case_type: "household",
				relationship: "child",
			},
			{
				identifier: "host",
				ancestor_id: "h-2",
				target_case_type: "household",
				relationship: "extension",
			},
		],
	}),
];

function context(instance: XPathInstance) {
	return {
		contextPath: "/data",
		position: undefined,
		getValue: () => undefined,
		mainInstance: instance,
		resolveXPathInstance: (id: string) =>
			id === instance.id ? instance : undefined,
	};
}

function caseNode(instance: XPathInstance, caseId: string): XPathNode {
	const node = instance
		.root()
		.children("results")[0]
		?.children("case")
		.find(
			(candidate) => candidate.attributes("case_id")[0]?.value() === caseId,
		);
	if (node === undefined) throw new Error(`No case ${caseId}.`);
	return node;
}

describe("searchResultsXPathInstance", () => {
	const instance = searchResultsXPathInstance(rows, [patient]);
	const ctx = context(instance);
	const read = (caseId: string, step: string) =>
		evaluate(
			`instance('results:inline')/results/case[not(commcare_is_related_case = true())][@case_id = '${caseId}']/${step}`,
			ctx,
		);

	it("is the results:inline instance with HQ's root", () => {
		expect(instance.id).toBe("results:inline");
		expect(evaluate("instance('results:inline')/results/@id", ctx)).toBe(
			"case",
		);
		// The canonical print of the arm counts the cases the search found.
		expect(
			evaluate(
				"count(instance('results:inline')/results/case[not(commcare_is_related_case = true())])",
				ctx,
			),
		).toBe(2);
	});

	it("writes HQ's four attributes, every row open", () => {
		const node = caseNode(instance, "p-1");
		expect(node.attributes().map((attribute) => attribute.name)).toEqual([
			"case_id",
			"case_type",
			"owner_id",
			"status",
		]);
		expect(read("p-1", "@status")).toBe("open");
		expect(read("p-1", "@owner_id")).toBe("worker-1");
	});

	it("writes the children in HQ's order: name, last change, external id when set, opened day, properties, indices", () => {
		expect(
			caseNode(instance, "p-1")
				.children()
				.map((child) => child.name),
		).toEqual([
			"case_name",
			"last_modified",
			"date_opened",
			"district",
			"seen_at",
			"weight",
		]);
		expect(
			caseNode(instance, "p-2")
				.children()
				.map((child) => child.name),
		).toEqual([
			"case_name",
			"last_modified",
			"external_id",
			"date_opened",
			"district",
			"index",
		]);
	});

	it("prints last_modified as json_format_datetime: UTC, six fraction digits", () => {
		expect(read("p-1", "last_modified")).toBe("2026-08-02T04:05:06.789000Z");
	});

	it("prints date_opened as the UTC day of opened_on, as text", () => {
		// 23:30 UTC on the 1st is the 1st in UTC whatever the viewer's zone.
		expect(read("p-1", "date_opened")).toBe("2026-08-01");
		const value = caseNode(instance, "p-1").children("date_opened")[0]?.value();
		expect(isXPathDate(value)).toBe(false);
	});

	it("differs from a casedb row, whose system dates are device days", () => {
		const casedb = caseDatabaseXPathInstance(
			{
				rows: [
					{
						case_id: "p-1",
						app_id: "app",
						case_type: "patient",
						owner_id: "worker-1",
						status: "open",
						case_name: "Ada",
						external_id: null,
						opened_on: new Date("2026-08-01T23:30:00.000Z"),
						modified_on: new Date("2026-08-02T04:05:06.789Z"),
						closed_on: null,
						parent_case_id: null,
						properties: {},
					} as never,
				],
				indices: [],
			},
			[patient],
		);
		const value = casedb
			.root()
			.children("casedb")[0]
			?.children("case")[0]
			?.children("date_opened")[0]
			?.value();
		expect(isXPathDate(value)).toBe(true);
	});

	it("writes external_id only when the case has one", () => {
		expect(read("p-2", "external_id")).toBe("EXT-2");
		expect(
			evaluate(
				"count(instance('results:inline')/results/case[@case_id = 'p-1']/external_id)",
				ctx,
			),
		).toBe(0);
	});

	it("prints a datetime property as HQ stores it, the instant in UTC", () => {
		expect(read("p-1", "seen_at")).toBe("2026-08-01T23:30:00.000000Z");
		expect(read("p-1", "weight")).toBe("3.0");
		expect(read("p-1", "district")).toBe("north");
	});

	it("sorts indices by identifier and marks only an extension's relationship", () => {
		expect(
			caseNode(instance, "p-2")
				.children("index")[0]
				?.children()
				.map((child) => child.name),
		).toEqual(["host", "parent"]);
		expect(read("p-2", "index/parent")).toBe("h-1");
		expect(read("p-2", "index/parent/@case_type")).toBe("household");
		expect(
			evaluate(
				"count(instance('results:inline')/results/case[@case_id = 'p-2']/index/parent/@relationship)",
				ctx,
			),
		).toBe(0);
		expect(read("p-2", "index/host/@relationship")).toBe("extension");
	});

	it("holds no index element for a case with none, and no related cases", () => {
		expect(
			evaluate(
				"count(instance('results:inline')/results/case[@case_id = 'p-1']/index)",
				ctx,
			),
		).toBe(0);
		expect(
			evaluate(
				"count(instance('results:inline')/results/case[commcare_is_related_case = 'true'])",
				ctx,
			),
		).toBe(0);
	});

	it("reads an empty search as no cases", () => {
		expect(
			evaluate(
				"count(instance('results:inline')/results/case)",
				context(searchResultsXPathInstance([], [patient])),
			),
		).toBe(0);
	});
});
