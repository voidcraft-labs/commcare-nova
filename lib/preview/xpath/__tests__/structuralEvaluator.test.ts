import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { xformDataRootRuntimeAttributes } from "@/lib/commcare/xform/dataRootAttributes";
import type { Field, Uuid } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { DataInstance } from "../../engine/dataInstance";
import { buildFieldTree } from "../../engine/fieldTree";
import { xpathNodeAtPath } from "../../engine/xpathInstances";
import { evaluate, evaluateRuntime } from "../evaluator";
import { isXPathNodeSet } from "../runtimeValues";
import type { EvalContext } from "../types";

function repeatedInstance() {
	const repeatUuid = testUuid("repeat");
	const valueUuid = testUuid("repeat.value");
	const rankUuid = testUuid("repeat.rank");
	const fields: Record<string, Field> = {
		[repeatUuid]: {
			uuid: repeatUuid,
			id: "items",
			kind: "repeat",
			label: proseText("Items"),
			repeat_mode: "user_controlled",
		} as Field,
		[valueUuid]: {
			uuid: valueUuid,
			id: "value",
			kind: "text",
			label: proseText("Value"),
		} as Field,
		[rankUuid]: {
			uuid: rankUuid,
			id: "rank",
			kind: "int",
			label: proseText("Rank"),
		} as Field,
	};
	const root = testUuid("form");
	const order: Record<string, Uuid[]> = {
		[root]: [repeatUuid],
		[repeatUuid]: [valueUuid, rankUuid],
	};
	const data = new DataInstance();
	data.initFromFields(buildFieldTree(root, fields, order));
	data.addRepeatInstance("/data/items");
	data.set("/data/items[0]/value", "a");
	data.set("/data/items[0]/rank", "10");
	data.set("/data/items[1]/value", "b");
	data.set("/data/items[1]/rank", "20");
	return data;
}

function nestedRepeatedInstance() {
	const orderUuid = testUuid("nested.orders");
	const lineUuid = testUuid("nested.lines");
	const valueUuid = testUuid("nested.value");
	const fields: Record<string, Field> = {
		[orderUuid]: {
			uuid: orderUuid,
			id: "orders",
			kind: "repeat",
			label: proseText("Orders"),
			repeat_mode: "user_controlled",
		} as Field,
		[lineUuid]: {
			uuid: lineUuid,
			id: "lines",
			kind: "repeat",
			label: proseText("Lines"),
			repeat_mode: "user_controlled",
		} as Field,
		[valueUuid]: {
			uuid: valueUuid,
			id: "value",
			kind: "text",
			label: proseText("Value"),
		} as Field,
	};
	const root = testUuid("nested.form");
	const order: Record<string, Uuid[]> = {
		[root]: [orderUuid],
		[orderUuid]: [lineUuid],
		[lineUuid]: [valueUuid],
	};
	const data = new DataInstance();
	data.initFromFields(buildFieldTree(root, fields, order));
	data.addRepeatInstance("/data/orders[0]/lines");
	data.addRepeatInstance("/data/orders");
	data.addRepeatInstance("/data/orders[1]/lines");
	data.set("/data/orders[0]/lines[0]/value", "first-order-first-line");
	data.set("/data/orders[0]/lines[1]/value", "first-order-second-line");
	data.set("/data/orders[1]/lines[0]/value", "second-order-first-line");
	data.set("/data/orders[1]/lines[1]/value", "second-order-second-line");
	return data;
}

function contextAt(data: DataInstance, contextPath: string): EvalContext {
	const mainInstance = data.asXPathInstance();
	const contextNode = xpathNodeAtPath(mainInstance, contextPath);
	if (contextNode === undefined)
		throw new Error("Fixture context node is missing.");
	return {
		mainInstance,
		contextNode,
		originalContextNode: contextNode,
		contextPath,
		position: undefined,
		getValue: (path) => data.get(path),
		resolveHashtag: () => "",
	};
}

