import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	decodeFrozenCanonicalJsonText,
	type FrozenVerifiedJson,
} from "../20260728000000_canonical_identity_foundation/frozenJsonCarriers";
import {
	decodeFrozenPersistableBlueprint,
	decodeFrozenStoredApp,
	type FrozenPersistableBlueprintContext,
	FrozenPersistableBlueprintDecodeError,
	type FrozenStoredAppCapture,
	type FrozenStoredEntityCapture,
	materializeFrozenBlueprintJson,
} from "../20260728000000_canonical_identity_foundation/frozenPersistableBlueprintDecoder";
import type { FrozenLookupValidationContext } from "../20260728000000_canonical_identity_foundation/frozenPersistableBlueprintValidator.generated.mjs";

const MODULE_UUID = "56b316b8-c90b-473c-9ce1-6683597541ad";
const FORM_UUID = "ef1a9365-9c60-46b5-b4d2-64c3d76c12d7";
const FIELD_UUID = "b99518ff-e3c3-4e5b-a111-cb6fe5c51b3c";
const OTHER_UUID = "0d1948c8-9992-48cc-94cd-42705d40db2e";

function digest(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function context(seed = "canonical"): FrozenPersistableBlueprintContext {
	return { id: `fixture:${digest(seed)}` };
}

function lookupContext(): FrozenLookupValidationContext {
	return {
		kind: "available",
		projectId: "fixture-project",
		projectRevision: "0",
		definitions: [],
	};
}

function verified(value: unknown): FrozenVerifiedJson {
	const sourceText = JSON.stringify(value);
	return decodeFrozenCanonicalJsonText({
		id: "fixture",
		sourceText,
	});
}

function verifiedSqlNull(): FrozenVerifiedJson {
	return decodeFrozenCanonicalJsonText({
		id: "fixture-sql-null",
		sourceText: null,
	});
}

function verifiedSource(sourceText: string): FrozenVerifiedJson {
	return decodeFrozenCanonicalJsonText({
		id: "fixture-source",
		sourceText,
	});
}

function canonicalFixture(): Record<string, unknown> {
	return {
		appId: "fixture-app",
		appName: "Canonical",
		connectType: null,
		caseTypes: null,
		modules: {
			[MODULE_UUID]: {
				uuid: MODULE_UUID,
				id: "survey",
				name: "Survey",
			},
		},
		forms: {
			[FORM_UUID]: {
				uuid: FORM_UUID,
				id: "survey",
				name: "Survey",
				type: "survey",
			},
		},
		fields: {
			[FIELD_UUID]: {
				kind: "text",
				uuid: FIELD_UUID,
				id: "question_1",
				label: {
					parts: [{ kind: "text", text: "Question 1" }],
				},
			},
		},
		moduleOrder: [MODULE_UUID],
		formOrder: { [MODULE_UUID]: [FORM_UUID] },
		fieldOrder: { [FORM_UUID]: [FIELD_UUID] },
	};
}

function cloneFixture(): Record<string, unknown> {
	return structuredClone(canonicalFixture());
}

function learnFixtureSource(timeEstimate: string): string {
	const fixture = canonicalFixture();
	fixture.connectType = "learn";
	const form = required(
		(fixture.forms as Record<string, Record<string, unknown>>)[FORM_UUID],
	);
	form.connect = {
		learn_module: {
			id: "learn",
			name: "Learn",
			description: "",
			time_estimate: 7,
		},
	};
	return JSON.stringify(fixture).replace(
		'"time_estimate":7',
		`"time_estimate":${timeEstimate}`,
	);
}

function required<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("invalid test fixture");
	return value;
}

function expectRejected(
	value: unknown,
	stage?: FrozenPersistableBlueprintDecodeError["stage"],
): void {
	try {
		decodeFrozenPersistableBlueprint(
			verified(value),
			context(),
			lookupContext(),
		);
		throw new Error("expected frozen Blueprint rejection");
	} catch (error) {
		expect(error).toBeInstanceOf(FrozenPersistableBlueprintDecodeError);
		if (stage !== undefined) {
			expect((error as FrozenPersistableBlueprintDecodeError).stage).toBe(
				stage,
			);
		}
		expect(
			(error as FrozenPersistableBlueprintDecodeError).evidenceDigest,
		).toMatch(/^[0-9a-f]{64}$/);
		expect((error as FrozenPersistableBlueprintDecodeError).facet).toMatch(
			/^(?:app|case_types|modules|forms|fields|user_properties|user_types|personas|unknown)$/,
		);
		expect((error as Error).message).toContain(
			`(${(error as FrozenPersistableBlueprintDecodeError).facet}:${
				(error as FrozenPersistableBlueprintDecodeError).evidenceDigest
			})`,
		);
		expect((error as Error).message).not.toContain("Question 1");
		expect((error as Error).message).not.toContain("fixture-app");
		expect((error as Error).message).not.toContain(MODULE_UUID);
		expect((error as Error).message).not.toContain(FIELD_UUID);
		expect((error as Error).message).not.toContain(OTHER_UUID);
		expect((error as Error).message).not.toContain("survey");
	}
}

