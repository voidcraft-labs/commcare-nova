import { afterEach, describe, expect, it, vi } from "vitest";
import {
	caseDatabaseXPathInstance,
	previewHashtagNodeSet,
} from "../../engine/xpathInstances";
import { createInProcessXPathWorkerFactory } from "../inProcessWorkerClient";
import { XPathRuntime } from "../workerClient";
import {
	serializeXPathWorkerHashtagValue,
	snapshotXPathWorkerInstance,
} from "../workerProjection";
import type {
	XPathRuntimeRequest,
	XPathWorkerInstanceSnapshot,
	XPathWorkerNodeSnapshot,
} from "../workerProtocol";
import {
	asyncXPathWorkerFunctions,
	xpathRequiresAsyncWorker,
} from "../workerRuntime";

afterEach(() => vi.useRealTimers());

function node(
	name: string,
	path: string,
	value = "",
	children: readonly XPathWorkerNodeSnapshot[] = [],
): XPathWorkerNodeSnapshot {
	return {
		name,
		path,
		kind: "element",
		multiplicity: 0,
		value,
		relevant: true,
		children,
		attributes: [],
	};
}

function mainInstance(): XPathWorkerInstanceSnapshot {
	return {
		id: null,
		root: node("", "/", "", [
			node("data", "/data", "", [node("age", "/data/age", "41")]),
		]),
	};
}

function request(
	overrides: Partial<XPathRuntimeRequest> = {},
): XPathRuntimeRequest {
	return {
		entryKey: "entry-a",
		revision: 1,
		profile: "form",
		source: "/data/age + 1",
		instances: { main: mainInstance(), contextPath: "/data/age" },
		...overrides,
	};
}