function context(
	data: DataInstance,
	contextPath = "/data/items[0]/value",
	relevant: (path: string) => boolean = () => true,
): EvalContext {
	const mainInstance = data.asXPathInstance(relevant);
	const dataNode = mainInstance.root().children("data")[0];
	const repeatIndex = Number.parseInt(
		/\/items\[(\d+)\]/.exec(contextPath)?.[1] ?? "0",
		10,
	);
	const item = dataNode?.children("items")[repeatIndex];
	const fieldName = contextPath.split("/").at(-1) ?? "value";
	const contextNode = item?.children(fieldName)[0];
	if (!contextNode) throw new Error("Fixture context node is missing.");
	return {
		mainInstance,
		contextNode,
		originalContextNode: contextNode,
		contextPath,
		position: undefined,
		getValue: (path) => data.get(path),
		resolveHashtag: () => "",
	};
}

describe("structural XPath evaluation", () => {
	it("projects the emitted primary-instance root attributes", () => {
		const data = new DataInstance(
			xformDataRootRuntimeAttributes("Household Follow-up"),
		);
		data.initFromFields([]);
		const ctx = contextForRoot(data);
		expect(evaluate("/data/@version", ctx)).toBe("1");
		expect(evaluate("/data/@uiVersion", ctx)).toBe("1");
		expect(evaluate("/data/@name", ctx)).toBe("household_follow_up");
	});

	it("unpacks selected coalesce nodesets after Core's eager argument pass", () => {
		const data = repeatedInstance();
		const ctx = contextForRoot(data);
		expect(
			evaluateRuntime(
				"coalesce(/data/items[1]/value, /data/items[2]/value)",
				ctx,
			),
		).toBe("a");
		expect(() =>
			evaluate(
				"count(coalesce(/data/items[1]/value, /data/items[2]/value))",
				ctx,
			),
		).toThrow("requires a nodeset");
	});

	it("does not scalar-coerce a calendar supplied as a path", () => {
		const data = repeatedInstance();
		data.set("/data/items[0]/value", "ethiopian");
		expect(() =>
			evaluate(
				"format-date-for-calendar(today(), /data/items[1]/value)",
				contextForRoot(data),
			),
		).toThrow("Unsupported calendar type");
	});

	it("retains ordered repeated nodes and refuses implicit many-node coercion", () => {
		const data = repeatedInstance();
		const result = evaluateRuntime("/data/items/value", contextForRoot(data));
		expect(isXPathNodeSet(result)).toBe(true);
		if (!isXPathNodeSet(result)) return;
		expect(result.nodes.map((node) => node.path)).toEqual([
			"/data/items[0]/value",
			"/data/items[1]/value",
		]);
		expect(() => evaluate("/data/items/value", contextForRoot(data))).toThrow(
			"more than one node",
		);
	});

	it("contextualizes an unbound absolute path to the active repeat", () => {
		const data = repeatedInstance();
		expect(
			evaluate("/data/items/value", context(data, "/data/items[1]/rank")),
		).toBe("b");
		expect(
			evaluate("/data/items/rank", context(data, "/data/items[1]/value")),
		).toBe(20);
	});

	it("contextualizes a deeper repeat after an earlier step is explicitly bound", () => {
		const data = nestedRepeatedInstance();
		expect(
			evaluate(
				"/data/orders[1]/lines/value",
				contextAt(data, "/data/orders[0]/lines[1]/value"),
			),
		).toBe("first-order-second-line");
	});

	it("evaluates predicates relative to each candidate with Core positions", () => {
		const data = repeatedInstance();
		expect(evaluate("/data/items[value = 'b']/rank", context(data))).toBe(20);
		expect(evaluate("/data/items[2]/value", context(data))).toBe("b");
		expect(evaluate("/data/items[position() = 2]/value", context(data))).toBe(
			"b",
		);
	});

	it("preserves current() while a predicate changes the context node", () => {
		const data = repeatedInstance();
		expect(
			evaluate(
				"/data/items[value = current()]/rank",
				context(data, "/data/items[0]/value"),
			),
		).toBe(10);
	});

	it("uses zero-based node multiplicity for position(reference)", () => {
		const data = repeatedInstance();
		expect(evaluate("position(/data/items[2])", context(data))).toBe(1);
	});

	it("uses the context reference's zero-based multiplicity outside predicates", () => {
		const data = repeatedInstance();
		expect(evaluate("position()", context(data, "/data/items[1]/value"))).toBe(
			0,
		);
	});

	it("rebases canonical form references onto the active repeat", () => {
		const data = repeatedInstance();
		const secondItem = context(data, "/data/items[1]/value");
		expect(evaluate("#form/items/value", secondItem)).toBe("b");
		expect(evaluate("#form/items/rank", secondItem)).toBe(20);
	});

	it("keeps #form structural when a custom hashtag resolver is installed", () => {
		const data = repeatedInstance();
		const outsideRepeat = contextForRoot(data);
		outsideRepeat.resolveHashtagValue = () => "collapsed";

		expect(evaluate("count(#form/items/value)", outsideRepeat)).toBe(2);
	});

	it("traverses wildcard, self, and parent steps without losing order", () => {
		const data = repeatedInstance();
		const children = evaluateRuntime("/data/items[2]/*", context(data));
		expect(isXPathNodeSet(children)).toBe(true);
		if (!isXPathNodeSet(children)) return;
		expect(children.nodes.map((node) => node.name)).toEqual(["value", "rank"]);
		expect(evaluate("/data/items[2]/self::items/value", context(data))).toBe(
			"b",
		);
		expect(
			evaluate("/data/items[2]/value/parent::items/rank", context(data)),
		).toBe(20);
	});

	it("filters irrelevant nodes during nodeset expansion", () => {
		const data = repeatedInstance();
		const result = evaluateRuntime(
			"/data/items/value",
			context(data, "/data/items[0]/value", (path) => !path.includes("[1]")),
		);
		expect(isXPathNodeSet(result)).toBe(true);
		if (!isXPathNodeSet(result)) return;
		expect(result.nodes.map((node) => node.value())).toEqual(["a"]);
	});

	it("assigns predicate positions before filtering irrelevant results", () => {
		const data = repeatedInstance();
		const secondOnly = context(
			data,
			"/data/items[1]/value",
			(path) => !path.includes("[0]"),
		);
		expect(evaluate("/data/items[position() = 2]/value", secondOnly)).toBe("b");
		expect(evaluate("/data/items[1]/value", secondOnly)).toBe("");
	});

	it("represents an authored repeat with zero live instances", () => {
		const data = repeatedInstance();
		data.setRepeatCount("/data/items", 0);
		const empty = evaluateRuntime("/data/items/value", contextForRoot(data));
		expect(isXPathNodeSet(empty)).toBe(true);
		if (!isXPathNodeSet(empty)) return;
		expect(empty.validPath).toBe(true);
		expect(empty.nodes).toHaveLength(0);
		const invalid = evaluateRuntime(
			"/data/items/not_authored",
			contextForRoot(data),
		);
		expect(isXPathNodeSet(invalid)).toBe(true);
		if (!isXPathNodeSet(invalid)) return;
		expect(invalid.validPath).toBe(false);
		expect(() =>
			evaluate("/data/items/not_authored", contextForRoot(data)),
		).toThrow("does not exist in the instance");

		data.setRepeatCount("/data/items", 1);
		expect(evaluate("/data/items/value", context(data))).toBe("");
	});
});

function contextForRoot(data: DataInstance): EvalContext {
	const mainInstance = data.asXPathInstance();
	return {
		mainInstance,
		contextNode: mainInstance.root(),
		originalContextNode: mainInstance.root(),
		contextPath: "/",
		position: undefined,
		getValue: (path) => data.get(path),
		resolveHashtag: () => "",
	};
}
