import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	admitMutationBatch,
	admitMutationStages,
	encodeAdmittedMutationEnvelope,
	MutationWireCanonicalityError,
} from "@/lib/doc/mutationAdmission";
import type { Mutation } from "@/lib/doc/types";

function canonicalityError(run: () => unknown): MutationWireCanonicalityError {
	try {
		run();
	} catch (error) {
		expect(error).toBeInstanceOf(MutationWireCanonicalityError);
		return error as MutationWireCanonicalityError;
	}
	throw new Error("Expected mutation admission to reject");
}

describe("admitMutationBatch", () => {
	it("returns a detached deeply frozen canonical batch", () => {
		const mutation: Mutation = {
			kind: "setAppName",
			name: "Before",
		};
		const input: Mutation[] = [mutation];
		const admitted = admitMutationBatch(input);

		mutation.name = "After";
		input.push({ kind: "setConnectType", connectType: null });

		expect(admitted).toEqual([{ kind: "setAppName", name: "Before" }]);
		expect(Object.isFrozen(admitted)).toBe(true);
		expect(Object.isFrozen(admitted[0])).toBe(true);
		expect(() => {
			(admitted[0] as { name: string }).name = "Changed";
		}).toThrow();
	});

	it("accepts reordered/null-prototype/frozen values and de-aliases sharing", () => {
		const shared = Object.freeze(
			Object.assign(Object.create(null), {
				kind: "setAppName",
				name: "Nova",
			}),
		) as Mutation;
		const admitted = admitMutationBatch([shared, shared]);

		expect(admitted).toEqual([
			{ kind: "setAppName", name: "Nova" },
			{ kind: "setAppName", name: "Nova" },
		]);
		expect(admitted[0]).not.toBe(admitted[1]);
	});

	it("rejects null for repeat_mode because the stored discriminator is required", () => {
		const error = canonicalityError(() =>
			admitMutationBatch([
				{
					kind: "updateField",
					uuid: testUuid("repeat-field"),
					targetKind: "repeat",
					patch: { repeat_mode: null },
				},
			]),
		);
		expect(error.details).toEqual({
			mutationIndex: 0,
			pointer: "/0/patch",
			reason: "schema-parse",
		});
	});

	it.each([
		{
			label: "undefined",
			value: [{ kind: "setAppName", name: undefined }],
			pointer: "/0/name",
			reason: "non-json-value",
		},
		{
			label: "negative zero",
			value: [{ kind: "setAppName", name: "Nova", extra: -0 }],
			pointer: "/0/extra",
			reason: "non-json-value",
		},
		{
			label: "bigint",
			value: [{ kind: "setAppName", name: "Nova", extra: BigInt(1) }],
			pointer: "/0/extra",
			reason: "non-json-value",
		},
		{
			label: "function",
			value: [{ kind: "setAppName", name: "Nova", extra: () => 1 }],
			pointer: "/0/extra",
			reason: "non-json-value",
		},
	])("rejects $label before schema parsing", ({ value, pointer, reason }) => {
		const error = canonicalityError(() => admitMutationBatch(value));
		expect(error.details).toEqual({
			mutationIndex: 0,
			pointer,
			reason,
		});
	});

	it.each([
		["positive unsafe integer", 9_007_199_254_740_992],
		["negative unsafe integer", -9_007_199_254_740_992],
		["larger unsafe integer", 1e20],
	] as const)(
		"rejects a %s at the generic JSON boundary before schema parsing",
		(_label, value) => {
			const error = canonicalityError(() =>
				admitMutationBatch([
					{ kind: "setAppName", name: "Nova", extra: value },
				]),
			);
			expect(error.details).toEqual({
				mutationIndex: 0,
				pointer: "/0/extra",
				reason: "non-json-value",
			});
		},
	);

	it.each([
		["ordinary fraction", 0.1],
		["smallest positive number", 5e-324],
	] as const)("admits a persistable %s", (_label, value) => {
		const literal = {
			kind: "term" as const,
			term: { kind: "literal" as const, value },
		};
		expect(
			admitMutationBatch([
				{
					kind: "setCaseListMeta",
					uuid: testUuid("numeric-module"),
					patch: {
						filter: {
							kind: "eq",
							left: literal,
							right: literal,
						},
					},
				},
			]),
		).toHaveLength(1);
	});

	it.each([
		["NaN", Number.NaN],
		["positive infinity", Number.POSITIVE_INFINITY],
		["negative infinity", Number.NEGATIVE_INFINITY],
		["symbol", Symbol("not-json")],
		["Date", new Date(0)],
		["boxed string", new String("not-json")],
		["Map", new Map([["key", "value"]])],
		["Set", new Set(["value"])],
		["RegExp", /not-json/u],
		["typed array", new Uint8Array([1])],
	] as const)("rejects a nested %s as non-JSON", (_label, extra) => {
		const error = canonicalityError(() =>
			admitMutationBatch([{ kind: "setAppName", name: "Nova", extra }]),
		);
		expect(error.details).toEqual({
			mutationIndex: 0,
			pointer: "/0/extra",
			reason: "non-json-value",
		});
	});

	it.each([null, true, "batch", 4, {}, () => undefined, Symbol("batch")])(
		"rejects a non-array batch root %#",
		(value) => {
			const error = canonicalityError(() => admitMutationBatch(value));
			expect(error.details).toMatchObject({
				mutationIndex: null,
				pointer: "",
			});
		},
	);

	it("rejects sparse and custom-property root arrays as batch failures", () => {
		const sparse = new Array(1);
		const sparseError = canonicalityError(() => admitMutationBatch(sparse));
		expect(sparseError.details).toEqual({
			mutationIndex: null,
			pointer: "",
			reason: "sparse-array",
		});

		const custom = [{ kind: "setAppName", name: "Nova" }];
		Object.defineProperty(custom, "custom", {
			enumerable: true,
			value: true,
		});
		const customError = canonicalityError(() => admitMutationBatch(custom));
		expect(customError.details).toEqual({
			mutationIndex: null,
			pointer: "",
			reason: "non-json-value",
		});
	});

	it("rejects accessors without invoking them", () => {
		let reads = 0;
		const mutation = { kind: "setAppName" } as Record<string, unknown>;
		Object.defineProperty(mutation, "name", {
			enumerable: true,
			get() {
				reads += 1;
				return "Nova";
			},
		});

		const error = canonicalityError(() => admitMutationBatch([mutation]));
		expect(reads).toBe(0);
		expect(error.details).toMatchObject({
			mutationIndex: 0,
			pointer: "/0/name",
			reason: "non-json-value",
		});
	});

	it("rejects non-enumerable and symbol properties", () => {
		const hidden = { kind: "setAppName", name: "Nova" };
		Object.defineProperty(hidden, "hidden", {
			enumerable: false,
			value: true,
		});
		expect(
			canonicalityError(() => admitMutationBatch([hidden])).details,
		).toEqual({
			mutationIndex: 0,
			pointer: "/0/hidden",
			reason: "non-json-value",
		});

		const symbolKey = Symbol("hidden");
		const symbolBearing = { kind: "setAppName", name: "Nova" } as Record<
			PropertyKey,
			unknown
		>;
		symbolBearing[symbolKey] = true;
		expect(
			canonicalityError(() => admitMutationBatch([symbolBearing])).details,
		).toEqual({
			mutationIndex: 0,
			pointer: "/0",
			reason: "non-json-value",
		});
	});

	it("escapes RFC 6901 pointer segments without exposing the bad value", () => {
		const error = canonicalityError(() =>
			admitMutationBatch([
				{
					kind: "setAppName",
					name: "Nova",
					"a~/b": undefined,
				},
			]),
		);
		expect(error.details).toEqual({
			mutationIndex: 0,
			pointer: "/0/a~0~1b",
			reason: "non-json-value",
		});
		expect(error.message).not.toContain("a~/b");
	});

	it("rejects cycles and custom prototypes", () => {
		const cyclic: Record<string, unknown> = {
			kind: "setAppName",
			name: "Nova",
		};
		cyclic.self = cyclic;
		expect(
			canonicalityError(() => admitMutationBatch([cyclic])).details.reason,
		).toBe("non-json-value");

		const custom = Object.create({ inherited: true }) as Record<
			string,
			unknown
		>;
		custom.kind = "setAppName";
		custom.name = "Nova";
		expect(
			canonicalityError(() => admitMutationBatch([custom])).details,
		).toMatchObject({
			mutationIndex: 0,
			pointer: "/0",
			reason: "non-json-value",
		});
	});

	it.each(["getPrototypeOf", "ownKeys", "getOwnPropertyDescriptor"] as const)(
		"rejects a proxy whose %s trap throws",
		(trap) => {
			const handler: ProxyHandler<Record<string, unknown>> = {};
			if (trap === "getPrototypeOf") {
				handler.getPrototypeOf = () => {
					throw new Error("trap");
				};
			} else if (trap === "ownKeys") {
				handler.ownKeys = () => {
					throw new Error("trap");
				};
			} else {
				handler.getOwnPropertyDescriptor = () => {
					throw new Error("trap");
				};
			}
			const proxy = new Proxy({ kind: "setAppName", name: "Nova" }, handler);
			const error = canonicalityError(() => admitMutationBatch([proxy]));
			expect(error.details).toMatchObject({
				mutationIndex: 0,
				reason: "non-json-value",
			});
		},
	);

	it("rejects revoked object and outer-array proxies", () => {
		const nested = Proxy.revocable({ kind: "setAppName", name: "Nova" }, {});
		nested.revoke();
		expect(
			canonicalityError(() => admitMutationBatch([nested.proxy])).details,
		).toMatchObject({
			mutationIndex: 0,
			pointer: "/0",
			reason: "non-json-value",
		});

		const outer = Proxy.revocable([{ kind: "setAppName", name: "Nova" }], {});
		outer.revoke();
		expect(
			canonicalityError(() => admitMutationBatch(outer.proxy)).details,
		).toEqual({
			mutationIndex: null,
			pointer: "",
			reason: "non-json-value",
		});
	});

	it("reports schema strip/parse without exposing an unknown key", () => {
		const stripped = canonicalityError(() =>
			admitMutationBatch([
				{ kind: "setAppName", name: "Nova", secret_unknown: "value" },
			]),
		);
		expect(stripped.details).toEqual({
			mutationIndex: 0,
			pointer: "/0",
			reason: "schema-strip",
		});

		const missingPatch = canonicalityError(() =>
			admitMutationBatch([
				{
					kind: "updateModule",
					uuid: "123e4567-e89b-42d3-a456-426614174000",
				},
			]),
		);
		expect(missingPatch.details).toEqual({
			mutationIndex: 0,
			pointer: "/0/patch",
			reason: "schema-parse",
		});

		const parsed = canonicalityError(() =>
			admitMutationBatch([{ kind: "setAppName", name: 4 }]),
		);
		expect(parsed.details).toMatchObject({
			mutationIndex: 0,
			pointer: "/0/name",
			reason: "schema-parse",
		});
	});

	it("requires hierarchy changes to use moveModule", () => {
		const error = canonicalityError(() =>
			admitMutationBatch([
				{
					kind: "updateModule",
					uuid: testUuid("module-parent-patch-target"),
					patch: {
						parentModuleUuid: testUuid("module-parent-patch-value"),
					},
				},
			]),
		);
		expect(error.details).toEqual({
			mutationIndex: 0,
			pointer: "/0/patch",
			reason: "schema-strip",
		});
	});

	it("selects the first schema issue by numeric mutation index", () => {
		const value = Array.from({ length: 11 }, (_unused, index) => ({
			kind: "setAppName",
			name: index === 2 || index === 10 ? 4 : `Nova ${index}`,
		}));
		const error = canonicalityError(() => admitMutationBatch(value));
		expect(error.details).toEqual({
			mutationIndex: 2,
			pointer: "/2/name",
			reason: "schema-parse",
		});
	});

	it("is hook-inert for batch and wrapper serialization", () => {
		const objectDescriptor = Object.getOwnPropertyDescriptor(
			Object.prototype,
			"toJSON",
		);
		const arrayDescriptor = Object.getOwnPropertyDescriptor(
			Array.prototype,
			"toJSON",
		);
		let calls = 0;
		Object.defineProperty(Object.prototype, "toJSON", {
			configurable: true,
			value() {
				calls += 1;
				return "poisoned-object";
			},
		});
		Object.defineProperty(Array.prototype, "toJSON", {
			configurable: true,
			value() {
				calls += 1;
				return "poisoned-array";
			},
		});
		try {
			const admitted = admitMutationBatch([
				{ kind: "setAppName", name: "Nova" },
			]);
			const encoded = encodeAdmittedMutationEnvelope({
				type: "data-mutations",
				mutations: admitted,
			});
			expect(encoded.json).toBe(
				'{"mutations":[{"kind":"setAppName","name":"Nova"}],"type":"data-mutations"}',
			);
			expect(calls).toBe(0);
		} finally {
			if (objectDescriptor === undefined) {
				delete (Object.prototype as { toJSON?: unknown }).toJSON;
			} else {
				Object.defineProperty(Object.prototype, "toJSON", objectDescriptor);
			}
			if (arrayDescriptor === undefined) {
				delete (Array.prototype as { toJSON?: unknown }).toJSON;
			} else {
				Object.defineProperty(Array.prototype, "toJSON", arrayDescriptor);
			}
		}
	});
});