describe("XPath worker runtime", () => {
	it("detects async functions from the parsed AST without substring guesses", () => {
		expect(
			asyncXPathWorkerFunctions(
				"if(regex('abc', 'b'), sleep(10, replace('a', 'a', 'x')), encrypt-string('a', 'b', 'AES'))",
			),
		).toEqual(new Set(["regex", "sleep", "replace", "encrypt-string"]));
		expect(xpathRequiresAsyncWorker("'sleep(10, value)'")).toBe(false);
	});

	it("evaluates Java Pattern only through the worker path", async () => {
		const runtime = new XPathRuntime({
			workerFactory: createInProcessXPathWorkerFactory(),
		});

		await expect(
			runtime.request(request({ source: "regex('cocotero', 'te')" })),
		).resolves.toMatchObject({ ok: true, value: true });
		await expect(
			runtime.request(
				request({ source: String.raw`replace('a1', '\d', '$1')` }),
			),
		).resolves.toMatchObject({ ok: true, value: "a$1" });
		runtime.dispose();
	});

	it("evaluates a structured-clone instance through the in-process adapter", async () => {
		const runtime = new XPathRuntime({
			workerFactory: createInProcessXPathWorkerFactory(),
		});

		await expect(runtime.request(request())).resolves.toEqual({
			ok: true,
			entryKey: "entry-a",
			revision: 1,
			profile: "form",
			value: 42,
		});
		await expect(
			runtime.request(request({ source: "count(#form/age)" })),
		).resolves.toMatchObject({ ok: true, value: 1 });
		runtime.dispose();
	});

	it("preserves dynamic casedb child schemas through structured clone", async () => {
		const runtime = new XPathRuntime({
			workerFactory: createInProcessXPathWorkerFactory(),
		});
		const casedb = caseDatabaseXPathInstance({
			rows: [
				{
					case_id: "case-1",
					app_id: "app",
					case_type: "patient",
					owner_id: "worker",
					status: "open",
					opened_on: new Date("2026-08-01T00:00:00.000Z"),
					modified_on: new Date("2026-08-02T00:00:00.000Z"),
					closed_on: null,
					case_name: "Case",
					external_id: null,
					parent_case_id: null,
					properties: {},
				},
			],
			indices: [
				{
					case_id: "case-1",
					ancestor_id: "parent-1",
					identifier: "parent",
					relationship: "child",
					depth: 1,
					target_case_type: "household",
				},
			],
		});

		await expect(
			runtime.request(
				request({
					source:
						"count(instance('casedb')/casedb/case[@case_id='case-1']/not_yet_written)",
					instances: {
						main: mainInstance(),
						secondary: [snapshotXPathWorkerInstance(casedb)],
						contextPath: "/data/age",
					},
				}),
			),
		).resolves.toMatchObject({ ok: true, value: 0 });
		await expect(
			runtime.request(
				request({
					source:
						"count(instance('casedb')/casedb/case[@case_id='case-1']/index/not_yet_written) + count(instance('casedb')/casedb/case[@case_id='case-1']/index/not_yet_written/@case_type) + count(instance('casedb')/casedb/case[@case_id='case-1']/index/not_yet_written/@relationship)",
					instances: {
						main: mainInstance(),
						secondary: [snapshotXPathWorkerInstance(casedb)],
						contextPath: "/data/age",
					},
				}),
			),
		).resolves.toMatchObject({ ok: true, value: 0 });
		runtime.dispose();
	});

	it("preserves hashtag nodesets through structured clone", async () => {
		const runtime = new XPathRuntime({
			workerFactory: createInProcessXPathWorkerFactory(),
		});
		const casedb = caseDatabaseXPathInstance({
			rows: [
				{
					case_id: "case-1",
					app_id: "app",
					case_type: "patient",
					owner_id: "worker",
					status: "open",
					opened_on: new Date("2026-08-01T00:00:00.000Z"),
					modified_on: new Date("2026-08-02T00:00:00.000Z"),
					closed_on: null,
					case_name: "Case",
					external_id: null,
					parent_case_id: null,
					properties: { status_text: "open" },
				},
			],
			indices: [],
		});
		const reference = "#patient/status_text";
		const nodeset = previewHashtagNodeSet(reference, {
			casedb,
			caseData: new Map([["patient", new Map([["case_id", "case-1"]])]]),
			userId: undefined,
		});
		expect(nodeset).toBeDefined();

		await expect(
			runtime.request(
				request({
					source: `count(${reference})`,
					instances: {
						main: mainInstance(),
						secondary: [snapshotXPathWorkerInstance(casedb)],
						hashtagValues: [
							serializeXPathWorkerHashtagValue(reference, nodeset ?? ""),
						],
						contextPath: "/data/age",
					},
				}),
			),
		).resolves.toMatchObject({ ok: true, value: 1 });
		runtime.dispose();
	});

	it("contextualizes async absolute paths to the active repeat", async () => {
		const runtime = new XPathRuntime({
			workerFactory: createInProcessXPathWorkerFactory(),
		});
		const first = {
			...node("items", "/data/items[0]", "", [
				node("value", "/data/items[0]/value", "a"),
			]),
			multiplicity: 0,
		};
		const second = {
			...node("items", "/data/items[1]", "", [
				node("value", "/data/items[1]/value", "b"),
			]),
			multiplicity: 1,
		};

		await expect(
			runtime.request(
				request({
					source: "sleep(0, /data/items/value)",
					instances: {
						main: {
							id: null,
							root: node("", "/", "", [
								node("data", "/data", "", [first, second]),
							]),
						},
						contextPath: "/data/items[1]/value",
						contextNode: {
							instanceId: null,
							path: "/data/items[1]/value",
						},
						originalContextNode: {
							instanceId: null,
							path: "/data/items[1]/value",
						},
					},
				}),
			),
		).resolves.toMatchObject({ ok: true, value: "b" });
		runtime.dispose();
	});

	it("contextualizes a deeper async repeat after an earlier predicate", async () => {
		const runtime = new XPathRuntime({
			workerFactory: createInProcessXPathWorkerFactory(),
		});
		const line = (
			orderIndex: number,
			lineIndex: number,
			value: string,
		): XPathWorkerNodeSnapshot => ({
			...node("lines", `/data/orders[${orderIndex}]/lines[${lineIndex}]`, "", [
				node(
					"value",
					`/data/orders[${orderIndex}]/lines[${lineIndex}]/value`,
					value,
				),
			]),
			multiplicity: lineIndex,
		});
		const order = (
			orderIndex: number,
			values: readonly string[],
		): XPathWorkerNodeSnapshot => ({
			...node(
				"orders",
				`/data/orders[${orderIndex}]`,
				"",
				values.map((value, lineIndex) => line(orderIndex, lineIndex, value)),
			),
			multiplicity: orderIndex,
		});

		await expect(
			runtime.request(
				request({
					source: "sleep(0, /data/orders[1]/lines/value)",
					instances: {
						main: {
							id: null,
							root: node("", "/", "", [
								node("data", "/data", "", [
									order(0, ["first", "wanted"]),
									order(1, ["other", "also-other"]),
								]),
							]),
						},
						contextPath: "/data/orders[0]/lines[1]/value",
						contextNode: {
							instanceId: null,
							path: "/data/orders[0]/lines[1]/value",
						},
						originalContextNode: {
							instanceId: null,
							path: "/data/orders[0]/lines[1]/value",
						},
					},
				}),
			),
		).resolves.toMatchObject({ ok: true, value: "wanted" });
		runtime.dispose();
	});

	it("reuses one worker world and applies only later value deltas", async () => {
		const runtime = new XPathRuntime({
			workerFactory: createInProcessXPathWorkerFactory(),
		});
		await expect(
			runtime.request(
				request({
					source: "/data/age",
					instances: {
						worldKey: "world-1",
						initializeWorld: true,
						main: mainInstance(),
						contextPath: "/data/age",
					},
				}),
			),
		).resolves.toMatchObject({ ok: true, value: "41" });

		await expect(
			runtime.request(
				request({
					source: "/data/age + 1",
					instances: {
						worldKey: "world-1",
						initializeWorld: false,
						pathValues: [{ path: "/data/age", value: "43" }],
						contextPath: "/data/age",
					},
				}),
			),
		).resolves.toMatchObject({ ok: true, value: 44 });
		await expect(
			runtime.request(
				request({
					source: "boolean(/data/age)",
					instances: {
						worldKey: "world-1",
						initializeWorld: false,
						pathValues: [{ path: "/data/age", value: 0 }],
						contextPath: "/data/age",
					},
				}),
			),
		).resolves.toMatchObject({ ok: true, value: false });
		runtime.dispose();
	});

	it("applies effective relevance deltas to a cached worker world", async () => {
		const runtime = new XPathRuntime({
			workerFactory: createInProcessXPathWorkerFactory(),
		});
		const groupedMain: XPathWorkerInstanceSnapshot = {
			id: null,
			root: node("", "/", "", [
				node("data", "/data", "", [
					node("group", "/data/group", "", [
						node("answer", "/data/group/answer", "kept"),
					]),
				]),
			]),
		};
		await expect(
			runtime.request(
				request({
					source: "count(/data/group/answer)",
					instances: {
						worldKey: "relevance-world",
						initializeWorld: true,
						main: groupedMain,
						contextPath: "/data/group/answer",
					},
				}),
			),
		).resolves.toMatchObject({ ok: true, value: 1 });

		await expect(
			runtime.request(
				request({
					source: "count(/data/group/answer)",
					instances: {
						worldKey: "relevance-world",
						initializeWorld: false,
						pathRelevance: [
							{ path: "/data/group", relevant: false },
							{ path: "/data/group/answer", relevant: false },
						],
						contextPath: "/data/group/answer",
					},
				}),
			),
		).resolves.toMatchObject({ ok: true, value: 0 });
		runtime.dispose();
	});

	it("evaluates async functions through the worker-owned tools", async () => {
		const runtime = new XPathRuntime({
			workerFactory: createInProcessXPathWorkerFactory(),
		});

		await expect(
			runtime.request(request({ source: "sleep(0, 'now-runnable')" })),
		).resolves.toEqual({
			ok: true,
			entryKey: "entry-a",
			revision: 1,
			profile: "form",
			value: "now-runnable",
		});
		runtime.dispose();
	});

	it("returns structural nodeset values without cloning nodes back", async () => {
		const runtime = new XPathRuntime({
			workerFactory: createInProcessXPathWorkerFactory(),
		});
		const items = node("items", "/data/items", "", [
			node("item", "/data/items/item", "a"),
			node("item", "/data/items/item[1]", "b"),
		]);
		await expect(
			runtime.request(
				request({
					source: "/data/items/item",
					resultMode: "nodeset-values-or-scalar",
					instances: {
						main: {
							id: null,
							root: node("", "/", "", [node("data", "/data", "", [items])]),
						},
						contextPath: "/data/items",
					},
				}),
			),
		).resolves.toMatchObject({
			ok: true,
			value: "",
			nodesetValues: ["a", "b"],
		});
		runtime.dispose();
	});

	it("preserves the active locale through worker evaluation", async () => {
		const runtime = new XPathRuntime({
			workerFactory: createInProcessXPathWorkerFactory(),
		});

		await expect(
			runtime.request(
				request({
					source:
						"sleep(0, format-date-for-calendar('2017-07-15', 'ethiopian'))",
					instances: {
						main: mainInstance(),
						contextPath: "/data/age",
						locale: "amh",
					},
				}),
			),
		).resolves.toMatchObject({ ok: true, value: "8 ሐምሌ 2009" });
		runtime.dispose();
	});

	it("runs delay in the worker owner and cancels it without leaking a timer", async () => {
		vi.useFakeTimers();
		const runtime = new XPathRuntime({
			workerFactory: createInProcessXPathWorkerFactory(
				async (_request, tools) => {
					await tools.delay(60_000);
					return "late";
				},
			),
		});
		const cancellation = new AbortController();
		const result = runtime.request(request(), { signal: cancellation.signal });
		await vi.advanceTimersByTimeAsync(0);
		expect(vi.getTimerCount()).toBe(1);

		cancellation.abort();
		await expect(result).resolves.toEqual({
			ok: false,
			error: {
				code: "cancelled",
				operation: "evaluate",
				entryKey: "entry-a",
				revision: 1,
				profile: "form",
			},
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(vi.getTimerCount()).toBe(0);
		runtime.dispose();
	});

	it("lets JavaRosa sleep outlive the CPU watchdog", async () => {
		vi.useFakeTimers();
		const runtime = new XPathRuntime({
			workerFactory: createInProcessXPathWorkerFactory(),
			requestTimeoutMilliseconds: 25,
		});
		const result = runtime.request(
			request({ source: "sleep(100, 'after-yield')" }),
		);
		await vi.advanceTimersByTimeAsync(0);
		// The sleep timer remains; the host watchdog is paused.
		expect(vi.getTimerCount()).toBe(1);
		await vi.advanceTimersByTimeAsync(100);

		await expect(result).resolves.toMatchObject({
			ok: true,
			value: "after-yield",
		});
		expect(vi.getTimerCount()).toBe(0);
		runtime.dispose();
	});

	it("redacts source, values, and paths from evaluation failures", async () => {
		const runtime = new XPathRuntime({
			workerFactory: createInProcessXPathWorkerFactory(() => {
				throw new Error("secret-expression secret-value /secret/path case-id");
			}),
		});
		const result = await runtime.request(
			request({
				source: "secret-expression",
				instances: {
					contextPath: "/secret/path",
					pathValues: [{ path: "/secret/path", value: "secret-value" }],
				},
			}),
		);

		expect(result).toEqual({
			ok: false,
			error: {
				code: "evaluation-failed",
				operation: "evaluate",
				entryKey: "entry-a",
				revision: 1,
				profile: "form",
			},
		});
		const exposed = JSON.stringify(result);
		expect(exposed).not.toContain("secret-expression");
		expect(exposed).not.toContain("secret-value");
		expect(exposed).not.toContain("/secret/path");
		expect(exposed).not.toContain("case-id");
		runtime.dispose();
	});
});
