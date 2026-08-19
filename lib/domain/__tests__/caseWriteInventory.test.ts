import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	type CaseType,
	caseWriteInventoryIssues,
	deriveCaseWriteInventory,
	type FormType,
	USERCASE_CASE_TYPE,
} from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";

const TYPES: CaseType[] = [
	{
		name: "parent",
		properties: [{ name: "case_name", label: proseText("Name") }],
	},
	{
		name: "child",
		parent_type: "parent",
		properties: [{ name: "case_name", label: proseText("Name") }],
	},
	{
		name: "grandchild",
		parent_type: "child",
		properties: [{ name: "case_name", label: proseText("Name") }],
	},
	{
		name: "other",
		properties: [{ name: "case_name", label: proseText("Name") }],
	},
	{
		name: "sibling_child",
		parent_type: "other",
		properties: [{ name: "case_name", label: proseText("Name") }],
	},
];

function inventory(args: {
	fields: Array<ReturnType<typeof f>>;
	formType?: FormType;
	moduleCaseType?: string;
	caseTypes?: CaseType[];
	/** Declared worker properties, by slug. Worker-record destinations must be
	 *  one of these, so a test that writes one has to declare it. */
	workerProperties?: readonly string[];
}) {
	const doc = buildDoc({
		appName: "Case write inventory",
		caseTypes: args.caseTypes ?? TYPES,
		modules: [
			{
				name: "Parents",
				...(args.moduleCaseType !== undefined && {
					caseType: args.moduleCaseType,
				}),
				forms: [
					{
						name: "Form",
						type: args.formType ?? "registration",
						fields: args.fields,
					},
				],
			},
		],
	});
	doc.userProperties = Object.fromEntries(
		(args.workerProperties ?? []).map((slug, index) => {
			const uuid = testUuid(`worker-property-${index}`);
			return [uuid, { uuid, slug, label: slug }];
		}),
	);
	const moduleUuid = doc.moduleOrder[0];
	const formUuid = doc.formOrder[moduleUuid][0];
	return deriveCaseWriteInventory(
		doc,
		formUuid,
		doc.modules[moduleUuid],
		doc.forms[formUuid].type,
	);
}

function writer(
	id: string,
	caseType: string,
	property: string,
): ReturnType<typeof f> {
	return f({
		kind: "text",
		id,
		label: proseText(id),
		caseWrite: { caseType, property },
	});
}

describe("deriveCaseWriteInventory", () => {
	it("returns the exact empty shape for no-writer survey and module-less forms", () => {
		for (const args of [
			{ formType: "survey" as const, moduleCaseType: "parent" },
			{ formType: "registration" as const, moduleCaseType: undefined },
		]) {
			expect(
				inventory({
					...args,
					fields: [f({ kind: "text", id: "note" })],
				}),
			).toEqual({
				writers: [],
				buckets: [],
				noActionWriters: [],
				invalidDestinationWriters: [],
			});
		}
	});

	it("classifies authored survey and module-less writers as no-action", () => {
		for (const args of [
			{ formType: "survey" as const, moduleCaseType: "parent" },
			{ formType: "registration" as const, moduleCaseType: undefined },
		]) {
			const result = inventory({
				...args,
				fields: [writer("name", "parent", "case_name")],
			});
			expect(result.buckets).toEqual([]);
			expect(result.noActionWriters).toHaveLength(1);
			expect(caseWriteInventoryIssues(result)[0]?.kind).toBe("no-case-action");
		}
	});

	it("admits only the module type and its exact direct children", () => {
		const result = inventory({
			moduleCaseType: "parent",
			fields: [
				writer("parent_name", "parent", "case_name"),
				writer("child_name", "child", "case_name"),
				writer("grandchild_name", "grandchild", "case_name"),
				writer("other_name", "other", "case_name"),
				writer("sibling_name", "sibling_child", "case_name"),
				writer("unknown_name", "missing", "case_name"),
			],
		});

		expect(
			result.buckets.map((bucket) => [bucket.kind, bucket.caseType]),
		).toEqual([
			["primary", "parent"],
			["child", "child"],
		]);
		expect(
			result.invalidDestinationWriters.map(({ writer, reason }) => [
				writer.caseType,
				reason,
			]),
		).toEqual([
			["grandchild", "not-direct-child"],
			["other", "not-direct-child"],
			["sibling_child", "not-direct-child"],
			["missing", "unknown-type"],
		]);
	});

	it("keys cousin and root/repeat child creates by repeat UUID, never repeat id", () => {
		const childName = () => writer("child_name", "child", "case_name");
		const repeat = () =>
			f({
				kind: "repeat",
				id: "kids",
				repeat_mode: "user_controlled",
				children: [childName()],
			});
		const result = inventory({
			moduleCaseType: "parent",
			fields: [
				writer("parent_name", "parent", "case_name"),
				childName(),
				f({ kind: "group", id: "left", children: [repeat()] }),
				f({ kind: "group", id: "right", children: [repeat()] }),
			],
		});
		const children = result.buckets.filter((bucket) => bucket.kind === "child");

		expect(children).toHaveLength(3);
		expect(children.map((bucket) => bucket.repeatId)).toEqual([
			undefined,
			"kids",
			"kids",
		]);
		expect(new Set(children.map((bucket) => bucket.repeatUuid)).size).toBe(3);
		expect(children[1].repeatUuid).not.toBe(children[2].repeatUuid);
		expect(children[1].writers[0].path.map((step) => step.fieldId)).toEqual([
			"left",
			"kids",
			"child_name",
		]);
	});

	it("records query-bound iteration on the repeat path segment", () => {
		const result = inventory({
			moduleCaseType: "parent",
			fields: [
				writer("parent_name", "parent", "case_name"),
				f({
					kind: "repeat",
					id: "items",
					repeat_mode: "query_bound",
					data_source: { ids_query: "instance('casedb')/casedb/case" },
					children: [writer("child_name", "child", "case_name")],
				}),
			],
		});
		const child = result.buckets.find((bucket) => bucket.kind === "child");
		expect(child?.repeatPath).toMatchObject([
			{ fieldId: "items", queryBoundIteration: true },
		]);
		expect(child?.writers[0].path).toMatchObject([
			{ fieldId: "items", queryBoundIteration: true },
			{ fieldId: "child_name", queryBoundIteration: false },
		]);
	});

	it("owns duplicate, create-name, and primary-repeat admission", () => {
		const result = inventory({
			moduleCaseType: "parent",
			fields: [
				f({
					kind: "repeat",
					id: "rows",
					repeat_mode: "user_controlled",
					children: [
						writer("parent_name", "parent", "case_name"),
						writer("value_a", "parent", "value"),
						writer("value_b", "parent", "value"),
					],
				}),
				writer("child_value", "child", "value"),
			],
		});
		expect(caseWriteInventoryIssues(result).map((issue) => issue.kind)).toEqual(
			[
				"primary-writer-in-repeat",
				"primary-writer-in-repeat",
				"primary-writer-in-repeat",
				"duplicate-property",
				"create-name-missing",
			],
		);
	});

	it("allows zero or one update case_name writer and rejects two", () => {
		for (const count of [0, 1, 2]) {
			const result = inventory({
				formType: "followup",
				moduleCaseType: "parent",
				fields: Array.from({ length: count }, (_, index) =>
					writer(`name_${index}`, "parent", "case_name"),
				),
			});
			expect(
				caseWriteInventoryIssues(result).map((issue) => issue.kind),
			).toEqual(count < 2 ? [] : ["duplicate-property"]);
		}
	});
});

