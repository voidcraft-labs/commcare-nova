import { afterEach, describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { Field, Uuid } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { DataInstance } from "../../engine/dataInstance";
import { buildFieldTree } from "../../engine/fieldTree";
import { xpathNodeAtPath } from "../../engine/xpathInstances";
import { evaluateAsync, evaluateRuntimeAsync } from "../asyncEvaluator";
import { isXPathNodeSet } from "../runtimeValues";
import type { EvalContext } from "../types";

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

function fixture(relevant: (path: string) => boolean = () => true): {
	data: DataInstance;
	context: EvalContext;
} {
	const repeatUuid = testUuid("async-repeat");
	const valueUuid = testUuid("async-value");
	const rankUuid = testUuid("async-rank");
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
	const root = testUuid("async-form");
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
	const mainInstance = data.asXPathInstance(relevant);
	const contextNode = xpathNodeAtPath(mainInstance, "/data/items[0]/value");
	if (!contextNode) throw new Error("Missing test context node.");
	return {
		data,
		context: {
			mainInstance,
			contextNode,
			originalContextNode: contextNode,
			contextPath: contextNode.path,
			position: undefined,
			getValue: (path) => data.get(path),
			resolveHashtag: () => "",
		},
	};
}

function atMainRoot(context: EvalContext): EvalContext {
	const root = context.mainInstance?.root();
	if (root === undefined) throw new Error("Missing async fixture root.");
	return {
		...context,
		contextNode: root,
		originalContextNode: root,
		contextPath: "/",
	};
}

describe("async XPath evaluator", () => {
	it("does not execute unreachable conditional branches", async () => {
		const delay = vi.fn(async () => {
			throw new Error("unreachable");
		});
		const context = fixture().context;
		await expect(
			evaluateAsync("if(false(), sleep(1, 'bad'), 'ok')", context, {
				delay,
			}),
		).resolves.toBe("ok");
		await expect(
			evaluateAsync("cond(true(), 'yes', sleep(1, 'bad'))", context, {
				delay,
			}),
		).resolves.toBe("yes");
		await expect(
			evaluateAsync("true() or sleep(1, true())", context, { delay }),
		).resolves.toBe(true);
		await expect(
			evaluateAsync("false() and sleep(1, true())", context, { delay }),
		).resolves.toBe(false);
		expect(delay).not.toHaveBeenCalled();
	});

	it("preserves Core's eager coalesce pre-pass and scalar selection pass", async () => {
		const delay = vi.fn(async () => undefined);
		await expect(
			evaluateAsync("coalesce('first', sleep(1, 'later'))", fixture().context, {
				delay,
			}),
		).resolves.toBe("first");
		expect(delay).toHaveBeenCalledTimes(1);

		await expect(
			evaluateAsync("coalesce('first', sleep(-1, 'bad'))", fixture().context, {
				delay,
			}),
		).rejects.toThrow("nonnegative");
	});

	it("executes random(), uuid(), and the yielding call exactly once", async () => {
		const original = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
		const random = vi
			.spyOn(globalThis.crypto, "getRandomValues")
			.mockImplementation((array) => original(array));
		const delay = vi.fn(async () => undefined);
		await evaluateAsync(
			"sleep(0, concat(string(random()), uuid(4)))",
			fixture().context,
			{ delay },
		);
		expect(delay).toHaveBeenCalledTimes(1);
		expect(random).toHaveBeenCalledTimes(2);
	});

	it("preserves nodesets through nested sleep calls", async () => {
		const delay = vi.fn(async () => undefined);
		const context = fixture().context;
		const result = await evaluateRuntimeAsync(
			"sleep(0, sleep(0, /data/items))",
			atMainRoot(context),
			{ delay },
		);
		expect(isXPathNodeSet(result)).toBe(true);
		if (!isXPathNodeSet(result)) return;
		expect(result.nodes.map((node) => node.path)).toEqual([
			"/data/items[0]",
			"/data/items[1]",
		]);
		expect(delay).toHaveBeenCalledTimes(2);
	});

	it("uses Core's integer coercion before yielding", async () => {
		const delay = vi.fn(async () => undefined);
		await expect(
			evaluateAsync("sleep(1.9, 'done')", fixture().context, { delay }),
		).resolves.toBe("done");
		expect(delay).toHaveBeenCalledWith(1);
	});

	it("round-trips nested AES encryption and decryption", async () => {
		await expect(
			evaluateAsync(
				`decrypt-string(encrypt-string('Preview café', '${KEY}', 'AES'), '${KEY}', 'AES')`,
				fixture().context,
			),
		).resolves.toBe("Preview café");
	});

	it("evaluates Java Pattern regex and literal replacement", async () => {
		await expect(
			evaluateAsync("regex('cocotero', 'te')", fixture().context),
		).resolves.toBe(true);
		await expect(
			evaluateAsync(
				String.raw`replace('a1 b22', '\d+', '$1\tail')`,
				fixture().context,
			),
		).resolves.toBe("a$1\\tail b$1\\tail");
	});

	it("evaluates OpenJDK 17 named-character escapes", async () => {
		await expect(
			evaluateAsync(
				String.raw`regex('A一', '^\N{LATIN CAPITAL LETTER A}\N{CJK UNIFIED IDEOGRAPHS 4E00}$')`,
				fixture().context,
			),
		).resolves.toBe(true);
		await expect(
			evaluateAsync(
				String.raw`replace('A A', '\N{LATIN CAPITAL LETTER A}', '-')`,
				fixture().context,
			),
		).resolves.toBe("- -");
	});

	it("redacts invalid named-character patterns", async () => {
		const privateName = "PRIVATE APP VALUE";
		try {
			await evaluateAsync(
				String.raw`regex('A', '\N{PRIVATE APP VALUE}')`,
				fixture().context,
			);
			throw new Error("Expected the invalid pattern to fail.");
		} catch (error) {
			expect(String(error)).toContain("The regular expression is invalid.");
			expect(String(error)).not.toContain(privateName);
		}
	});

	it("evaluates eager async arguments from left to right", async () => {
		const messages: string[] = [];
		await expect(
			evaluateAsync(
				`concat(encrypt-string('first', '${KEY}', 'AES'), encrypt-string('second', '${KEY}', 'AES'))`,
				fixture().context,
				{
					encryptString: async (message) => {
						messages.push(message);
						return message;
					},
				},
			),
		).resolves.toBe("firstsecond");
		expect(messages).toEqual(["first", "second"]);
	});

	it("awaits predicates sequentially in candidate context", async () => {
		const calls: number[] = [];
		const result = await evaluateAsync(
			"/data/items[sleep(0, value = 'b')]/rank",
			fixture().context,
			{
				delay: async (milliseconds) => {
					calls.push(milliseconds);
				},
			},
		);
		expect(result).toBe(20);
		expect(calls).toEqual([0, 0]);
		await expect(
			evaluateAsync(
				"/data/items[sleep(0, value = current())]/rank",
				fixture().context,
				{ delay: async () => undefined },
			),
		).resolves.toBe(10);
	});

	it("assigns async predicate positions before relevance filtering", async () => {
		const { context } = fixture((path) => !path.includes("[0]"));
		await expect(
			evaluateAsync("/data/items[sleep(0, position() = 2)]/rank", context, {
				delay: async () => undefined,
			}),
		).resolves.toBe(20);
	});

	it("aborts a pending default delay without leaking its timer", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const result = evaluateAsync("sleep(100, 'late')", fixture().context, {
			signal: controller.signal,
		});
		await Promise.resolve();
		controller.abort(new Error("cancelled"));
		await expect(result).rejects.toThrow("cancelled");
		expect(vi.getTimerCount()).toBe(0);
	});
});