function storedCaptures(): {
	app: FrozenStoredAppCapture;
	entities: FrozenStoredEntityCapture[];
} {
	return {
		app: {
			id: "fixture-app",
			appName: "Canonical",
			connectType: null,
			caseTypes: verifiedSqlNull(),
			logo: null,
			mutationSeq: "4",
		},
		entities: [
			{
				appId: "fixture-app",
				uuid: MODULE_UUID,
				kind: "module",
				parentUuid: null,
				ordinal: 0,
				data: verified({
					uuid: MODULE_UUID,
					id: "survey",
					name: "Survey",
				}),
			},
			{
				appId: "fixture-app",
				uuid: FORM_UUID,
				kind: "form",
				parentUuid: MODULE_UUID,
				ordinal: 0,
				data: verified({
					uuid: FORM_UUID,
					id: "survey",
					name: "Survey",
					type: "survey",
				}),
			},
			{
				appId: "fixture-app",
				uuid: FIELD_UUID,
				kind: "field",
				parentUuid: FORM_UUID,
				ordinal: 0,
				data: verified({
					kind: "text",
					uuid: FIELD_UUID,
					id: "question_1",
					label: {
						parts: [{ kind: "text", text: "Question 1" }],
					},
				}),
			},
		],
	};
}

describe("decodeFrozenPersistableBlueprint", () => {
	it("accepts the canonical final fixture without rewriting its exact carrier", () => {
		const fixture = canonicalFixture();
		const exact = verified(fixture);
		const decoded = decodeFrozenPersistableBlueprint(
			exact,
			context(),
			lookupContext(),
		);

		expect(decoded.exact).toBe(exact);
		expect(decoded.runtime).toEqual(fixture);
		expect(decoded.canonicalText).toBe(exact.sourceText);
		expect(decoded.digest).toBe(exact.sourceDigest);
		expect(Object.isFrozen(decoded.runtime)).toBe(true);
		expect(Object.isFrozen(decoded.runtime.fields[FIELD_UUID]?.label)).toBe(
			true,
		);
	});

	it.each([
		[
			"unknown root key",
			() => Object.assign(cloneFixture(), { blueprint: "retired" }),
			"schema",
		],
		[
			"missing required root key",
			() => {
				const value = cloneFixture();
				delete value.fields;
				return value;
			},
			"schema",
		],
		[
			"illegal field discriminator",
			() => {
				const value = cloneFixture();
				required(
					(value.fields as Record<string, Record<string, unknown>>)[FIELD_UUID],
				).kind = "retired";
				return value;
			},
			"schema",
		],
		[
			"uppercase authored UUID",
			() => {
				const value = cloneFixture();
				value.moduleOrder = [MODULE_UUID.toUpperCase()];
				return value;
			},
			"schema",
		],
		[
			"record/order disagreement",
			() => {
				const value = cloneFixture();
				value.moduleOrder = [];
				return value;
			},
			"schema",
		],
		[
			"dangling typed field reference",
			() => {
				const value = cloneFixture();
				const field = required(
					(value.fields as Record<string, Record<string, unknown>>)[FIELD_UUID],
				);
				field.label = {
					parts: [{ kind: "field-ref", uuid: OTHER_UUID }],
				};
				return value;
			},
			"gate",
		],
	] as const)(
		"rejects %s through the frozen complete authority",
		(_name, make, stage) => {
			expectRejected(make(), stage);
		},
	);

	it("permits prototype normalization only when every exact JSON key/value is unchanged", () => {
		const value = cloneFixture();
		value.modules = Object.assign(Object.create(null), value.modules);
		const decoded = decodeFrozenPersistableBlueprint(
			verified(value),
			context(),
			lookupContext(),
		);
		expect(decoded.runtime).toEqual(canonicalFixture());
	});

	it("rejects a non-content-free caller context before reading the Blueprint", () => {
		expect(() =>
			decodeFrozenPersistableBlueprint(
				verified(canonicalFixture()),
				{
					id: "app:fixture-app",
				},
				lookupContext(),
			),
		).toThrow(FrozenPersistableBlueprintDecodeError);
	});

	it("applies exact numeric admission before the frozen final-schema validator", () => {
		const accepted = decodeFrozenPersistableBlueprint(
			verifiedSource(learnFixtureSource("7")),
			context("learn"),
			lookupContext(),
		);
		expect(
			(
				required(accepted.runtime.forms[FORM_UUID]).connect as {
					learn_module: { time_estimate: number };
				}
			).learn_module.time_estimate,
		).toBe(7);

		for (const raw of ["7.0", "7e0", "9007199254740992"]) {
			expect(() =>
				decodeFrozenPersistableBlueprint(
					verifiedSource(learnFixtureSource(raw)),
					context(raw),
					lookupContext(),
				),
			).toThrow(
				expect.objectContaining({
					stage: "canonicality",
				}),
			);
		}
	});
});