describe("the worker's own record as a destination", () => {
	it("buckets a declared worker property, with no repeat identity", () => {
		// A FIXED destination, unlike `child`: one form writes one worker
		// record, so the bucket never keys on a repeat.
		const result = inventory({
			moduleCaseType: "parent",
			formType: "followup",
			workerProperties: ["visits_done"],
			fields: [writer("visits", USERCASE_CASE_TYPE, "visits_done")],
		});

		const bucket = result.buckets.find((b) => b.kind === "usercase");
		expect(bucket?.action).toBe("update");
		expect(bucket?.caseType).toBe(USERCASE_CASE_TYPE);
		expect(bucket?.repeatUuid).toBeUndefined();
		expect(bucket?.writers.map((w) => w.property)).toEqual(["visits_done"]);
	});

	it("buckets it on a survey form, which has no case type of its own", () => {
		// HQ's `usercase_update` is a form action on any module form, and a
		// survey form is exactly that. Refusing it here would refuse the write
		// on the form type where it is most often the only write there is.
		const result = inventory({
			formType: "survey",
			moduleCaseType: "parent",
			workerProperties: ["visits_done"],
			fields: [writer("visits", USERCASE_CASE_TYPE, "visits_done")],
		});

		expect(result.buckets.map((b) => b.kind)).toEqual(["usercase"]);
		expect(result.noActionWriters).toEqual([]);
	});

	it("still calls an ordinary case writer on a survey form no-action", () => {
		const result = inventory({
			formType: "survey",
			moduleCaseType: "parent",
			workerProperties: ["visits_done"],
			fields: [
				writer("visits", USERCASE_CASE_TYPE, "visits_done"),
				writer("note", "parent", "note"),
			],
		});

		expect(result.noActionWriters.map((w) => w.fieldId)).toEqual(["note"]);
	});

	it("refuses a destination no worker property declares", () => {
		// The slug IS the XML element name on the wire, and the derived case
		// type carries `additionalProperties: false`, so an undeclared
		// destination is unstorable rather than merely unwise. Refusing it here
		// means an author is told at authoring time instead of at submission.
		const result = inventory({
			moduleCaseType: "parent",
			formType: "followup",
			workerProperties: ["visits_done"],
			fields: [writer("visits", USERCASE_CASE_TYPE, "not_declared")],
		});

		expect(result.buckets.some((b) => b.kind === "usercase")).toBe(false);
		expect(result.invalidDestinationWriters).toEqual([
			{
				writer: expect.objectContaining({ fieldId: "visits" }),
				reason: "usercase-property-undeclared",
			},
		]);
	});

	it("refuses a destination materialization owns", () => {
		// `username` and its siblings are written on every sync from the
		// worker's profile, so a form answer there would be replaced the next
		// time that worker changed. Silently, and only later.
		for (const managed of ["username", "language", "case_name", "hq_user_id"]) {
			const result = inventory({
				moduleCaseType: "parent",
				formType: "followup",
				workerProperties: [managed],
				fields: [writer("visits", USERCASE_CASE_TYPE, managed)],
			});
			expect(
				result.invalidDestinationWriters[0]?.reason,
				`${managed} should be refused`,
			).toBe("usercase-property-managed");
		}
	});

	it("refuses a writer inside a repeat", () => {
		// One form writes ONE worker record: the emitted block binds to a single
		// `usercase_id` datum, so every iteration would compete for the same
		// slot and the last would quietly win.
		const result = inventory({
			moduleCaseType: "parent",
			formType: "followup",
			workerProperties: ["visits_done"],
			fields: [
				f({
					kind: "repeat",
					id: "visits",
					label: proseText("Visits"),
					children: [writer("count", USERCASE_CASE_TYPE, "visits_done")],
				}),
			],
		});

		expect(
			caseWriteInventoryIssues(result).map((issue) => issue.kind),
		).toContain("usercase-writer-in-repeat");
	});
});