describe("admitMutationStages", () => {
	it("returns one admitted batch with immutable nonempty slices", () => {
		const admitted = admitMutationStages([
			{
				stage: "empty",
				mutations: [],
			},
			{
				stage: "rename",
				mutations: [{ kind: "setAppName", name: "Nova" }],
			},
			{
				stage: "connect",
				mutations: [{ kind: "setConnectType", connectType: null }],
			},
		]);

		expect(admitted.batch).toEqual([
			{ kind: "setAppName", name: "Nova" },
			{ kind: "setConnectType", connectType: null },
		]);
		expect(admitted.slices).toEqual([
			{ stage: "rename", start: 0, end: 1 },
			{ stage: "connect", start: 1, end: 2 },
		]);
		expect(Object.isFrozen(admitted.slices)).toBe(true);
	});

	it("rejects an invalid empty stage before it can be filtered out", () => {
		const mutations: unknown[] = [];
		Object.defineProperty(mutations, "custom", {
			enumerable: true,
			value: true,
		});
		const error = canonicalityError(() =>
			admitMutationStages([{ stage: "empty", mutations }]),
		);
		expect(error.details).toMatchObject({
			reason: "non-json-value",
		});
	});

	it("reports a later stage failure in flattened global mutation coordinates", () => {
		const error = canonicalityError(() =>
			admitMutationStages([
				{
					stage: "first",
					mutations: [
						{ kind: "setAppName", name: "One" },
						{ kind: "setAppName", name: "Two" },
					],
				},
				{
					stage: "second",
					mutations: [
						{ kind: "setAppName", name: "Three" },
						{ kind: "setAppName", name: 4 },
					],
				},
			]),
		);
		expect(error.details).toEqual({
			mutationIndex: 3,
			pointer: "/3/name",
			reason: "schema-parse",
		});
	});

	it("rejects a mutation array reused by two stages", () => {
		const shared = [{ kind: "setAppName", name: "Nova" }];
		const error = canonicalityError(() =>
			admitMutationStages([
				{ stage: "first", mutations: shared },
				{ stage: "second", mutations: shared },
			]),
		);
		expect(error.details).toEqual({
			mutationIndex: null,
			pointer: "/1/mutations",
			reason: "non-json-value",
		});
	});

	it("rejects throwing outer and stage proxies before reading stage fields", () => {
		const outer = Proxy.revocable([{ stage: "first", mutations: [] }], {});
		outer.revoke();
		expect(
			canonicalityError(() => admitMutationStages(outer.proxy)).details,
		).toEqual({
			mutationIndex: null,
			pointer: "",
			reason: "non-json-value",
		});

		let reads = 0;
		const entry = { stage: "first" } as Record<string, unknown>;
		Object.defineProperty(entry, "mutations", {
			enumerable: true,
			get() {
				reads += 1;
				return [];
			},
		});
		const error = canonicalityError(() => admitMutationStages([entry]));
		expect(reads).toBe(0);
		expect(error.details).toEqual({
			mutationIndex: null,
			pointer: "/0/mutations",
			reason: "non-json-value",
		});
	});
});