describe("materializeFrozenBlueprintJson", () => {
	const minimumSubnormal = `0.${"0".repeat(323)}5`;
	const underflow = `0.${"0".repeat(323)}1`;

	it.each([
		["0", 0],
		["0.1", 0.1],
		["1.5", 1.5],
		["9007199254740991", Number.MAX_SAFE_INTEGER],
		["-9007199254740991", Number.MIN_SAFE_INTEGER],
		[minimumSubnormal, Number.MIN_VALUE],
	] as const)("admits the canonical storage decimal %s", (raw, expected) => {
		const result = materializeFrozenBlueprintJson<{ nested: [number] }>(
			verifiedSource(`{"nested":[${raw}]}`),
			context(raw),
		);
		expect(result).toEqual({
			kind: "json",
			value: { nested: [expected] },
		});
	});

	it.each([
		"-0",
		"0.0",
		"1.50",
		"0.10000000000000001",
		"9007199254740992",
		"-9007199254740992",
		"9007199254740993",
		"1e3",
		"10e2",
		"1e-7",
		"123.0",
		`1${"0".repeat(309)}`,
		underflow,
	])("rejects the noncanonical or lossy storage decimal %s", (raw) => {
		expect(() =>
			materializeFrozenBlueprintJson(
				verifiedSource(`{"nested":[${raw}]}`),
				context(raw),
			),
		).toThrow(
			expect.objectContaining({
				stage: "canonicality",
			}),
		);
	});

	it("keeps SQL NULL distinct from JSON null", () => {
		expect(
			materializeFrozenBlueprintJson(verifiedSqlNull(), context("sql-null")),
		).toEqual({ kind: "sql-null" });
		expect(
			materializeFrozenBlueprintJson(
				verifiedSource("null"),
				context("json-null"),
			),
		).toEqual({ kind: "json", value: null });
	});
});

describe("decodeFrozenStoredApp", () => {
	it("assembles exact rows, validates the complete document, and emits content evidence", () => {
		const captures = storedCaptures();
		const decoded = decodeFrozenStoredApp(
			captures.app,
			captures.entities,
			lookupContext(),
		);

		expect(decoded.runtime).toEqual(canonicalFixture());
		expect(decoded.exact.app).toBe(captures.app);
		expect(decoded.exact.entities).toEqual(captures.entities);
		expect(decoded.digest).toBe(digest(decoded.canonicalText));
		expect(decoded.canonicalText).toContain(`"${FIELD_UUID}"`);
	});

	it.each([
		[
			"duplicate ordinal",
			(captures: ReturnType<typeof storedCaptures>) => {
				const first = required(captures.entities[0]);
				captures.entities.push({
					...first,
					uuid: OTHER_UUID,
					data: verified({
						uuid: OTHER_UUID,
						id: "other",
						name: "Other",
					}),
				});
			},
		],
		[
			"wrong-kind parent",
			(captures: ReturnType<typeof storedCaptures>) => {
				captures.entities[2] = {
					...required(captures.entities[2]),
					parentUuid: MODULE_UUID,
				};
			},
		],
		[
			"non-contiguous ordinal",
			(captures: ReturnType<typeof storedCaptures>) => {
				captures.entities[2] = {
					...required(captures.entities[2]),
					ordinal: 1,
				};
			},
		],
		[
			"row/embedded UUID mismatch",
			(captures: ReturnType<typeof storedCaptures>) => {
				captures.entities[2] = {
					...required(captures.entities[2]),
					data: verified({
						kind: "text",
						uuid: OTHER_UUID,
						id: "question_1",
						label: { parts: [{ kind: "text", text: "Question 1" }] },
					}),
				};
			},
		],
		[
			"unsafe assembled ordinal",
			(captures: ReturnType<typeof storedCaptures>) => {
				captures.entities[2] = {
					...required(captures.entities[2]),
					ordinal: Number.MAX_SAFE_INTEGER + 1,
				};
			},
		],
	] as const)("rejects %s before exposing a document", (_name, mutate) => {
		const captures = storedCaptures();
		mutate(captures);
		expect(() =>
			decodeFrozenStoredApp(captures.app, captures.entities, lookupContext()),
		).toThrow(FrozenPersistableBlueprintDecodeError);
	});
});
