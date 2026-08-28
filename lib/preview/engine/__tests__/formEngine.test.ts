/**
 * FormEngine tests — domain-shaped fixtures only.
 *
 * The engine consumes a `FormEngineInput` (form + fields map + fieldOrder) —
 * the same domain shape produced by the normalized doc store. These tests
 * build fixtures directly in that shape via the `dTree` helper.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { xp } from "@/lib/__tests__/docHelpers";
import { parseXPathExpression } from "@/lib/commcare/xpath";
import type {
	CaseType,
	CaseWrite,
	Field,
	FieldKind,
	Form,
	FormType,
	ProseTemplate,
	SelectOptionsSource,
	Uuid,
	XPathExpression,
} from "@/lib/domain";
import { USERCASE_CASE_TYPE } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { createInProcessXPathWorkerFactory } from "../../xpath/inProcessWorkerClient";
import { XPathRuntime } from "../../xpath/workerClient";
import { deserializeXPathWorkerValue } from "../../xpath/workerProjection";
import { evaluateXPathWorkerRequest } from "../../xpath/workerRuntime";

import {
	type CaseDataByType,
	FormEngine,
	type FormEngineAsyncEvaluator,
	type FormEngineInput,
} from "../formEngine";
import { previewAsMe } from "../identity";

const ENTRY_KEY = "11111111-1111-4111-8111-111111111111";

/** Case data holding a single case type's property map — the common
 *  single-namespace shape of the engine's per-type case data. */
function caseDataFor(
	caseType: string,
	entries: ReadonlyArray<[string, string]>,
): CaseDataByType {
	return new Map([[caseType, new Map(entries)]]);
}

/** Convenience type for building field subtrees in test fixtures. The engine
 *  itself works on flat maps — this nested shape is purely for readability at
 *  the call site and is flattened by `dTree()` before construction. */
interface DField {
	id: string;
	kind: FieldKind;
	label?: ProseTemplate;
	hint?: ProseTemplate;
	required?: XPathExpression;
	relevant?: XPathExpression;
	calculate?: XPathExpression;
	default_value?: XPathExpression;
	validate?: XPathExpression;
	validate_msg?: ProseTemplate;
	caseWrite?: CaseWrite;
	optionsSource?: SelectOptionsSource;
	repeat_mode?: "user_controlled" | "count_bound" | "query_bound";
	repeat_count?: XPathExpression;
	data_source?: { ids_query: XPathExpression };
	children?: DField[];
}

function prose(...parts: ProseTemplate["parts"]): ProseTemplate {
	return { parts };
}

/** Parse `#form/...` fixture text to the deterministic UUIDs `dTree` mints. */
function formXp(text: string): XPathExpression {
	return parseXPathExpression(
		text,
		(segments) => testUuid(`form.${segments.join(".")}`),
		() => undefined,
	);
}

function inlineOptions(
	scope: string,
	options: ReadonlyArray<readonly [value: string, label: string]>,
): SelectOptionsSource {
	return {
		kind: "inline",
		options: options.map(([value, label]) => ({
			uuid: testUuid(`${scope}.${value}`),
			value,
			label: proseText(label),
		})),
	};
}

/**
 * Build a `FormEngineInput` from a nested test-fixture tree.
 *
 * Walks the nested `DField` tree and emits (1) a Form entity, (2) a flat
 * `fields` map keyed by uuid, and (3) a `fieldOrder` adjacency map. UUIDs
 * are deterministic — derived from the field's position path — so assertion
 * failures are reproducible and nothing in a test depends on
 * `crypto.randomUUID`.
 */
function dTree(
	fields: DField[],
	formType: FormType = "registration",
	caseTypes: CaseType[] = [],
): FormEngineInput {
	const formUuid = testUuid("test-form-uuid");
	const form: Form = {
		uuid: formUuid,
		id: "test-form",
		name: "Test Form",
		type: formType,
	};
	const fieldMap: Record<string, Field> = {};
	const fieldOrder: Record<string, Uuid[]> = {};

	// Walk depth-first; the uuid is a stable deterministic path like
	// "form.groupId.childId" so each fixture position always maps to the
	// same uuid, keeping test IDs reproducible.
	function walk(nodes: DField[], parentUuid: Uuid, pathPrefix: string) {
		const order: Uuid[] = [];
		for (const n of nodes) {
			const uuid = testUuid(`${pathPrefix}.${n.id}`);
			order.push(uuid);
			const { children, ...rest } = n;
			fieldMap[uuid as string] = {
				uuid,
				...rest,
			} as Field;
			// Containers get an entry in fieldOrder even when empty — the engine's
			// tree builder treats the presence of an entry as the signal to recurse.
			if (n.kind === "group" || n.kind === "repeat" || n.kind === "section") {
				walk(children ?? [], uuid, `${pathPrefix}.${n.id}`);
			}
		}
		fieldOrder[parentUuid as string] = order;
	}

	walk(fields, formUuid, "form");
	return { form, formUuid, fields: fieldMap, fieldOrder, caseTypes };
}

/** Build the real in-process worker seam for one staged engine initialization.
 * The returned runtime remains caller-owned so rejection tests can dispose it
 * in `finally` and stay clean under async-leak detection. */
function fixedWorldEvaluator(engine: FormEngine, worldKey: string) {
	const runtime = new XPathRuntime({
		workerFactory: createInProcessXPathWorkerFactory(),
	});
	const world = engine.createWorkerWorld(worldKey);
	const evaluateAsync = (async (
		source: string,
		path: string,
		resultMode: "scalar" | "nodeset-values-or-scalar" = "scalar",
		stateOverrides?: Parameters<FormEngineAsyncEvaluator>[3],
	) => {
		const result = await runtime.request({
			entryKey: ENTRY_KEY,
			revision: 0,
			profile: "form",
			source,
			resultMode,
			instances: engine.workerInstances(source, path, world, stateOverrides),
		});
		if (!result.ok) throw new Error(result.error.code);
		if (result.nodesetValues !== undefined) {
			return {
				kind: "nodeset-values" as const,
				values: result.nodesetValues,
			};
		}
		return deserializeXPathWorkerValue(result.value);
	}) as FormEngineAsyncEvaluator;
	return { evaluateAsync, runtime };
}

describe("FormEngine", () => {
	it("runs an input's async downstream cascade once and in DAG order", async () => {
		const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
		const normalized = "sleep(0, replace(/data/source, '[^a-z]', ''))";
		const roundTrip = `decrypt-string(encrypt-string(/data/normalized, '${key}', 'AES'), '${key}', 'AES')`;
		const engine = new FormEngine(
			dTree([
				{ id: "source", kind: "text" },
				{ id: "normalized", kind: "hidden", calculate: xp(normalized) },
				{ id: "round_trip", kind: "hidden", calculate: xp(roundTrip) },
			]),
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			{ stagedAsync: true },
		);
		const calls: string[] = [];
		const runtime = new XPathRuntime({
			workerFactory: createInProcessXPathWorkerFactory(
				async (request, tools) => {
					calls.push(request.source);
					return evaluateXPathWorkerRequest(request, tools);
				},
			),
		});
		let revision = 0;
		const evaluateAsync = (async (
			source: string,
			path: string,
			resultMode: "scalar" | "nodeset-values-or-scalar" = "scalar",
		) => {
			const result = await runtime.request({
				entryKey: ENTRY_KEY,
				revision,
				profile: "form",
				source,
				resultMode,
				instances: engine.workerInstances(source, path),
			});
			if (!result.ok) throw new Error(result.error.code);
			if (result.nodesetValues !== undefined) {
				return {
					kind: "nodeset-values" as const,
					values: result.nodesetValues,
				};
			}
			return deserializeXPathWorkerValue(result.value);
		}) as FormEngineAsyncEvaluator;

		await engine.initializeAsync(evaluateAsync);
		calls.length = 0;
		revision += 1;
		await engine.setValueAsync("/data/source", "a1b2c", evaluateAsync);

		expect(engine.getState("/data/normalized").value).toBe("abc");
		expect(engine.getState("/data/round_trip").value).toBe("abc");
		expect(calls).toEqual([normalized, roundTrip]);
		runtime.dispose();
	});

	it("initializes with field states", () => {
		const input = dTree([
			{ id: "name", kind: "text", label: proseText("Name") },
			{ id: "age", kind: "int", label: proseText("Age") },
		]);
		const engine = new FormEngine(input);

		expect(engine.getState("/data/name").visible).toBe(true);
		expect(engine.getState("/data/name").value).toBe("");
		expect(engine.getState("/data/age").visible).toBe(true);
	});

	it("sets and gets values", () => {
		const input = dTree([
			{ id: "name", kind: "text", label: proseText("Name") },
		]);
		const engine = new FormEngine(input);

		engine.setValue("/data/name", "Alice");
		expect(engine.getState("/data/name").value).toBe("Alice");
	});

	describe("relevant (visibility)", () => {
		it("cascades container relevance into descendant nodeset readers", () => {
			const engine = new FormEngine(
				dTree([
					{ id: "gate", kind: "text" },
					{
						id: "section",
						kind: "group",
						relevant: xp("/data/gate = 'yes'"),
						children: [{ id: "note", kind: "text" }],
					},
					{
						id: "visible_notes",
						kind: "hidden",
						calculate: xp("count(/data/section/note)"),
					},
				]),
			);

			expect(engine.getState("/data/section/note").visible).toBe(true);
			expect(engine.getState("/data/visible_notes").value).toBe("0");
			engine.setValue("/data/gate", "yes");
			expect(engine.getState("/data/visible_notes").value).toBe("1");
			engine.setValue("/data/gate", "no");
			expect(engine.getState("/data/visible_notes").value).toBe("0");
		});

		it("updates cached worker relevance inside one async cascade", async () => {
			const engine = new FormEngine(
				dTree([
					{ id: "gate", kind: "text" },
					{
						id: "section",
						kind: "group",
						relevant: xp("/data/gate = 'yes'"),
						children: [{ id: "note", kind: "text" }],
					},
					{
						id: "visible_notes",
						kind: "hidden",
						calculate: xp("count(/data/section/note)"),
					},
				]),
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				{ stagedAsync: true },
			);
			const runtime = new XPathRuntime({
				workerFactory: createInProcessXPathWorkerFactory(),
			});
			let revision = 0;
			let world = engine.createWorkerWorld(`relevance-${revision}`);
			const evaluateAsync = (async (
				source: string,
				path: string,
				resultMode: "scalar" | "nodeset-values-or-scalar" = "scalar",
				stateOverrides?: Parameters<FormEngineAsyncEvaluator>[3],
			) => {
				const result = await runtime.request({
					entryKey: ENTRY_KEY,
					revision,
					profile: "form",
					source,
					resultMode,
					instances: engine.workerInstances(
						source,
						path,
						world,
						stateOverrides,
					),
				});
				if (!result.ok) throw new Error(result.error.code);
				if (result.nodesetValues !== undefined) {
					return {
						kind: "nodeset-values" as const,
						values: result.nodesetValues,
					};
				}
				return deserializeXPathWorkerValue(result.value);
			}) as FormEngineAsyncEvaluator;

			await engine.initializeAsync(evaluateAsync);
			expect(engine.getState("/data/visible_notes").value).toBe("0");
			revision += 1;
			world = engine.createWorkerWorld(`relevance-${revision}`);
			await engine.setValueAsync("/data/gate", "yes", evaluateAsync);
			expect(engine.getState("/data/visible_notes").value).toBe("1");
			revision += 1;
			world = engine.createWorkerWorld(`relevance-${revision}`);
			await engine.setValueAsync("/data/gate", "no", evaluateAsync);
			expect(engine.getState("/data/visible_notes").value).toBe("0");
			runtime.dispose();
		});

		it("hides fields when relevant evaluates to false", () => {
			const input = dTree([
				{
					id: "has_children",
					kind: "single_select",
					label: proseText("Has children?"),
					optionsSource: inlineOptions("has-children", [
						["yes", "Yes"],
						["no", "No"],
					]),
				},
				{
					id: "num_children",
					kind: "int",
					label: proseText("How many?"),
					relevant: xp('/data/has_children = "yes"'),
				},
			]);
			const engine = new FormEngine(input);

			// Initially visible (relevant evaluates with empty value → false for comparison)
			expect(engine.getState("/data/num_children").visible).toBe(false);

			engine.setValue("/data/has_children", "yes");
			expect(engine.getState("/data/num_children").visible).toBe(true);

			engine.setValue("/data/has_children", "no");
			expect(engine.getState("/data/num_children").visible).toBe(false);
		});
	});

	describe("calculate", () => {
		it("computes calculated values", () => {
			const input = dTree([
				{ id: "weight", kind: "decimal", label: proseText("Weight (kg)") },
				{ id: "height", kind: "decimal", label: proseText("Height (m)") },
				{
					id: "bmi",
					kind: "hidden",
					calculate: xp("/data/weight div (/data/height * /data/height)"),
				},
			]);
			const engine = new FormEngine(input);

			engine.setValue("/data/weight", "70");
			engine.setValue("/data/height", "1.75");

			const bmi = parseFloat(engine.getState("/data/bmi").value);
			expect(bmi).toBeCloseTo(22.86, 1);
		});

		it("rejects raw authored #case references instead of treating them as an alias", () => {
			const input = dTree(
				[{ id: "copied", kind: "hidden", calculate: xp("#case/age") }],
				"followup",
				[
					{
						name: "patient",
						properties: [
							{ name: "age", label: proseText("Age"), data_type: "int" },
						],
					},
				],
			);

			expect(
				() =>
					new FormEngine(
						input,
						"patient",
						caseDataFor("patient", [["age", "30"]]),
					),
			).toThrow(
				'Authored "#case/..." is not a Nova reference; Preview requires an explicit case-type namespace',
			);
		});
	});

	describe("validation", () => {
		it("validates on value change", () => {
			const input = dTree([
				{
					id: "age",
					kind: "int",
					label: proseText("Age"),
					validate: xp(". > 0 and . < 150"),
					validate_msg: proseText("Must be 1-149"),
				},
			]);
			const engine = new FormEngine(input);

			engine.setValue("/data/age", "25");
			expect(engine.getState("/data/age").valid).toBe(true);

			engine.setValue("/data/age", "-1");
			expect(engine.getState("/data/age").valid).toBe(false);
			expect(engine.getState("/data/age").errorMessage).toBe("Must be 1-149");
		});
	});

	describe("temporal shape gate", () => {
		// A clock is typed, so a temporal answer can be half-finished in a way
		// no other kind can: "abc" is a legal string, "2:3" is not a time. The
		// gate is what keeps that from reaching the case store and coming back
		// as a schema rejection naming a property instead of a question.

		it("rejects a half-typed clock, naming what was entered", () => {
			const input = dTree([
				{ id: "wake", kind: "time", label: proseText("Wake time") },
			]);
			const engine = new FormEngine(input);

			engine.setValue("/data/wake", "2:3");
			expect(engine.getState("/data/wake").valid).toBe(false);
			expect(engine.getState("/data/wake").errorMessage).toBe(
				"“2:3” isn't a time yet. Enter a clock time like 2:30 PM.",
			);
		});

		it("accepts the shape the case store holds", () => {
			const input = dTree([
				{ id: "wake", kind: "time" },
				{ id: "seen", kind: "datetime" },
				{ id: "born", kind: "date" },
			]);
			const engine = new FormEngine(input);

			engine.setValue("/data/wake", "07:30:00.000Z");
			engine.setValue("/data/seen", "2026-05-06T12:34:56.000-04:00");
			engine.setValue("/data/born", "2026-01-15");

			expect(engine.getState("/data/wake").valid).toBe(true);
			expect(engine.getState("/data/seen").valid).toBe(true);
			expect(engine.getState("/data/born").valid).toBe(true);
		});

		it("leaves an empty answer to required", () => {
			// Empty is not ill-shaped. Whether it is allowed is a different
			// question with a different message and a different moment.
			const input = dTree([
				{ id: "wake", kind: "time", required: xp("true()") },
			]);
			const engine = new FormEngine(input);

			engine.touch("/data/wake");
			expect(engine.getState("/data/wake").valid).toBe(true);
			expect(engine.validateAll()).toBe(false);
			expect(engine.getState("/data/wake").errorMessage).toBe(
				"This field is required",
			);
		});

		it("surfaces on blur, like authored validation rather than required", () => {
			const input = dTree([{ id: "wake", kind: "time" }]);
			const engine = new FormEngine(input);

			engine.setValue("/data/wake", "2:3");
			engine.touch("/data/wake");
			expect(engine.getState("/data/wake").touched).toBe(true);
			expect(engine.getState("/data/wake").valid).toBe(false);
		});

		it("blocks submission", () => {
			const input = dTree([{ id: "wake", kind: "time" }]);
			const engine = new FormEngine(input);

			engine.setValue("/data/wake", "half past two");
			expect(engine.validateAll()).toBe(false);
		});

		it("answers ahead of an authored rule, which cannot judge a non-time", () => {
			// `. > '08:00:00.000Z'` over "2:3" is a string comparison whose
			// result says nothing about why the answer is unusable. The shape
			// error is the one a person can act on.
			const input = dTree([
				{
					id: "wake",
					kind: "time",
					validate: xp(". > '08:00:00.000Z'"),
					validate_msg: proseText("Must be after 8am"),
				},
			]);
			const engine = new FormEngine(input);

			engine.setValue("/data/wake", "2:3");
			expect(engine.getState("/data/wake").errorMessage).toBe(
				"“2:3” isn't a time yet. Enter a clock time like 2:30 PM.",
			);

			engine.setValue("/data/wake", "07:30:00.000Z");
			expect(engine.getState("/data/wake").errorMessage).toBe(
				"Must be after 8am",
			);
		});

		it("says nothing about a kind that has no temporal shape", () => {
			const input = dTree([{ id: "notes", kind: "text" }]);
			const engine = new FormEngine(input);

			engine.setValue("/data/notes", "2:3");
			expect(engine.getState("/data/notes").valid).toBe(true);
		});

		it("accepts a stored answer that predates the millisecond rule", () => {
			// The pre-#376 writer stripped the fraction, so rows carry
			// `HH:MM:SSZ`. It is RFC 3339, the schema takes it, and the
			// storage boundary canonicalizes it on the way back out — asking
			// "already canonical?" here would refuse a submission over an
			// answer nobody typed and nobody can fix.
			const input = dTree([
				{ id: "wake", kind: "time" },
				{ id: "seen", kind: "datetime" },
			]);
			const engine = new FormEngine(input);

			engine.setValue("/data/wake", "08:45:00Z");
			engine.setValue("/data/seen", "2026-01-15T09:15:00-04:00");
			expect(engine.validateAll()).toBe(true);
		});

		it("accepts the bare date a today() default puts in a datetime", () => {
			// `today()` yields a date with no clock. The storage boundary has
			// always read that as the date's midnight; the gate must not turn
			// it into a submission blocker the person cannot clear.
			const input = dTree([
				{ id: "seen", kind: "datetime", default_value: xp("today()") },
			]);
			const engine = new FormEngine(input);

			expect(engine.getState("/data/seen").value).toMatch(
				/^\d{4}-\d{2}-\d{2}$/,
			);
			expect(engine.validateAll()).toBe(true);
		});

		it("names the missing half instead of quoting the join", () => {
			// A datetime is two controls over one string, so the string can be
			// incomplete in two ways. Quoting the whole value would put the
			// join's own punctuation in front of someone who can see perfectly
			// well that their answer is just missing its date.
			const input = dTree([{ id: "seen", kind: "datetime" }]);
			const engine = new FormEngine(input);

			engine.setValue("/data/seen", "T09:15:00.000-04:00");
			expect(engine.getState("/data/seen").errorMessage).toBe(
				"Pick a date: this question needs both.",
			);

			engine.setValue("/data/seen", "2026-01-15T");
			expect(engine.getState("/data/seen").errorMessage).toBe(
				"Enter a clock time: this question needs both.",
			);

			// A clock that isn't a clock gets the same sentence it gets on a
			// standalone time question, quoting only the clock.
			engine.setValue("/data/seen", "2026-01-15T2:3");
			expect(engine.getState("/data/seen").errorMessage).toBe(
				"“2:3” isn't a time yet. Enter a clock time like 2:30 PM.",
			);
		});

		it("accepts a preloaded answer without the author touching it", () => {
			// Preload writes storage shapes straight into the instance, so a
			// followup that opens on an existing case must not present every
			// temporal answer as already wrong.
			const input = dTree(
				[
					{
						id: "wake",
						kind: "time",
						caseWrite: { caseType: "patient", property: "wake" },
					},
					{
						id: "seen",
						kind: "datetime",
						caseWrite: { caseType: "patient", property: "seen" },
					},
				],
				"followup",
			);
			const engine = new FormEngine(
				input,
				"patient",
				caseDataFor("patient", [
					["wake", "07:30:00.000Z"],
					["seen", "2026-05-06T12:34:56.000-04:00"],
				]),
			);

			expect(engine.validateAll()).toBe(true);
		});
	});

	describe("required", () => {
		it("marks statically required fields", () => {
			const input = dTree([
				{
					id: "name",
					kind: "text",
					label: proseText("Name"),
					required: xp("true()"),
				},
				{ id: "notes", kind: "text", label: proseText("Notes") },
			]);
			const engine = new FormEngine(input);

			expect(engine.getState("/data/name").required).toBe(true);
			expect(engine.getState("/data/notes").required).toBe(false);
		});
	});

	describe("followup form preloading", () => {
		it("pre-populates case data into the instance", () => {
			const input = dTree(
				[
					{
						id: "case_name",
						kind: "text",
						caseWrite: { caseType: "patient", property: "case_name" },
					},
					{
						id: "age",
						kind: "int",
						caseWrite: { caseType: "patient", property: "age" },
					},
				],
				"followup",
			);

			const caseData = caseDataFor("patient", [
				["case_name", "Alice"],
				["age", "30"],
			]);
			const engine = new FormEngine(input, "patient", caseData);

			expect(engine.getState("/data/case_name").value).toBe("Alice");
			expect(engine.getState("/data/age").value).toBe("30");
		});

		it("preloads a temporal value exactly as the case store holds it", () => {
			// The instance mirrors storage rather than the device's own
			// instance spelling, so that a field's preloaded value and the
			// same property read through `#patient/<prop>` cannot disagree.
			// Rendering that value for a person is the question widget's job.
			const input = dTree(
				[
					{
						id: "case_name",
						kind: "text",
						caseWrite: { caseType: "patient", property: "case_name" },
					},
					{
						id: "wake_time",
						kind: "time",
						caseWrite: { caseType: "patient", property: "wake_time" },
					},
					{
						id: "last_seen",
						kind: "datetime",
						caseWrite: { caseType: "patient", property: "last_seen" },
					},
				],
				"followup",
			);

			const caseData = caseDataFor("patient", [
				["case_name", "Alice"],
				["wake_time", "07:30:00.000Z"],
				["last_seen", "2026-05-06T12:34:56.000-04:00"],
			]);
			const engine = new FormEngine(input, "patient", caseData);

			expect(engine.getState("/data/wake_time").value).toBe("07:30:00.000Z");
			expect(engine.getState("/data/last_seen").value).toBe(
				"2026-05-06T12:34:56.000-04:00",
			);
		});

		it("reads a preloaded field and its typed case reference identically", () => {
			// The defect this pins: a field's preload and the expression
			// resolver are two separate readers of one property bag. If only
			// one of them adapts the stored spelling, a `default_value` of
			// `#patient/wake_time` writes a different string than the field
			// beside it holds, and any comparison between them is false
			// forever.
			const input = dTree(
				[
					{
						id: "case_name",
						kind: "text",
						caseWrite: { caseType: "patient", property: "case_name" },
					},
					{
						id: "wake_time",
						kind: "time",
						caseWrite: { caseType: "patient", property: "wake_time" },
					},
					{ id: "echoed", kind: "hidden", calculate: xp("#patient/wake_time") },
				],
				"followup",
			);
			const engine = new FormEngine(
				input,
				"patient",
				caseDataFor("patient", [
					["case_name", "Alice"],
					["wake_time", "07:30:00.000Z"],
				]),
			);

			expect(engine.getState("/data/echoed").value).toBe(
				engine.getState("/data/wake_time").value,
			);
		});

		it("reaches a fixed point — resubmitting a preloaded time changes nothing", () => {
			const roundTripCaseTypes: CaseType[] = [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: proseText("Name"), data_type: "text" },
						{
							name: "wake_time",
							label: proseText("Wake time"),
							data_type: "time",
						},
					],
				},
			];
			const registration = dTree(
				[
					{
						id: "case_name",
						kind: "text",
						caseWrite: { caseType: "patient", property: "case_name" },
					},
					{
						id: "wake_time",
						kind: "time",
						caseWrite: { caseType: "patient", property: "wake_time" },
					},
				],
				"registration",
				roundTripCaseTypes,
			);
			const writer = new FormEngine(registration, "patient");
			writer.setValue("/data/case_name", "Alice");
			writer.setValue("/data/wake_time", "07:30:00.000");
			const mutation = writer.computeSubmissionMutation({
				entryKey: ENTRY_KEY,
				viewerTimeZone: "America/New_York",
			});
			if (mutation.kind !== "registration")
				throw new Error("expected register");
			const stored = mutation.primary.properties.wake_time;

			const followup = dTree(
				[
					{
						id: "case_name",
						kind: "text",
						caseWrite: { caseType: "patient", property: "case_name" },
					},
					{
						id: "wake_time",
						kind: "time",
						caseWrite: { caseType: "patient", property: "wake_time" },
					},
				],
				"followup",
				roundTripCaseTypes,
			);
			const reader = new FormEngine(
				followup,
				"patient",
				caseDataFor("patient", [
					["case_name", "Alice"],
					["wake_time", String(stored)],
				]),
			);

			// Preload hands back what was stored, and a followup that submits
			// without touching the question stores that same value again. The
			// property is the thing that must not drift across the cycle —
			// any adaptation that is not idempotent shows up right here.
			expect(reader.getState("/data/wake_time").value).toBe(stored);
			const resubmitted = reader.computeSubmissionMutation({
				caseId: "case-1",
				entryKey: ENTRY_KEY,
				viewerTimeZone: "America/New_York",
			});
			if (resubmitted.kind !== "followup") throw new Error("expected followup");
			expect(resubmitted.patch.properties.wake_time).toBe(stored);
		});
	});

	describe("default_value", () => {
		it("applies default values on init", () => {
			const input = dTree([
				{
					id: "visit_date",
					kind: "date",
					label: proseText("Visit Date"),
					default_value: xp("today()"),
				},
			]);
			const engine = new FormEngine(input);

			expect(engine.getState("/data/visit_date").value).toMatch(
				/^\d{4}-\d{2}-\d{2}$/,
			);
		});

		it("overrides preloaded case data with default_value on followup forms", () => {
			const input = dTree(
				[
					{
						id: "case_name",
						kind: "text",
						label: proseText("Name"),
						caseWrite: { caseType: "patient", property: "case_name" },
						default_value: xp(
							"concat(#patient/age, ' - ', #patient/case_name)",
						),
					},
				],
				"followup",
			);
			const caseData = caseDataFor("patient", [
				["case_name", "Alice"],
				["age", "30"],
			]);
			const engine = new FormEngine(input, "patient", caseData);

			// default_value should win over case preload
			expect(engine.getState("/data/case_name").value).toBe("30 - Alice");
		});

		it("overrides preloaded case data after reset()", () => {
			const input = dTree(
				[
					{
						id: "case_name",
						kind: "text",
						label: proseText("Name"),
						caseWrite: { caseType: "patient", property: "case_name" },
						default_value: xp(
							"concat(#patient/age, ' - ', #patient/case_name)",
						),
					},
				],
				"followup",
				[
					{
						name: "patient",
						properties: [
							{ name: "case_name", label: proseText("Patient name") },
						],
					},
					{
						name: "medication_order",
						parent_type: "patient",
						properties: [
							{ name: "case_name", label: proseText("Medication") },
							{ name: "patient_name", label: proseText("Patient name") },
						],
					},
				],
			);
			const caseData = caseDataFor("patient", [
				["case_name", "Alice"],
				["age", "30"],
			]);
			const engine = new FormEngine(input, "patient", caseData);

			engine.setValue("/data/case_name", "user typed this");
			engine.reset();
			expect(engine.getState("/data/case_name").value).toBe("30 - Alice");
		});
	});

	describe("per-case-type references (#<case_type>/<prop>)", () => {
		it("resolves the module case type's refs against the loaded case", () => {
			const input = dTree(
				[
					{
						id: "summary",
						kind: "label",
						label: prose(
							{ kind: "text", text: "Patient: " },
							{
								kind: "case-ref",
								caseType: "patient",
								property: "case_name",
							},
							{ kind: "text", text: " (" },
							{
								kind: "case-ref",
								caseType: "patient",
								property: "hiv_status",
							},
							{ kind: "text", text: ")" },
						),
					},
				],
				"followup",
			);
			const caseData = caseDataFor("patient", [
				["case_name", "Mary Smith"],
				["hiv_status", "negative"],
			]);
			const engine = new FormEngine(input, "patient", caseData);

			expect(engine.getState("/data/summary").resolvedLabel).toBe(
				"Patient: Mary Smith (negative)",
			);
		});

		it("copies loaded-case values onto child-case fields via case-ref defaults", () => {
			// The child-case copy pattern: a hidden field bound to a DIFFERENT
			// case type (a to-be-created child) whose default_value reads the
			// loaded case. The value must land in the child bucket at submit.
			const input = dTree(
				[
					{
						id: "patient_name",
						kind: "hidden",
						caseWrite: {
							caseType: "medication_order",
							property: "patient_name",
						},
						default_value: xp("#patient/case_name"),
					},
					{
						id: "case_name",
						kind: "text",
						label: proseText("Medication"),
						caseWrite: { caseType: "medication_order", property: "case_name" },
					},
				],
				"followup",
				[
					{
						name: "patient",
						properties: [
							{ name: "case_name", label: proseText("Patient name") },
						],
					},
					{
						name: "medication_order",
						parent_type: "patient",
						properties: [
							{ name: "case_name", label: proseText("Medication") },
							{ name: "patient_name", label: proseText("Patient name") },
						],
					},
				],
			);
			const caseData = caseDataFor("patient", [["case_name", "Mary Smith"]]);
			const engine = new FormEngine(input, "patient", caseData);

			expect(engine.getState("/data/patient_name").value).toBe("Mary Smith");

			engine.setValue("/data/case_name", "Rifampin");
			const mutation = engine.computeSubmissionMutation({
				caseId: "case-1",
				entryKey: ENTRY_KEY,
			});
			expect(mutation).toMatchObject({
				kind: "followup",
				children: [
					{
						caseType: "medication_order",
						caseName: "Rifampin",
						properties: { patient_name: "Mary Smith" },
					},
				],
			});
		});

		it("drives relevance from a loaded-case property", () => {
			const input = dTree(
				[
					{
						id: "not_delivered_warning",
						kind: "label",
						label: proseText("Not yet delivered"),
						relevant: xp("#medication_order/order_status != 'delivered'"),
					},
				],
				"followup",
			);
			const engine = new FormEngine(
				input,
				"medication_order",
				caseDataFor("medication_order", [["order_status", "delivered"]]),
			);

			expect(engine.getState("/data/not_delivered_warning").visible).toBe(
				false,
			);
		});

		it("resolves an ancestor case type's refs against its parent-chain row", () => {
			const input = dTree(
				[
					{
						id: "copy",
						kind: "hidden",
						default_value: xp("#household/head_name"),
					},
					{
						id: "banner",
						kind: "label",
						label: prose(
							{ kind: "text", text: "Household: " },
							{
								kind: "case-ref",
								caseType: "household",
								property: "case_name",
							},
						),
					},
				],
				"followup",
			);
			const engine = new FormEngine(
				input,
				"patient",
				new Map([
					["patient", new Map([["case_name", "Mary Smith"]])],
					[
						"household",
						new Map([
							["case_name", "Smith household"],
							["head_name", "John Smith"],
						]),
					],
				]),
			);

			expect(engine.getState("/data/copy").value).toBe("John Smith");
			expect(engine.getState("/data/banner").resolvedLabel).toBe(
				"Household: Smith household",
			);
		});

		it("resolves refs at every depth of the ancestor chain", () => {
			const input = dTree(
				[
					{
						id: "context",
						kind: "label",
						label: prose(
							{
								kind: "case-ref",
								caseType: "patient",
								property: "case_name",
							},
							{ kind: "text", text: " / " },
							{
								kind: "case-ref",
								caseType: "household",
								property: "case_name",
							},
							{ kind: "text", text: " / " },
							{
								kind: "case-ref",
								caseType: "village",
								property: "case_name",
							},
						),
					},
				],
				"followup",
			);
			const engine = new FormEngine(
				input,
				"patient",
				new Map([
					["patient", new Map([["case_name", "Mary"]])],
					["household", new Map([["case_name", "Smiths"]])],
					["village", new Map([["case_name", "Riverside"]])],
				]),
			);

			expect(engine.getState("/data/context").resolvedLabel).toBe(
				"Mary / Smiths / Riverside",
			);
		});

		it("resolves an ancestor ref blank when its row isn't in the chain", () => {
			const input = dTree(
				[
					{
						id: "copy",
						kind: "hidden",
						default_value: xp("#household/head_name"),
					},
				],
				"followup",
			);
			const engine = new FormEngine(
				input,
				"patient",
				caseDataFor("patient", [["case_name", "Mary Smith"]]),
			);

			expect(engine.getState("/data/copy").value).toBe("");
		});

		it("withholds preload when a retype re-pairs stale case data with a new module type", () => {
			const caseTypes: CaseType[] = [
				{
					name: "patient",
					properties: [{ name: "head_name", label: proseText("Head name") }],
				},
				{
					name: "household",
					properties: [{ name: "head_name", label: proseText("Head name") }],
				},
			];
			const patientInput = dTree(
				[
					{
						id: "head_name",
						kind: "text",
						caseWrite: { caseType: "patient", property: "head_name" },
					},
				],
				"followup",
				caseTypes,
			);
			const householdInput = dTree(
				[
					{
						id: "head_name",
						kind: "text",
						caseWrite: { caseType: "household", property: "head_name" },
					},
				],
				"followup",
				caseTypes,
			);
			const caseData: CaseDataByType = new Map([
				["patient", new Map([["case_name", "Mary"]])],
				["household", new Map([["head_name", "John Smith"]])],
			]);
			// Bound to a patient case; household is ancestor reference data.
			const engine = new FormEngine(patientInput, "patient", caseData);
			expect(engine.getState("/data/head_name").value).toBe("");

			// A mid-preview module retype reaches the engine through
			// refreshCaseContext with the OLD data re-paired to the NEW
			// type. The household entry is the ANCESTOR's row, not the
			// bound case — seeding field values from it would submit the
			// parent's data onto the bound row, so preload is withheld
			// until the React layer rebuilds the engine with a fresh pair.
			engine.refreshCaseContext(householdInput, caseData, "household");
			expect(engine.getState("/data/head_name").value).toBe("");
		});

		it("reads an exact typed own-case reference, never an ancestor", () => {
			const input = dTree(
				[
					{
						id: "own",
						kind: "hidden",
						default_value: xp("#patient/case_name"),
					},
				],
				"followup",
			);
			const engine = new FormEngine(
				input,
				"patient",
				new Map([
					["patient", new Map([["case_name", "Mary"]])],
					["household", new Map([["case_name", "Smiths"]])],
				]),
			);

			expect(engine.getState("/data/own").value).toBe("Mary");
		});

		it("accepts a past date under the natural `. <= today()` validation", () => {
			// The instance stores the date field's value as its ISO string;
			// the comparison must date-coerce it (JavaRosa's toNumeric
			// fallback), not read it as NaN and fail every entry.
			const input = dTree([
				{
					id: "dob",
					kind: "date",
					label: proseText("Date of birth"),
					validate: xp(". <= today()"),
					validate_msg: proseText("DOB cannot be in the future"),
				},
			]);
			const engine = new FormEngine(input);

			engine.setValue("/data/dob", "2000-05-01");
			engine.touch("/data/dob");
			expect(engine.getState("/data/dob").valid).toBe(true);

			engine.setValue("/data/dob", "2099-01-01");
			expect(engine.getState("/data/dob").valid).toBe(false);
		});

		it("preloads case data on close forms too", () => {
			const input = dTree(
				[
					{
						id: "case_name",
						kind: "text",
						label: proseText("Name"),
						caseWrite: { caseType: "patient", property: "case_name" },
					},
				],
				"close",
			);
			const engine = new FormEngine(
				input,
				"patient",
				caseDataFor("patient", [["case_name", "Mary Smith"]]),
			);

			expect(engine.getState("/data/case_name").value).toBe("Mary Smith");
		});
	});

	describe("restoreValues", () => {
		it("restores only user-touched values, preserving new defaults", () => {
			// Simulate engine recreation: old engine had a default, user touched a different field
			const input = dTree([
				{
					id: "greeting",
					kind: "text",
					label: proseText("Greeting"),
					default_value: xp("'hello'"),
				},
				{ id: "name", kind: "text", label: proseText("Name") },
			]);
			const engine = new FormEngine(input);
			expect(engine.getState("/data/greeting").value).toBe("hello");

			// User types in the name field (touched), doesn't touch greeting
			engine.setValue("/data/name", "Alice");
			engine.touch("/data/name");
			const snapshot = engine.getValueSnapshot();

			// Simulate engine recreation with updated default
			const updatedInput = dTree([
				{
					id: "greeting",
					kind: "text",
					label: proseText("Greeting"),
					default_value: xp("'goodbye'"),
				},
				{ id: "name", kind: "text", label: proseText("Name") },
			]);
			const newEngine = new FormEngine(updatedInput);
			expect(newEngine.getState("/data/greeting").value).toBe("goodbye");

			// Restore snapshot — only touched values restored, new default kept
			newEngine.restoreValues(snapshot);
			expect(newEngine.getState("/data/name").value).toBe("Alice");
			expect(newEngine.getState("/data/greeting").value).toBe("goodbye");
		});

		it("does not overwrite new defaults with stale untouched values", () => {
			const input = dTree([
				{
					id: "status",
					kind: "text",
					label: proseText("Status"),
					default_value: xp("'active'"),
				},
			]);
			const engine = new FormEngine(input);
			expect(engine.getState("/data/status").value).toBe("active");

			// Snapshot includes the default-computed value but field was never touched
			const snapshot = engine.getValueSnapshot();
			expect(snapshot.values.get("/data/status")).toBe("active");
			expect(snapshot.touched.has("/data/status")).toBe(false);

			// New engine with different default
			const updatedInput = dTree([
				{
					id: "status",
					kind: "text",
					label: proseText("Status"),
					default_value: xp("'archived'"),
				},
			]);
			const newEngine = new FormEngine(updatedInput);
			newEngine.restoreValues(snapshot);

			// New default should win — stale 'active' should not overwrite 'archived'
			expect(newEngine.getState("/data/status").value).toBe("archived");
		});
	});

	describe("groups", () => {
		it("handles nested group fields", () => {
			const input = dTree([
				{
					id: "demographics",
					kind: "group",
					label: proseText("Demographics"),
					children: [
						{ id: "name", kind: "text", label: proseText("Name") },
						{ id: "age", kind: "int", label: proseText("Age") },
					],
				},
			]);
			const engine = new FormEngine(input);

			engine.setValue("/data/demographics/name", "Bob");
			expect(engine.getState("/data/demographics/name").value).toBe("Bob");
		});
	});

	describe("repeats", () => {
		// The engine must publish the live instance count on the repeat's own
		// `FieldState.repeatCount` — that's what makes the preview's Add/Remove
		// buttons reactive. A regression here puts us back to the silent-no-op
		// click that motivated this slot existing.
		it("seeds repeatCount=1 on the repeat's own state", () => {
			const input = dTree([
				{
					id: "members",
					kind: "repeat",
					label: proseText("Household members"),
					children: [{ id: "name", kind: "text", label: proseText("Name") }],
				},
			]);
			const engine = new FormEngine(input);

			expect(engine.getState("/data/members").repeatCount).toBe(1);
		});

		it("addRepeat bumps repeatCount and rewrites the FieldState reference", () => {
			const input = dTree([
				{
					id: "members",
					kind: "repeat",
					label: proseText("Household members"),
					children: [{ id: "name", kind: "text", label: proseText("Name") }],
				},
			]);
			const engine = new FormEngine(input);

			const before = engine.store.getState()["/data/members"];
			expect(before?.repeatCount).toBe(1);

			const newIndex = engine.addRepeat("/data/members");
			expect(newIndex).toBe(1);

			const after = engine.store.getState()["/data/members"];
			expect(after?.repeatCount).toBe(2);
			// New reference is the reactivity contract Zustand subscribers rely on.
			expect(after).not.toBe(before);
		});

		it("removeRepeat decrements repeatCount and rewrites the FieldState reference", () => {
			const input = dTree([
				{
					id: "members",
					kind: "repeat",
					label: proseText("Household members"),
					children: [{ id: "name", kind: "text", label: proseText("Name") }],
				},
			]);
			const engine = new FormEngine(input);

			engine.addRepeat("/data/members");
			engine.addRepeat("/data/members");
			expect(engine.getState("/data/members").repeatCount).toBe(3);

			const before = engine.store.getState()["/data/members"];
			engine.removeRepeat("/data/members", 1);
			const after = engine.store.getState()["/data/members"];

			expect(after?.repeatCount).toBe(2);
			expect(after).not.toBe(before);
		});

		// `removeRepeat` first writes DEFAULT_ENGINE_STATE for every path under
		// the deleted index, then renumbers higher indices down by writing the
		// shifted state into the same `updates` object. When index 0 is removed
		// from a [0,1] pair, both loops touch `[0]/...` paths — the renumber
		// loop's write must clobber the deletion loop's, otherwise the
		// surviving instance's value disappears. This test pins that ordering
		// invariant as a behavioral contract so a future cleanup can't quietly
		// reorder the loops without a regression.
		it("removeRepeat(0) renumbers higher instances down and preserves their values", () => {
			const input = dTree([
				{
					id: "members",
					kind: "repeat",
					label: proseText("Household members"),
					children: [{ id: "name", kind: "text", label: proseText("Name") }],
				},
			]);
			const engine = new FormEngine(input);

			engine.addRepeat("/data/members");
			engine.setValue("/data/members[0]/name", "Alice");
			engine.setValue("/data/members[1]/name", "Bob");

			engine.removeRepeat("/data/members", 0);

			expect(engine.getState("/data/members").repeatCount).toBe(1);
			// Bob's value moves down into the [0] slot — renumber loop won.
			expect(engine.getState("/data/members[0]/name").value).toBe("Bob");
			// The vacated [1]/name slot is unplugged to the frozen default.
			expect(engine.getState("/data/members[1]/name").value).toBe("");
		});

		it("keeps surviving repeat render identities when indices compact", () => {
			const input = dTree([
				{
					id: "members",
					kind: "repeat",
					children: [{ id: "name", kind: "text" }],
				},
			]);
			const engine = new FormEngine(input);
			engine.addRepeat("/data/members");
			engine.addRepeat("/data/members");
			const first = engine.getRepeatInstanceKey("/data/members", 0);
			const removed = engine.getRepeatInstanceKey("/data/members", 1);
			const third = engine.getRepeatInstanceKey("/data/members", 2);

			engine.removeRepeat("/data/members", 1);

			expect(engine.getRepeatInstanceKey("/data/members", 0)).toBe(first);
			expect(engine.getRepeatInstanceKey("/data/members", 1)).toBe(third);
			expect(engine.getRepeatInstanceKey("/data/members", 1)).not.toBe(removed);
		});

		it("remaps nested repeat identities with their surviving parent instance", () => {
			const input = dTree([
				{
					id: "households",
					kind: "repeat",
					children: [
						{
							id: "members",
							kind: "repeat",
							children: [{ id: "name", kind: "text" }],
						},
					],
				},
			]);
			const engine = new FormEngine(input);
			engine.addRepeat("/data/households");
			engine.addRepeat("/data/households[1]/members");
			const survivingNestedKeys = [
				engine.getRepeatInstanceKey("/data/households[1]/members", 0),
				engine.getRepeatInstanceKey("/data/households[1]/members", 1),
			];

			engine.removeRepeat("/data/households", 0);

			expect([
				engine.getRepeatInstanceKey("/data/households[0]/members", 0),
				engine.getRepeatInstanceKey("/data/households[0]/members", 1),
			]).toEqual(survivingNestedKeys);
		});

		// `repeatCount` rides on the same `FieldState` object that visibility
		// and validation cascades rewrite — so any cascade that re-evaluates
		// the repeat's own path (e.g. its parent's `relevant` toggling) must
		// preserve the count. The engine accomplishes this by spreading
		// `...current` when it builds the new state; this test pins that
		// behaviour as a contract so a future cleanup can't quietly switch
		// to an explicit-keys reconstruction and silently lose the slot.
		it("preserves repeatCount through a relevance-driven cascade", () => {
			const input = dTree([
				{
					id: "show",
					kind: "single_select",
					label: proseText("Show?"),
					optionsSource: inlineOptions("repeat-visibility", [
						["yes", "Yes"],
						["no", "No"],
					]),
				},
				{
					id: "members",
					kind: "repeat",
					label: proseText("Members"),
					relevant: xp('/data/show = "yes"'),
					children: [{ id: "name", kind: "text", label: proseText("Name") }],
				},
			]);
			const engine = new FormEngine(input);

			engine.setValue("/data/show", "yes");
			engine.addRepeat("/data/members");
			expect(engine.getState("/data/members").repeatCount).toBe(2);

			// Toggle the parent's relevance off and back on. Each transition
			// rewrites the repeat's `visible` flag, which forces a fresh
			// FieldState reference for the repeat's path.
			engine.setValue("/data/show", "no");
			engine.setValue("/data/show", "yes");

			expect(engine.getState("/data/members").repeatCount).toBe(2);
		});

		it("removeRepeat is a no-op when only one instance remains", () => {
			const input = dTree([
				{
					id: "members",
					kind: "repeat",
					label: proseText("Household members"),
					children: [{ id: "name", kind: "text", label: proseText("Name") }],
				},
			]);
			const engine = new FormEngine(input);

			const before = engine.store.getState()["/data/members"];
			engine.removeRepeat("/data/members", 0);
			const after = engine.store.getState()["/data/members"];

			expect(after?.repeatCount).toBe(1);
			// Same reference — no spurious re-render fired.
			expect(after).toBe(before);
		});
	});

	describe("touch (blur validation)", () => {
		it("marks field as touched — required validation deferred to submit", () => {
			const input = dTree([
				{
					id: "name",
					kind: "text",
					label: proseText("Name"),
					required: xp("true()"),
				},
			]);
			const engine = new FormEngine(input);

			// Not touched yet — valid despite being empty
			expect(engine.getState("/data/name").touched).toBe(false);
			expect(engine.getState("/data/name").valid).toBe(true);

			// Touch marks as touched but does NOT run required validation (deferred to submit)
			engine.touch("/data/name");
			expect(engine.getState("/data/name").touched).toBe(true);
			expect(engine.getState("/data/name").valid).toBe(true);

			// Submit triggers required validation
			expect(engine.validateAll()).toBe(false);
			expect(engine.getState("/data/name").valid).toBe(false);
			expect(engine.getState("/data/name").errorMessage).toBe(
				"This field is required",
			);

			// Filling the value clears the error
			engine.setValue("/data/name", "Alice");
			expect(engine.validateAll()).toBe(true);
			expect(engine.getState("/data/name").valid).toBe(true);
		});

		it("runs validation on touch when field has a value", () => {
			const input = dTree([
				{
					id: "age",
					kind: "int",
					label: proseText("Age"),
					validate: xp(". > 0"),
					validate_msg: proseText("Must be positive"),
				},
			]);
			const engine = new FormEngine(input);

			engine.setValue("/data/age", "-5");
			// setValue runs validation, so it's already invalid
			expect(engine.getState("/data/age").valid).toBe(false);

			// But touch also runs it
			engine.touch("/data/age");
			expect(engine.getState("/data/age").touched).toBe(true);
			expect(engine.getState("/data/age").valid).toBe(false);
			expect(engine.getState("/data/age").errorMessage).toBe(
				"Must be positive",
			);
		});
	});

	describe("validateAll (submit validation)", () => {
		it("marks all visible required empty fields as invalid", () => {
			const input = dTree([
				{
					id: "name",
					kind: "text",
					label: proseText("Name"),
					required: xp("true()"),
				},
				{
					id: "email",
					kind: "text",
					label: proseText("Email"),
					required: xp("true()"),
				},
				{ id: "notes", kind: "text", label: proseText("Notes") },
			]);
			const engine = new FormEngine(input);

			const valid = engine.validateAll();
			expect(valid).toBe(false);
			expect(engine.getState("/data/name").valid).toBe(false);
			expect(engine.getState("/data/name").touched).toBe(true);
			expect(engine.getState("/data/email").valid).toBe(false);
			expect(engine.getState("/data/notes").valid).toBe(true);
		});

		it("returns true when all required fields are filled", () => {
			const input = dTree([
				{
					id: "name",
					kind: "text",
					label: proseText("Name"),
					required: xp("true()"),
				},
			]);
			const engine = new FormEngine(input);

			engine.setValue("/data/name", "Alice");
			expect(engine.validateAll()).toBe(true);
		});

		it("skips hidden (not visible) fields", () => {
			const input = dTree([
				{
					id: "toggle",
					kind: "single_select",
					label: proseText("Show?"),
					optionsSource: inlineOptions("required-visibility", [
						["yes", "Yes"],
						["no", "No"],
					]),
				},
				{
					id: "conditional",
					kind: "text",
					label: proseText("Details"),
					required: xp("true()"),
					relevant: xp('/data/toggle = "yes"'),
				},
			]);
			const engine = new FormEngine(input);

			// conditional is not visible (toggle is empty) so it should not cause validation failure
			engine.setValue("/data/toggle", "no");
			expect(engine.validateAll()).toBe(true);
		});

		it("skips required descendants of an irrelevant group", () => {
			const input = dTree([
				{ id: "gate", kind: "text", label: proseText("Gate") },
				{
					id: "section",
					kind: "group",
					label: proseText("Section"),
					relevant: xp("/data/gate = 'yes'"),
					children: [
						{
							id: "photo",
							kind: "image",
							label: proseText("Photo"),
							required: xp("true()"),
						},
					],
				},
			]);
			const engine = new FormEngine(input);
			engine.setValue("/data/gate", "no");

			expect(engine.getState("/data/section").visible).toBe(false);
			expect(engine.getState("/data/section/photo").visible).toBe(true);
			expect(engine.validateAll()).toBe(true);
			expect(engine.getState("/data/section/photo").touched).toBe(false);
		});

		it("skips required descendants of an irrelevant repeat", () => {
			const input = dTree([
				{ id: "gate", kind: "text", label: proseText("Gate") },
				{
					id: "visits",
					kind: "repeat",
					label: proseText("Visits"),
					relevant: xp("/data/gate = 'yes'"),
					children: [
						{
							id: "photo",
							kind: "image",
							label: proseText("Photo"),
							required: xp("true()"),
						},
					],
				},
			]);
			const engine = new FormEngine(input);
			engine.setValue("/data/gate", "no");

			expect(engine.validateAll()).toBe(true);
			expect(engine.getState("/data/visits[0]/photo").touched).toBe(false);
		});
	});

	describe("Zustand store reactivity", () => {
		it("updates store state on value change", () => {
			const input = dTree([
				{ id: "name", kind: "text", label: proseText("Name") },
			]);
			const engine = new FormEngine(input);

			let called = false;
			engine.store.subscribe(() => {
				called = true;
			});

			engine.setValue("/data/name", "Test");
			expect(called).toBe(true);
			expect(engine.store.getState()["/data/name"]?.value).toBe("Test");
		});

		it("allows unsubscribing from store", () => {
			const input = dTree([
				{ id: "name", kind: "text", label: proseText("Name") },
			]);
			const engine = new FormEngine(input);

			let callCount = 0;
			const unsub = engine.store.subscribe(() => {
				callCount++;
			});

			engine.setValue("/data/name", "A");
			expect(callCount).toBe(1);

			unsub();
			engine.setValue("/data/name", "B");
			expect(callCount).toBe(1);
		});

		it("only creates new state objects for changed paths", () => {
			const input = dTree([
				{ id: "age", kind: "text", label: proseText("Age") },
				{ id: "name", kind: "text", label: proseText("Name") },
			]);
			const engine = new FormEngine(input);

			/* Capture state references before the change */
			const nameBefore = engine.store.getState()["/data/name"];
			const ageBefore = engine.store.getState()["/data/age"];

			engine.setValue("/data/age", "25");

			/* The changed path gets a new object */
			const ageAfter = engine.store.getState()["/data/age"];
			expect(ageAfter).not.toBe(ageBefore);
			expect(ageAfter?.value).toBe("25");

			/* The unchanged path keeps the same reference — Zustand selectors
			 * using Object.is would correctly skip re-rendering this path. */
			const nameAfter = engine.store.getState()["/data/name"];
			expect(nameAfter).toBe(nameBefore);
		});
	});

	describe("hashtag refs in labels", () => {
		it("resolves hashtag refs in labels with #case refs", () => {
			const input = dTree(
				[
					{
						id: "case_name",
						kind: "text",
						label: proseText("Name"),
						caseWrite: { caseType: "patient", property: "case_name" },
					},
					{
						id: "greeting",
						kind: "label",
						label: prose(
							{ kind: "text", text: "Hello, " },
							{
								kind: "case-ref",
								caseType: "patient",
								property: "case_name",
							},
							{ kind: "text", text: "!" },
						),
					},
				],
				"followup",
			);
			const caseData = caseDataFor("patient", [["case_name", "John Smith"]]);
			const engine = new FormEngine(input, "patient", caseData);

			expect(engine.getState("/data/greeting").resolvedLabel).toBe(
				"Hello, John Smith!",
			);
		});

		it("resolves hashtag refs referencing form fields", () => {
			const input = dTree([
				{ id: "name", kind: "text", label: proseText("Name") },
				{
					id: "summary",
					kind: "label",
					label: prose(
						{ kind: "text", text: "You entered: " },
						{ kind: "field-ref", uuid: testUuid("form.name") },
					),
				},
			]);
			const engine = new FormEngine(input);

			// Initially empty
			expect(engine.getState("/data/summary").resolvedLabel).toBe(
				"You entered: ",
			);

			// After setting a value, the label updates reactively
			engine.setValue("/data/name", "Alice");
			expect(engine.getState("/data/summary").resolvedLabel).toBe(
				"You entered: Alice",
			);
		});

		it("resolves multi-segment hashtag refs to fields nested in groups", () => {
			// A re-anchored ref (`#form/demographics/name` after a move into a
			// group) must keep resolving in preview — label AND calculate.
			const input = dTree([
				{
					id: "demographics",
					kind: "group",
					label: proseText("Demographics"),
					children: [{ id: "name", kind: "text", label: proseText("Name") }],
				},
				{
					id: "summary",
					kind: "label",
					label: prose(
						{ kind: "text", text: "You entered: " },
						{
							kind: "field-ref",
							uuid: testUuid("form.demographics.name"),
						},
					),
				},
				{
					id: "echo",
					kind: "hidden",
					calculate: formXp("#form/demographics/name"),
				},
			]);
			const engine = new FormEngine(input);

			engine.setValue("/data/demographics/name", "Alice");
			expect(engine.getState("/data/summary").resolvedLabel).toBe(
				"You entered: Alice",
			);
			expect(engine.getState("/data/echo").value).toBe("Alice");
		});

		it("resolves multiple hashtag refs in one label", () => {
			const input = dTree([
				{ id: "first", kind: "text", label: proseText("First") },
				{ id: "last", kind: "text", label: proseText("Last") },
				{
					id: "display",
					kind: "label",
					label: prose(
						{ kind: "field-ref", uuid: testUuid("form.first") },
						{ kind: "text", text: " " },
						{ kind: "field-ref", uuid: testUuid("form.last") },
					),
				},
			]);
			const engine = new FormEngine(input);

			engine.setValue("/data/first", "Jane");
			engine.setValue("/data/last", "Doe");
			expect(engine.getState("/data/display").resolvedLabel).toBe("Jane Doe");
		});

		it("resolves hashtag refs in hints", () => {
			const input = dTree([
				{ id: "name", kind: "text", label: proseText("Name") },
				{
					id: "age",
					kind: "int",
					label: proseText("Age"),
					hint: prose(
						{ kind: "text", text: "Age for " },
						{ kind: "field-ref", uuid: testUuid("form.name") },
					),
				},
			]);
			const engine = new FormEngine(input);

			engine.setValue("/data/name", "Bob");
			expect(engine.getState("/data/age").resolvedHint).toBe("Age for Bob");
		});

		it("cascades through calculated fields into hashtag refs", () => {
			const input = dTree([
				{ id: "age", kind: "int", label: proseText("Age") },
				{
					id: "status",
					kind: "hidden",
					calculate: xp("if(/data/age > 18, 'Adult', 'Minor')"),
				},
				{
					id: "info",
					kind: "label",
					label: prose(
						{ kind: "text", text: "Status: " },
						{ kind: "field-ref", uuid: testUuid("form.status") },
					),
				},
			]);
			const engine = new FormEngine(input);

			engine.setValue("/data/age", "25");
			expect(engine.getState("/data/info").resolvedLabel).toBe("Status: Adult");

			engine.setValue("/data/age", "10");
			expect(engine.getState("/data/info").resolvedLabel).toBe("Status: Minor");
		});

		it("does not set resolvedLabel when no hashtag refs present", () => {
			const input = dTree([
				{ id: "name", kind: "text", label: proseText("Plain label") },
			]);
			const engine = new FormEngine(input);

			expect(engine.getState("/data/name").resolvedLabel).toBeUndefined();
		});
	});

	describe("#user identity resolution", () => {
		const identity = previewAsMe({
			id: "worker-7",
			name: "Amina Diallo",
			email: "amina@example.org",
		});

		it("resolves #user/* from the identity's usercase projection", () => {
			// `#user/<prop>` is the usercase, whose built-in keys are HQ's
			// `_get_user_case_fields` set — `hq_user_id`, not `userid`, and the
			// unprefixed name fields. The session block's `commcare_`-prefixed
			// keys live on the other projection and do not resolve here.
			const input = dTree([
				{ id: "who", kind: "hidden", calculate: xp("#user/username") },
				{ id: "first", kind: "hidden", calculate: xp("#user/first_name") },
				{ id: "uid", kind: "hidden", calculate: xp("#user/hq_user_id") },
				{ id: "session_key", kind: "hidden", calculate: xp("#user/userid") },
			]);
			const engine = new FormEngine(input, undefined, undefined, identity);

			expect(engine.getState("/data/who").value).toBe("amina@example.org");
			expect(engine.getState("/data/first").value).toBe("Amina");
			expect(engine.getState("/data/uid").value).toBe("worker-7");
			expect(engine.getState("/data/session_key").value).toBe("");
		});

		it("reads an absent user-data key as blank, never a placeholder", () => {
			const input = dTree([
				{ id: "phone", kind: "hidden", calculate: xp("#user/phone_number") },
			]);
			const engine = new FormEngine(input, undefined, undefined, identity);

			expect(engine.getState("/data/phone").value).toBe("");
		});

		it("reads every user slice as absent without an identity", () => {
			const input = dTree([
				{ id: "who", kind: "hidden", calculate: xp("#user/username") },
			]);
			const engine = new FormEngine(input);

			expect(engine.getState("/data/who").value).toBe("");
		});

		it("does not resolve #user through an inherited prototype key", () => {
			if (identity === null) throw new Error("identity setup failed");
			const inheritedIdentity = {
				...identity,
				usercase: Object.create({ constructor: "poison" }) as Record<
					string,
					string
				>,
			};
			const input = dTree([
				{ id: "who", kind: "hidden", calculate: xp("#user/constructor") },
			]);
			const engine = new FormEngine(
				input,
				undefined,
				undefined,
				inheritedIdentity,
			);

			expect(engine.getState("/data/who").value).toBe("");
		});
	});

	// computeSubmissionMutation walks the engine's template tree, fans
	// repeats out per instance, buckets fields by destination case type,
	// and emits a typed `SubmissionMutation` per form type. Each test
	// constructs a real engine, drives values through the public API,
	// and asserts the emitted mutation shape directly.
	describe("computeSubmissionMutation", () => {
		const patientCaseType: CaseType = {
			name: "patient",
			properties: [
				{ name: "case_name", label: proseText("Name"), data_type: "text" },
				{ name: "age", label: proseText("Age"), data_type: "int" },
				{ name: "weight", label: proseText("Weight"), data_type: "decimal" },
				{ name: "tags", label: proseText("Tags"), data_type: "multi_select" },
				{ name: "notes", label: proseText("Notes"), data_type: "text" },
				{ name: "extra", label: proseText("Extra"), data_type: "int" },
				// The remaining scalar data types. `date`, `geopoint`, and
				// `single_select` pass through untouched; `time` and
				// `datetime` cross the storage boundary. Declared on the
				// canonical `patient` case-type so the per-type coercion
				// tests below match a real property declaration rather
				// than tripping the unknown-property fallthrough.
				{ name: "dob", label: proseText("DOB"), data_type: "date" },
				{
					name: "last_seen",
					label: proseText("Last seen"),
					data_type: "datetime",
				},
				{ name: "wake_time", label: proseText("Wake time"), data_type: "time" },
				{
					name: "home_location",
					label: proseText("Home"),
					data_type: "geopoint",
				},
				{
					name: "priority",
					label: proseText("Priority"),
					data_type: "single_select",
				},
			],
		};
		const visitCaseType: CaseType = {
			name: "visit",
			parent_type: "patient",
			properties: [
				{ name: "case_name", label: proseText("Name"), data_type: "text" },
				{ name: "visit_date", label: proseText("Date"), data_type: "date" },
				{
					name: "first_visit_date",
					label: proseText("First visit date"),
					data_type: "date",
				},
				{
					name: "discharge_date",
					label: proseText("Discharge date"),
					data_type: "date",
				},
				{ name: "summary", label: proseText("Summary"), data_type: "text" },
			],
		};
		const meditationCaseType: CaseType = {
			name: "medication",
			parent_type: "patient",
			properties: [
				{ name: "case_name", label: proseText("Name"), data_type: "text" },
				{ name: "dosage_mg", label: proseText("Dosage"), data_type: "int" },
			],
		};
		const caseTypes = [patientCaseType, visitCaseType, meditationCaseType];
		const boundInput = (
			fields: DField[],
			formType: FormType = "registration",
		): FormEngineInput => dTree(fields, formType, caseTypes);

		describe("registration", () => {
			it("emits primary properties for fields bound to the module's case type", () => {
				const input = boundInput([
					{
						id: "case_name",
						kind: "text",
						caseWrite: { caseType: "patient", property: "case_name" },
					},
					{
						id: "age",
						kind: "int",
						caseWrite: { caseType: "patient", property: "age" },
					},
				]);
				const engine = new FormEngine(input, "patient");

				engine.setValue("/data/case_name", "Alice");
				engine.setValue("/data/age", "30");

				const mutation = engine.computeSubmissionMutation({
					entryKey: ENTRY_KEY,
				});
				expect(mutation).toEqual({
					kind: "registration",
					formUuid: testUuid("test-form-uuid"),
					entryKey: ENTRY_KEY,
					attachmentRefs: [],
					primary: {
						caseType: "patient",
						caseName: "Alice",
						properties: { age: 30 },
					},
					children: [],
				});
			});

			it("buckets fields with an exact direct-child caseWrite destination into a child case", () => {
				const input = boundInput([
					{
						id: "case_name",
						kind: "text",
						caseWrite: { caseType: "patient", property: "case_name" },
					},
					{
						id: "age",
						kind: "int",
						caseWrite: { caseType: "patient", property: "age" },
					},
					{
						id: "visit_name",
						kind: "text",
						caseWrite: { caseType: "visit", property: "case_name" },
					},
					{
						id: "first_visit_date",
						kind: "date",
						caseWrite: { caseType: "visit", property: "first_visit_date" },
					},
				]);
				const engine = new FormEngine(input, "patient");

				engine.setValue("/data/case_name", "Alice");
				engine.setValue("/data/age", "30");
				engine.setValue("/data/visit_name", "First visit");
				engine.setValue("/data/first_visit_date", "2026-05-01");

				const mutation = engine.computeSubmissionMutation({
					entryKey: ENTRY_KEY,
				});
				expect(mutation.kind).toBe("registration");
				if (mutation.kind !== "registration") return;
				expect(mutation.primary).toEqual({
					caseType: "patient",
					caseName: "Alice",
					properties: { age: 30 },
				});
				expect(mutation.children).toEqual([
					{
						caseType: "visit",
						caseName: "First visit",
						properties: { first_visit_date: "2026-05-01" },
					},
				]);
				// Registration children carry NO parentCaseId — the case-store
				// threads the primary's generated id at write time.
				const child = mutation.children[0];
				expect(child).toBeDefined();
				expect("parentCaseId" in (child ?? {})).toBe(false);
			});

			it("keeps two distinct child case types in separate children buckets", () => {
				const input = boundInput([
					{
						id: "case_name",
						kind: "text",
						caseWrite: { caseType: "patient", property: "case_name" },
					},
					{
						id: "visit_name",
						kind: "text",
						caseWrite: { caseType: "visit", property: "case_name" },
					},
					{
						id: "medication_name",
						kind: "text",
						caseWrite: { caseType: "medication", property: "case_name" },
					},
					{
						id: "first_visit_date",
						kind: "date",
						caseWrite: { caseType: "visit", property: "first_visit_date" },
					},
					{
						id: "dosage_mg",
						kind: "int",
						caseWrite: { caseType: "medication", property: "dosage_mg" },
					},
				]);
				const engine = new FormEngine(input, "patient");

				engine.setValue("/data/case_name", "Alice");
				engine.setValue("/data/visit_name", "First visit");
				engine.setValue("/data/medication_name", "Rifampin");
				engine.setValue("/data/first_visit_date", "2026-05-01");
				engine.setValue("/data/dosage_mg", "200");

				const mutation = engine.computeSubmissionMutation({
					entryKey: ENTRY_KEY,
				});
				expect(mutation.kind).toBe("registration");
				if (mutation.kind !== "registration") return;
				expect(mutation.children).toEqual([
					{
						caseType: "visit",
						caseName: "First visit",
						properties: { first_visit_date: "2026-05-01" },
					},
					{
						caseType: "medication",
						caseName: "Rifampin",
						properties: { dosage_mg: 200 },
					},
				]);
			});

			it("fans repeats out into one child per instance per destination case type", () => {
				const input = boundInput([
					{
						id: "case_name",
						kind: "text",
						caseWrite: { caseType: "patient", property: "case_name" },
					},
					{
						id: "visits",
						kind: "repeat",
						children: [
							{
								id: "visit_name",
								kind: "text",
								caseWrite: { caseType: "visit", property: "case_name" },
							},
							{
								id: "visit_date",
								kind: "date",
								caseWrite: { caseType: "visit", property: "visit_date" },
							},
							{
								id: "summary",
								kind: "text",
								caseWrite: { caseType: "visit", property: "summary" },
							},
						],
					},
				]);
				const engine = new FormEngine(input, "patient");

				engine.setValue("/data/case_name", "Alice");
				engine.setValue("/data/visits[0]/visit_name", "First visit");
				engine.setValue("/data/visits[0]/visit_date", "2026-05-01");
				engine.setValue("/data/visits[0]/summary", "first");
				engine.addRepeat("/data/visits");
				engine.setValue("/data/visits[1]/visit_name", "Second visit");
				engine.setValue("/data/visits[1]/visit_date", "2026-05-02");
				engine.setValue("/data/visits[1]/summary", "second");
				engine.addRepeat("/data/visits");
				engine.setValue("/data/visits[2]/visit_name", "Third visit");
				engine.setValue("/data/visits[2]/visit_date", "2026-05-03");
				engine.setValue("/data/visits[2]/summary", "third");

				const mutation = engine.computeSubmissionMutation({
					entryKey: ENTRY_KEY,
				});
				expect(mutation.kind).toBe("registration");
				if (mutation.kind !== "registration") return;
				expect(mutation.children).toHaveLength(3);
				expect(mutation.children[0]).toEqual({
					caseType: "visit",
					caseName: "First visit",
					properties: { visit_date: "2026-05-01", summary: "first" },
				});
				expect(mutation.children[1]).toEqual({
					caseType: "visit",
					caseName: "Second visit",
					properties: { visit_date: "2026-05-02", summary: "second" },
				});
				expect(mutation.children[2]).toEqual({
					caseType: "visit",
					caseName: "Third visit",
					properties: { visit_date: "2026-05-03", summary: "third" },
				});
			});

			it("plucks a child-case `case_name` field into the child's caseName slot", () => {
				// A child-bound `case_name` field routes to the child's
				// top-level column, parallel to the primary's behaviour.
				// Distinct child case-types each get their own caseName.
				const input = boundInput([
					{
						id: "case_name",
						kind: "text",
						caseWrite: { caseType: "patient", property: "case_name" },
					},
					{
						id: "visits",
						kind: "repeat",
						children: [
							{
								id: "case_name",
								kind: "text",
								caseWrite: { caseType: "visit", property: "case_name" },
							},
							{
								id: "visit_date",
								kind: "date",
								caseWrite: { caseType: "visit", property: "visit_date" },
							},
						],
					},
				]);
				const engine = new FormEngine(input, "patient");

				engine.setValue("/data/case_name", "Alice");
				engine.setValue("/data/visits[0]/case_name", "First visit");
				engine.setValue("/data/visits[0]/visit_date", "2026-05-01");

				const mutation = engine.computeSubmissionMutation({
					entryKey: ENTRY_KEY,
				});
				expect(mutation.kind).toBe("registration");
				if (mutation.kind !== "registration") return;
				expect(mutation.primary.caseName).toBe("Alice");
				expect(mutation.primary.properties).toEqual({});
				expect(mutation.children).toEqual([
					{
						caseType: "visit",
						caseName: "First visit",
						properties: { visit_date: "2026-05-01" },
					},
				]);
			});

			it("emits a child case with only a caseName when no other child fields contribute", () => {
				// A registration form whose only contribution to a child
				// case is the display name still emits the child — the
				// platform defaults handle the rest.
				const input = boundInput([
					{
						id: "case_name",
						kind: "text",
						caseWrite: { caseType: "patient", property: "case_name" },
					},
					{
						id: "visits",
						kind: "repeat",
						children: [
							{
								id: "case_name",
								kind: "text",
								caseWrite: { caseType: "visit", property: "case_name" },
							},
						],
					},
				]);
				const engine = new FormEngine(input, "patient");

				engine.setValue("/data/case_name", "Alice");
				engine.setValue("/data/visits[0]/case_name", "First visit");

				const mutation = engine.computeSubmissionMutation({
					entryKey: ENTRY_KEY,
				});
				expect(mutation.kind).toBe("registration");
				if (mutation.kind !== "registration") return;
				expect(mutation.children).toEqual([
					{ caseType: "visit", caseName: "First visit", properties: {} },
				]);
			});

			it("rejects a primary case_name writer whose active value is blank", () => {
				// An active blank name is malformed submission intent, not an
				// omitted scalar. The same shared scalar contract blocks it in
				// Preview before `cases.case_name` can see an empty value.
				const input = boundInput([
					{
						id: "case_name",
						kind: "text",
						caseWrite: { caseType: "patient", property: "case_name" },
					},
					{
						id: "age",
						kind: "int",
						caseWrite: { caseType: "patient", property: "age" },
					},
				]);
				const engine = new FormEngine(input, "patient");

				engine.setValue("/data/age", "30");

				expect(() =>
					engine.computeSubmissionMutation({
						entryKey: ENTRY_KEY,
					}),
				).toThrow(/cannot write case_name: the value is blank/);
			});

			it("throws when registration reaches the engine without a moduleCaseType", () => {
				const input = boundInput([
					{
						id: "case_name",
						kind: "text",
						caseWrite: { caseType: "patient", property: "case_name" },
					},
				]);
				const engine = new FormEngine(input);

				expect(() =>
					engine.computeSubmissionMutation({
						entryKey: ENTRY_KEY,
					}),
				).toThrow(/has caseWrite but its form emits no case action/);
			});
		});

		describe("followup", () => {
			it("emits a primary patch and binds children to the supplied caseId", () => {
				const input = boundInput(
					[
						{
							id: "case_name",
							kind: "text",
							caseWrite: { caseType: "patient", property: "case_name" },
						},
						{
							id: "notes",
							kind: "text",
							caseWrite: { caseType: "patient", property: "notes" },
						},
						{
							id: "visit_name",
							kind: "text",
							caseWrite: { caseType: "visit", property: "case_name" },
						},
						{
							id: "visit_date",
							kind: "date",
							caseWrite: { caseType: "visit", property: "visit_date" },
						},
					],
					"followup",
				);
				const caseData = caseDataFor("patient", [["case_name", "Alice"]]);
				const engine = new FormEngine(input, "patient", caseData);

				engine.setValue("/data/case_name", "Alice");
				engine.setValue("/data/notes", "follow-up note");
				engine.setValue("/data/visit_name", "Second visit");
				engine.setValue("/data/visit_date", "2026-05-02");

				const mutation = engine.computeSubmissionMutation({
					caseId: "case-id-123",
					entryKey: ENTRY_KEY,
				});
				expect(mutation).toEqual({
					kind: "followup",
					formUuid: testUuid("test-form-uuid"),
					entryKey: ENTRY_KEY,
					attachmentRefs: [],
					caseId: "case-id-123",
					patch: {
						caseName: "Alice",
						properties: { notes: "follow-up note" },
					},
					children: [
						{
							caseType: "visit",
							caseName: "Second visit",
							properties: { visit_date: "2026-05-02" },
							parentCaseId: "case-id-123",
						},
					],
				});
			});

			it("throws when no caseId is supplied", () => {
				const input = boundInput(
					[
						{
							id: "notes",
							kind: "text",
							caseWrite: { caseType: "patient", property: "notes" },
						},
					],
					"followup",
				);
				const engine = new FormEngine(input, "patient");

				engine.setValue("/data/notes", "hello");
				expect(() =>
					engine.computeSubmissionMutation({
						entryKey: ENTRY_KEY,
					}),
				).toThrow(/form type `followup` requires a bound `caseId`/);
			});

			it("emits an empty primary patch when no fields target the module's case type", () => {
				// Followup forms whose every leaf field targets a child case
				// type still emit the discriminator + bound caseId so the
				// consumer can dispatch to the case-store update arm. The
				// patch's `properties` object is structurally empty.
				const input = boundInput(
					[
						{
							id: "visit_name",
							kind: "text",
							caseWrite: { caseType: "visit", property: "case_name" },
						},
						{
							id: "visit_date",
							kind: "date",
							caseWrite: { caseType: "visit", property: "visit_date" },
						},
					],
					"followup",
				);
				const engine = new FormEngine(input, "patient");

				engine.setValue("/data/visit_name", "Second visit");
				engine.setValue("/data/visit_date", "2026-05-02");
				const mutation = engine.computeSubmissionMutation({
					caseId: "case-id-1",
					entryKey: ENTRY_KEY,
				});
				expect(mutation).toEqual({
					kind: "followup",
					formUuid: testUuid("test-form-uuid"),
					entryKey: ENTRY_KEY,
					attachmentRefs: [],
					caseId: "case-id-1",
					patch: { properties: {} },
					children: [
						{
							caseType: "visit",
							caseName: "Second visit",
							properties: { visit_date: "2026-05-02" },
							parentCaseId: "case-id-1",
						},
					],
				});
			});
		});

		describe("close", () => {
			it("emits a close-discriminated mutation with the patch + children", () => {
				const input = boundInput(
					[
						{
							id: "notes",
							kind: "text",
							caseWrite: { caseType: "patient", property: "notes" },
						},
						{
							id: "visit_name",
							kind: "text",
							caseWrite: { caseType: "visit", property: "case_name" },
						},
						{
							id: "discharge_date",
							kind: "date",
							caseWrite: { caseType: "visit", property: "discharge_date" },
						},
					],
					"close",
				);
				const engine = new FormEngine(input, "patient");

				engine.setValue("/data/notes", "discharged");
				engine.setValue("/data/visit_name", "Discharge visit");
				engine.setValue("/data/discharge_date", "2026-05-03");

				const mutation = engine.computeSubmissionMutation({
					caseId: "case-id-456",
					entryKey: ENTRY_KEY,
				});
				expect(mutation).toEqual({
					kind: "close",
					formUuid: testUuid("test-form-uuid"),
					entryKey: ENTRY_KEY,
					attachmentRefs: [],
					caseId: "case-id-456",
					patch: { properties: { notes: "discharged" } },
					children: [
						{
							caseType: "visit",
							caseName: "Discharge visit",
							properties: { discharge_date: "2026-05-03" },
							parentCaseId: "case-id-456",
						},
					],
				});
			});

			it("throws when no caseId is supplied", () => {
				const input = boundInput(
					[
						{
							id: "notes",
							kind: "text",
							caseWrite: { caseType: "patient", property: "notes" },
						},
					],
					"close",
				);
				const engine = new FormEngine(input, "patient");

				engine.setValue("/data/notes", "hello");
				expect(() =>
					engine.computeSubmissionMutation({
						entryKey: ENTRY_KEY,
					}),
				).toThrow(/form type `close` requires a bound `caseId`/);
			});

			it("emits empty primary properties for close-only forms", () => {
				// A close form whose only action is the closure stamp itself
				// carries no scalar property writes. The patch is structurally
				// empty; the consumer's close arm runs `caseStore.close` after
				// the (no-op) update lands.
				const input = boundInput([], "close");
				const engine = new FormEngine(input, "patient");

				const mutation = engine.computeSubmissionMutation({
					caseId: "case-id-1",
					entryKey: ENTRY_KEY,
				});
				expect(mutation).toEqual({
					kind: "close",
					formUuid: testUuid("test-form-uuid"),
					entryKey: ENTRY_KEY,
					attachmentRefs: [],
					caseId: "case-id-1",
					patch: { properties: {} },
					children: [],
				});
			});
		});

		describe("survey", () => {
			it("emits the survey marker without walking the tree", () => {
				const input = boundInput([{ id: "name", kind: "text" }], "survey");
				const engine = new FormEngine(input);

				engine.setValue("/data/name", "Alice");
				const mutation = engine.computeSubmissionMutation({
					entryKey: ENTRY_KEY,
				});
				expect(mutation).toEqual({
					kind: "survey",
					formUuid: testUuid("test-form-uuid"),
					entryKey: ENTRY_KEY,
					attachmentRefs: [],
				});
			});

			it("emits the survey marker even when caseId is provided", () => {
				const input = boundInput([{ id: "name", kind: "text" }], "survey");
				const engine = new FormEngine(input);

				const mutation = engine.computeSubmissionMutation({
					caseId: "case-id-1",
					entryKey: ENTRY_KEY,
				});
				expect(mutation).toEqual({
					kind: "survey",
					formUuid: testUuid("test-form-uuid"),
					entryKey: ENTRY_KEY,
					attachmentRefs: [],
				});
			});
		});

		describe("data_type coercion", () => {
			// Mirrors the `caseTypeToJsonSchema` mapping the case-store's
			// AJV validator runs against. A failed numeric parse falls
			// through as the raw string so AJV surfaces the type
			// mismatch rather than silently coercing to NaN / 0.
			it("coerces text to string", () => {
				const input = boundInput([
					{
						id: "case_name",
						kind: "text",
						caseWrite: { caseType: "patient", property: "case_name" },
					},
					{
						id: "notes",
						kind: "text",
						caseWrite: { caseType: "patient", property: "notes" },
					},
				]);
				const engine = new FormEngine(input, "patient");

				engine.setValue("/data/case_name", "Alice");
				engine.setValue("/data/notes", "hello");

				const mutation = engine.computeSubmissionMutation({
					entryKey: ENTRY_KEY,
				});
				expect(mutation.kind).toBe("registration");
				if (mutation.kind !== "registration") return;
				expect(mutation.primary.caseName).toBe("Alice");
				expect(mutation.primary.properties).toEqual({ notes: "hello" });
			});

			it("coerces int to integer", () => {
				const input = boundInput([
					{
						id: "case_name",
						kind: "text",
						caseWrite: { caseType: "patient", property: "case_name" },
					},
					{
						id: "age",
						kind: "int",
						caseWrite: { caseType: "patient", property: "age" },
					},
				]);
				const engine = new FormEngine(input, "patient");

				engine.setValue("/data/case_name", "Alice");
				engine.setValue("/data/age", "42");

				const mutation = engine.computeSubmissionMutation({
					entryKey: ENTRY_KEY,
				});
				expect(mutation.kind).toBe("registration");
				if (mutation.kind !== "registration") return;
				expect(mutation.primary.properties.age).toBe(42);
			});

			it("coerces decimal to number", () => {
				const input = boundInput([
					{
						id: "case_name",
						kind: "text",
						caseWrite: { caseType: "patient", property: "case_name" },
					},
					{
						id: "weight",
						kind: "decimal",
						caseWrite: { caseType: "patient", property: "weight" },
					},
				]);
				const engine = new FormEngine(input, "patient");

				engine.setValue("/data/case_name", "Alice");
				engine.setValue("/data/weight", "72.5");

				const mutation = engine.computeSubmissionMutation({
					entryKey: ENTRY_KEY,
				});
				expect(mutation.kind).toBe("registration");
				if (mutation.kind !== "registration") return;
				expect(mutation.primary.properties.weight).toBe(72.5);
			});

			it("coerces multi_select to a string array, splitting on whitespace", () => {
				const input = boundInput([
					{
						id: "case_name",
						kind: "text",
						caseWrite: { caseType: "patient", property: "case_name" },
					},
					{
						id: "tags",
						kind: "multi_select",
						caseWrite: { caseType: "patient", property: "tags" },
						optionsSource: inlineOptions("submission.tags", [
							["a", "A"],
							["b", "B"],
							["c", "C"],
						]),
					},
				]);
				const engine = new FormEngine(input, "patient");

				engine.setValue("/data/case_name", "Alice");
				engine.setValue("/data/tags", "a b c");

				const mutation = engine.computeSubmissionMutation({
					entryKey: ENTRY_KEY,
				});
				expect(mutation.kind).toBe("registration");
				if (mutation.kind !== "registration") return;
				expect(mutation.primary.properties.tags).toEqual(["a", "b", "c"]);
			});

			it("falls through unparseable int values as the raw string", () => {
				const input = boundInput([
					{
						id: "case_name",
						kind: "text",
						caseWrite: { caseType: "patient", property: "case_name" },
					},
					{
						id: "age",
						kind: "int",
						caseWrite: { caseType: "patient", property: "age" },
					},
				]);
				const engine = new FormEngine(input, "patient");

				engine.setValue("/data/case_name", "Alice");
				engine.setValue("/data/age", "not-a-number");

				const mutation = engine.computeSubmissionMutation({
					entryKey: ENTRY_KEY,
				});
				expect(mutation.kind).toBe("registration");
				if (mutation.kind !== "registration") return;
				expect(mutation.primary.properties.age).toBe("not-a-number");
			});

			// The string-shaped data types. `date`, `geopoint`, and
			// `single_select` return the raw value verbatim; `time` and
			// `datetime` are the two the coercion layer adapts, because the
			// strict RFC 3339 formats the row schema compiles demand an
			// offset that CommCare's own time answer does not carry (see
			// `lib/domain/temporalValues.ts`). These tests pin the per-type
			// contract so a change that unboxes one of them, or that quietly
			// reinterprets a wall clock as an instant, surfaces here.
			it("coerces date to its raw string", () => {
				const input = boundInput([
					{
						id: "case_name",
						kind: "text",
						caseWrite: { caseType: "patient", property: "case_name" },
					},
					{
						id: "dob",
						kind: "date",
						caseWrite: { caseType: "patient", property: "dob" },
					},
				]);
				const engine = new FormEngine(input, "patient");

				engine.setValue("/data/case_name", "Alice");
				engine.setValue("/data/dob", "1995-03-12");

				const mutation = engine.computeSubmissionMutation({
					entryKey: ENTRY_KEY,
				});
				expect(mutation.kind).toBe("registration");
				if (mutation.kind !== "registration") return;
				expect(mutation.primary.properties.dob).toBe("1995-03-12");
			});

			it("keeps a datetime's own offset and pads it to the wire's precision", () => {
				const input = boundInput([
					{
						id: "case_name",
						kind: "text",
						caseWrite: { caseType: "patient", property: "case_name" },
					},
					{
						id: "last_seen",
						kind: "datetime",
						caseWrite: { caseType: "patient", property: "last_seen" },
					},
				]);
				const engine = new FormEngine(input, "patient");

				engine.setValue("/data/case_name", "Alice");
				engine.setValue("/data/last_seen", "2026-05-06T12:34:56Z");

				const mutation = engine.computeSubmissionMutation({
					entryKey: ENTRY_KEY,
					viewerTimeZone: "America/New_York",
				});
				expect(mutation.kind).toBe("registration");
				if (mutation.kind !== "registration") return;
				// The value already carried a zone, so the viewer's is NOT
				// imposed on it — only the fractional digits `DateTimeData`
				// always writes are filled in.
				expect(mutation.primary.properties.last_seen).toBe(
					"2026-05-06T12:34:56.000Z",
				);
			});

			it("stamps a naive datetime with the viewer's offset, as the device would", () => {
				const input = boundInput([
					{
						id: "case_name",
						kind: "text",
						caseWrite: { caseType: "patient", property: "case_name" },
					},
					{
						id: "last_seen",
						kind: "datetime",
						caseWrite: { caseType: "patient", property: "last_seen" },
					},
				]);
				const engine = new FormEngine(input, "patient");

				engine.setValue("/data/case_name", "Alice");
				engine.setValue("/data/last_seen", "2026-05-06T12:34:56");

				const mutation = engine.computeSubmissionMutation({
					entryKey: ENTRY_KEY,
					viewerTimeZone: "America/New_York",
				});
				expect(mutation.kind).toBe("registration");
				if (mutation.kind !== "registration") return;
				// `DateTimeData::uncast` writes the wall clock plus the zone
				// the answer was entered in; Preview's author browser stands
				// in for the device, so the same gesture means the same
				// instant. Stamping `Z` here would move it four hours.
				expect(mutation.primary.properties.last_seen).toBe(
					"2026-05-06T12:34:56.000-04:00",
				);
			});

			it("tags a time for storage without claiming it is an instant", () => {
				const input = boundInput([
					{
						id: "case_name",
						kind: "text",
						caseWrite: { caseType: "patient", property: "case_name" },
					},
					{
						id: "wake_time",
						kind: "time",
						caseWrite: { caseType: "patient", property: "wake_time" },
					},
				]);
				const engine = new FormEngine(input, "patient");

				engine.setValue("/data/case_name", "Alice");
				engine.setValue("/data/wake_time", "07:30:00");

				const mutation = engine.computeSubmissionMutation({
					entryKey: ENTRY_KEY,
					viewerTimeZone: "America/New_York",
				});
				expect(mutation.kind).toBe("registration");
				if (mutation.kind !== "registration") return;
				// A time answer is a wall clock with no zone of its own
				// (`TimeData::uncast` suppresses the offset), so the viewer's
				// zone is deliberately NOT applied — the `Z` is only the tag
				// the strict `format: "time"` schema requires.
				expect(mutation.primary.properties.wake_time).toBe("07:30:00.000Z");
			});

			it("coerces geopoint to its raw string", () => {
				// Geopoint wire shape is the canonical CommCare
				// `"lat lon alt acc"` string; the coercion layer never
				// parses it. PostGIS conversion happens at the case-list
				// query layer (`within-distance`), not at write time.
				const input = boundInput([
					{
						id: "case_name",
						kind: "text",
						caseWrite: { caseType: "patient", property: "case_name" },
					},
					{
						id: "home_location",
						kind: "geopoint",
						caseWrite: { caseType: "patient", property: "home_location" },
					},
				]);
				const engine = new FormEngine(input, "patient");

				engine.setValue("/data/case_name", "Alice");
				engine.setValue("/data/home_location", "37.7749 -122.4194 0 5");

				const mutation = engine.computeSubmissionMutation({
					entryKey: ENTRY_KEY,
				});
				expect(mutation.kind).toBe("registration");
				if (mutation.kind !== "registration") return;
				expect(mutation.primary.properties.home_location).toBe(
					"37.7749 -122.4194 0 5",
				);
			});

			it("coerces single_select to its raw string", () => {
				const input = boundInput([
					{
						id: "case_name",
						kind: "text",
						caseWrite: { caseType: "patient", property: "case_name" },
					},
					{
						id: "priority",
						kind: "single_select",
						caseWrite: { caseType: "patient", property: "priority" },
						optionsSource: inlineOptions("submission.priority", [
							["low", "Low"],
							["high", "High"],
						]),
					},
				]);
				const engine = new FormEngine(input, "patient");

				engine.setValue("/data/case_name", "Alice");
				engine.setValue("/data/priority", "high");

				const mutation = engine.computeSubmissionMutation({
					entryKey: ENTRY_KEY,
				});
				expect(mutation.kind).toBe("registration");
				if (mutation.kind !== "registration") return;
				expect(mutation.primary.properties.priority).toBe("high");
			});
		});

		describe("empty-value filtering", () => {
			// The walker's contract: filter on emptiness only. Missing
			// paths and `""` reads both drop. `state.visible` is NOT
			// consulted — hidden fields with non-empty values land in
			// the mutation.
			it("excludes empty fields from the mutation", () => {
				const input = boundInput([
					{
						id: "case_name",
						kind: "text",
						caseWrite: { caseType: "patient", property: "case_name" },
					},
					{
						id: "notes",
						kind: "text",
						caseWrite: { caseType: "patient", property: "notes" },
					},
				]);
				const engine = new FormEngine(input, "patient");

				engine.setValue("/data/case_name", "Alice");
				// `notes` left empty.

				const mutation = engine.computeSubmissionMutation({
					entryKey: ENTRY_KEY,
				});
				expect(mutation.kind).toBe("registration");
				if (mutation.kind !== "registration") return;
				expect(mutation.primary.caseName).toBe("Alice");
				expect(mutation.primary.properties).toEqual({});
				expect("notes" in mutation.primary.properties).toBe(false);
			});

			it("includes hidden fields with non-empty values (visibility is NOT consulted)", () => {
				const input = boundInput([
					{
						id: "show",
						kind: "single_select",
						optionsSource: inlineOptions("submission.visibility", [
							["yes", "Yes"],
							["no", "No"],
						]),
					},
					{
						id: "case_name",
						kind: "text",
						caseWrite: { caseType: "patient", property: "case_name" },
					},
					{
						id: "notes",
						kind: "text",
						caseWrite: { caseType: "patient", property: "notes" },
						relevant: xp('/data/show = "yes"'),
					},
				]);
				const engine = new FormEngine(input, "patient");

				engine.setValue("/data/case_name", "Alice");
				engine.setValue("/data/show", "yes");
				engine.setValue("/data/notes", "secret note");
				// Toggle visibility off — the value stays.
				engine.setValue("/data/show", "no");
				expect(engine.getState("/data/notes").visible).toBe(false);

				const mutation = engine.computeSubmissionMutation({
					entryKey: ENTRY_KEY,
				});
				expect(mutation.kind).toBe("registration");
				if (mutation.kind !== "registration") return;
				// `notes` is hidden but the value is non-empty — it lands.
				expect(mutation.primary.properties.notes).toBe("secret note");
			});

			it("rejects a child case whose active case_name writer is blank", () => {
				const input = boundInput([
					{
						id: "case_name",
						kind: "text",
						caseWrite: { caseType: "patient", property: "case_name" },
					},
					{
						id: "visit_name",
						kind: "text",
						caseWrite: { caseType: "visit", property: "case_name" },
					},
					{
						id: "first_visit_date",
						kind: "date",
						caseWrite: { caseType: "visit", property: "first_visit_date" },
					},
				]);
				const engine = new FormEngine(input, "patient");

				engine.setValue("/data/case_name", "Alice");
				// Both child fields remain active and blank. A create bucket with an
				// active blank name is invalid atomically, never a silent no-op.
				expect(() =>
					engine.computeSubmissionMutation({
						entryKey: ENTRY_KEY,
					}),
				).toThrow(/cannot write case_name: the value is blank/);
			});
		});
	});

	// `FieldState.repeatCount` is the load-bearing signal for repeat
	// sizing — `computeSubmissionMutation` reads instance counts off the
	// `DataInstance` directly via `getRepeatCount`, but the rendered UI
	// reads off the FieldState. This invariant pins the two readings in
	// sync so a future repeat-mutating path (case-data preload that
	// seeds N instances, replay, etc.) can't silently drift one without
	// the other and produce wrong child-case counts.
	describe("repeat-count invariant", () => {
		it("materializes a count-bound repeat once during initialization", () => {
			const input = dTree([
				{
					id: "members",
					kind: "repeat",
					repeat_mode: "count_bound",
					repeat_count: xp("3"),
					children: [{ id: "name", kind: "text" }],
				},
			]);
			const engine = new FormEngine(input);

			expect(engine.getRepeatCount("/data/members")).toBe(3);
			expect(engine.getState("/data/members").repeatCount).toBe(3);
			expect(engine.getState("/data/members[2]/name").path).toBe(
				"/data/members[2]/name",
			);
		});

		it.each(["2.0", "2.5"])(
			"rejects direct repeat-count path value %s through IntegerData lexical casting",
			(lexical) => {
				const input = dTree(
					[
						{
							id: "desired_count",
							kind: "text",
							caseWrite: {
								caseType: "patient",
								property: "desired_count",
							},
						},
						{
							id: "members",
							kind: "repeat",
							repeat_mode: "count_bound",
							repeat_count: formXp("#form/desired_count"),
							children: [],
						},
					],
					"followup",
					[
						{
							name: "patient",
							properties: [
								{
									name: "desired_count",
									label: proseText("Desired count"),
								},
							],
						},
					],
				);

				expect(
					() =>
						new FormEngine(
							input,
							"patient",
							caseDataFor("patient", [["desired_count", lexical]]),
						),
				).toThrow(/exact base-10 integer/);
			},
		);

		it("accepts Java BMP decimal digits in a direct repeat count", async () => {
			const input = dTree(
				[
					{
						id: "desired_count",
						kind: "text",
						caseWrite: {
							caseType: "patient",
							property: "desired_count",
						},
					},
					{
						id: "members",
						kind: "repeat",
						repeat_mode: "count_bound",
						repeat_count: formXp("#form/desired_count"),
						children: [],
					},
				],
				"followup",
				[
					{
						name: "patient",
						properties: [
							{
								name: "desired_count",
								label: proseText("Desired count"),
							},
						],
					},
				],
			);
			const caseData = caseDataFor("patient", [["desired_count", "٣"]]);
			const syncEngine = new FormEngine(input, "patient", caseData);
			expect(syncEngine.getRepeatCount("/data/members")).toBe(3);

			const asyncEngine = new FormEngine(
				input,
				"patient",
				caseData,
				undefined,
				undefined,
				undefined,
				{ stagedAsync: true },
			);
			const { evaluateAsync, runtime } = fixedWorldEvaluator(
				asyncEngine,
				"unicode-direct-repeat-count",
			);
			try {
				await asyncEngine.initializeAsync(evaluateAsync);
				expect(asyncEngine.getRepeatCount("/data/members")).toBe(3);
			} finally {
				runtime.dispose();
			}
		});

		it("applies the same direct repeat-count lexical cast across the worker boundary", async () => {
			const input = dTree(
				[
					{
						id: "desired_count",
						kind: "text",
						caseWrite: {
							caseType: "patient",
							property: "desired_count",
						},
					},
					{
						id: "members",
						kind: "repeat",
						repeat_mode: "count_bound",
						repeat_count: formXp("#form/desired_count"),
						children: [],
					},
				],
				"followup",
				[
					{
						name: "patient",
						properties: [
							{
								name: "desired_count",
								label: proseText("Desired count"),
							},
						],
					},
				],
			);
			const engine = new FormEngine(
				input,
				"patient",
				caseDataFor("patient", [["desired_count", "2.5"]]),
				undefined,
				undefined,
				undefined,
				{ stagedAsync: true },
			);
			const { evaluateAsync, runtime } = fixedWorldEvaluator(
				engine,
				"direct-repeat-count-cast",
			);

			try {
				await expect(engine.initializeAsync(evaluateAsync)).rejects.toThrow(
					/exact base-10 integer/,
				);
			} finally {
				runtime.dispose();
			}
		});

		it("retains xsd:int coercion for a hoisted non-path repeat count", async () => {
			const input = dTree([
				{
					id: "members",
					kind: "repeat",
					repeat_mode: "count_bound",
					repeat_count: xp("2.5"),
					children: [],
				},
			]);
			const syncEngine = new FormEngine(input);
			expect(syncEngine.getRepeatCount("/data/members")).toBe(2);

			const asyncEngine = new FormEngine(
				input,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				{ stagedAsync: true },
			);
			const { evaluateAsync, runtime } = fixedWorldEvaluator(
				asyncEngine,
				"hoisted-repeat-count-cast",
			);

			try {
				await asyncEngine.initializeAsync(evaluateAsync);
				expect(asyncEngine.getRepeatCount("/data/members")).toBe(2);
			} finally {
				runtime.dispose();
			}
		});

		it.each([
			["number('')", 0],
			["true()", 1],
			["false()", 0],
			["'٣'", 3],
		] as const)(
			"matches SetValueAction xsd:int coercion for hoisted %s",
			async (source, expected) => {
				const input = dTree([
					{
						id: "members",
						kind: "repeat",
						repeat_mode: "count_bound",
						repeat_count: xp(source),
						children: [],
					},
				]);
				const syncEngine = new FormEngine(input);
				expect(syncEngine.getRepeatCount("/data/members")).toBe(expected);

				const asyncEngine = new FormEngine(
					input,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					{ stagedAsync: true },
				);
				const { evaluateAsync, runtime } = fixedWorldEvaluator(
					asyncEngine,
					`hoisted-repeat-count-${expected}`,
				);
				try {
					await asyncEngine.initializeAsync(evaluateAsync);
					expect(asyncEngine.getRepeatCount("/data/members")).toBe(expected);
				} finally {
					runtime.dispose();
				}
			},
		);

		it("rejects a non-integer string stored through a hoisted xsd:int node", async () => {
			const input = dTree([
				{
					id: "members",
					kind: "repeat",
					repeat_mode: "count_bound",
					repeat_count: xp("'2.5'"),
					children: [],
				},
			]);
			expect(() => new FormEngine(input)).toThrow(/exact base-10 integer/);

			const asyncEngine = new FormEngine(
				input,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				{ stagedAsync: true },
			);
			const { evaluateAsync, runtime } = fixedWorldEvaluator(
				asyncEngine,
				"hoisted-repeat-count-string-rejection",
			);
			try {
				await expect(
					asyncEngine.initializeAsync(evaluateAsync),
				).rejects.toThrow(/exact base-10 integer/);
			} finally {
				runtime.dispose();
			}
		});

		it("uses DataUtil space splitting for scalar query-bound repeat ids", async () => {
			const input = dTree([
				{
					id: "leading",
					kind: "repeat",
					repeat_mode: "query_bound",
					data_source: { ids_query: xp("' alpha'") },
					children: [],
				},
				{
					id: "tabbed",
					kind: "repeat",
					repeat_mode: "query_bound",
					data_source: { ids_query: xp("'alpha\tbeta'") },
					children: [],
				},
			]);
			const syncEngine = new FormEngine(input);
			expect(syncEngine.getRepeatCount("/data/leading")).toBe(2);
			expect(syncEngine.getRepeatCount("/data/tabbed")).toBe(1);

			const asyncEngine = new FormEngine(
				input,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				{ stagedAsync: true },
			);
			const runtime = new XPathRuntime({
				workerFactory: createInProcessXPathWorkerFactory(),
			});
			const world = asyncEngine.createWorkerWorld("scalar-query-bound-ids");
			const evaluateAsync = (async (
				source: string,
				path: string,
				resultMode: "scalar" | "nodeset-values-or-scalar" = "scalar",
				stateOverrides?: Parameters<FormEngineAsyncEvaluator>[3],
			) => {
				const result = await runtime.request({
					entryKey: ENTRY_KEY,
					revision: 0,
					profile: "form",
					source,
					resultMode,
					instances: asyncEngine.workerInstances(
						source,
						path,
						world,
						stateOverrides,
					),
				});
				if (!result.ok) throw new Error(result.error.code);
				if (result.nodesetValues !== undefined) {
					return {
						kind: "nodeset-values" as const,
						values: result.nodesetValues,
					};
				}
				return deserializeXPathWorkerValue(result.value);
			}) as FormEngineAsyncEvaluator;

			await asyncEngine.initializeAsync(evaluateAsync);
			expect(asyncEngine.getRepeatCount("/data/leading")).toBe(2);
			expect(asyncEngine.getRepeatCount("/data/tabbed")).toBe(1);
			runtime.dispose();
		});

		it("reinitializes the worker world when a bound repeat materializes zero rows", async () => {
			const engine = new FormEngine(
				dTree([
					{
						id: "members",
						kind: "repeat",
						repeat_mode: "count_bound",
						repeat_count: xp("0"),
						children: [{ id: "name", kind: "text" }],
					},
					{
						id: "observed_count",
						kind: "text",
						default_value: xp("count(/data/members)"),
					},
				]),
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				{ stagedAsync: true },
			);
			const runtime = new XPathRuntime({
				workerFactory: createInProcessXPathWorkerFactory(),
			});
			const world = engine.createWorkerWorld("zero-bound-repeat");
			const evaluateAsync = (async (
				source: string,
				path: string,
				resultMode: "scalar" | "nodeset-values-or-scalar" = "scalar",
				stateOverrides?: Parameters<FormEngineAsyncEvaluator>[3],
			) => {
				const result = await runtime.request({
					entryKey: ENTRY_KEY,
					revision: 0,
					profile: "form",
					source,
					resultMode,
					instances: engine.workerInstances(
						source,
						path,
						world,
						stateOverrides,
					),
				});
				if (!result.ok) throw new Error(result.error.code);
				if (result.nodesetValues !== undefined) {
					return {
						kind: "nodeset-values" as const,
						values: result.nodesetValues,
					};
				}
				return deserializeXPathWorkerValue(result.value);
			}) as FormEngineAsyncEvaluator;

			await engine.initializeAsync(evaluateAsync);

			expect(engine.getRepeatCount("/data/members")).toBe(0);
			expect(engine.getState("/data/observed_count").value).toBe("0");
			runtime.dispose();
		});

		it("materializes a query-bound repeat from the device-scoped casedb nodeset", () => {
			const input = dTree([
				{
					id: "patients",
					kind: "repeat",
					repeat_mode: "query_bound",
					data_source: {
						ids_query: xp(
							"instance('casedb')/casedb/case[@case_type='patient']/@case_id",
						),
					},
					children: [
						{ id: "note", kind: "text" },
						{
							id: "selected_id",
							kind: "hidden",
							calculate: xp("current()/../@id"),
						},
						{
							id: "selected_index",
							kind: "hidden",
							calculate: xp("current()/../@index"),
						},
					],
				},
			]);
			const caseRow = (caseId: string) => ({
				case_id: caseId,
				app_id: "app-1",
				case_type: "patient",
				owner_id: "worker-1",
				status: "open",
				opened_on: null,
				modified_on: null,
				closed_on: null,
				case_name: caseId,
				external_id: null,
				parent_case_id: null,
				properties: {},
			});
			const engine = new FormEngine(input, undefined, undefined, null, null, {
				rows: [caseRow("patient-1"), caseRow("patient-2")],
				indices: [],
			});

			expect(engine.getRepeatCount("/data/patients")).toBe(2);
			expect(engine.getState("/data/patients").repeatCount).toBe(2);
			expect(engine.getState("/data/patients[1]/note").path).toBe(
				"/data/patients[1]/note",
			);
			expect(engine.getState("/data/patients[0]/selected_id").value).toBe(
				"patient-1",
			);
			expect(engine.getState("/data/patients[1]/selected_id").value).toBe(
				"patient-2",
			);
			expect(engine.getState("/data/patients[0]/selected_index").value).toBe(
				"0",
			);
			expect(engine.getState("/data/patients[1]/selected_index").value).toBe(
				"1",
			);
		});

		it("preserves query-bound ids through the async worker boundary", async () => {
			const input = dTree([
				{
					id: "patients",
					kind: "repeat",
					repeat_mode: "query_bound",
					data_source: {
						ids_query: xp(
							"instance('casedb')/casedb/case[@case_type='patient']/@case_id",
						),
					},
					children: [
						{
							id: "selected_id",
							kind: "hidden",
							calculate: xp("current()/../@id"),
						},
					],
				},
			]);
			const engine = new FormEngine(
				input,
				undefined,
				undefined,
				null,
				null,
				{
					rows: [
						{
							case_id: "patient-1",
							app_id: "app-1",
							case_type: "patient",
							owner_id: "worker-1",
							status: "open",
							opened_on: null,
							modified_on: null,
							closed_on: null,
							case_name: "Patient",
							external_id: null,
							parent_case_id: null,
							properties: {},
						},
					],
					indices: [],
				},
				{ stagedAsync: true },
			);
			const runtime = new XPathRuntime({
				workerFactory: createInProcessXPathWorkerFactory(),
			});
			const world = engine.createWorkerWorld("query-bound-ids");
			const evaluateAsync = (async (
				source: string,
				path: string,
				resultMode: "scalar" | "nodeset-values-or-scalar" = "scalar",
				stateOverrides?: Parameters<FormEngineAsyncEvaluator>[3],
			) => {
				const result = await runtime.request({
					entryKey: ENTRY_KEY,
					revision: 0,
					profile: "form",
					source,
					resultMode,
					instances: engine.workerInstances(
						source,
						path,
						world,
						stateOverrides,
					),
				});
				if (!result.ok) throw new Error(result.error.code);
				if (result.nodesetValues !== undefined) {
					return {
						kind: "nodeset-values" as const,
						values: result.nodesetValues,
					};
				}
				return deserializeXPathWorkerValue(result.value);
			}) as FormEngineAsyncEvaluator;

			await engine.initializeAsync(evaluateAsync);

			expect(engine.getState("/data/patients[0]/selected_id").value).toBe(
				"patient-1",
			);
			runtime.dispose();
		});

		it("matches FieldState.repeatCount with DataInstance.getRepeatCount on init", () => {
			const input = dTree([
				{
					id: "members",
					kind: "repeat",
					children: [{ id: "name", kind: "text" }],
				},
			]);
			const engine = new FormEngine(input);

			expect(engine.getState("/data/members").repeatCount).toBe(
				engine.getRepeatCount("/data/members"),
			);
		});

		it("matches after addRepeat", () => {
			const input = dTree([
				{
					id: "members",
					kind: "repeat",
					children: [{ id: "name", kind: "text" }],
				},
			]);
			const engine = new FormEngine(input);

			engine.addRepeat("/data/members");
			expect(engine.getState("/data/members").repeatCount).toBe(
				engine.getRepeatCount("/data/members"),
			);
		});

		it("matches after removeRepeat", () => {
			const input = dTree([
				{
					id: "members",
					kind: "repeat",
					children: [{ id: "name", kind: "text" }],
				},
			]);
			const engine = new FormEngine(input);

			engine.addRepeat("/data/members");
			engine.addRepeat("/data/members");
			engine.removeRepeat("/data/members", 0);
			expect(engine.getState("/data/members").repeatCount).toBe(
				engine.getRepeatCount("/data/members"),
			);
		});

		it("matches after setValue (a leaf write should not touch repeat count)", () => {
			const input = dTree([
				{
					id: "members",
					kind: "repeat",
					children: [{ id: "name", kind: "text" }],
				},
			]);
			const engine = new FormEngine(input);

			engine.addRepeat("/data/members");
			engine.setValue("/data/members[1]/name", "Bob");
			expect(engine.getState("/data/members").repeatCount).toBe(
				engine.getRepeatCount("/data/members"),
			);
		});

		it("matches after reset", () => {
			const input = dTree([
				{
					id: "members",
					kind: "repeat",
					children: [{ id: "name", kind: "text" }],
				},
			]);
			const engine = new FormEngine(input);

			engine.addRepeat("/data/members");
			engine.addRepeat("/data/members");
			engine.reset();
			expect(engine.getState("/data/members").repeatCount).toBe(
				engine.getRepeatCount("/data/members"),
			);
		});
	});

	describe("repeat-instance references", () => {
		// The prod-incident shape: a hidden case_name inside a repeat
		// calculates from a typed sibling, and both fields author a child
		// case. The typed value must reach the child case's name.
		const ordersFixture = (): FormEngineInput =>
			dTree(
				[
					{
						id: "patient_name",
						kind: "hidden",
						default_value: xp("'Patient'"),
						caseWrite: { caseType: "patient", property: "case_name" },
					},
					{
						id: "orders",
						kind: "repeat",
						label: proseText("Orders"),
						children: [
							{
								id: "medication_name",
								kind: "text",
								label: proseText("Medication"),
								caseWrite: {
									caseType: "medication_order",
									property: "medication_name",
								},
							},
							{
								id: "case_name",
								kind: "hidden",
								calculate: formXp(
									"coalesce(#form/orders/medication_name, 'Medication order')",
								),
								caseWrite: {
									caseType: "medication_order",
									property: "case_name",
								},
							},
						],
					},
				],
				"registration",
				[
					{
						name: "patient",
						properties: [
							{ name: "case_name", label: proseText("Patient name") },
						],
					},
					{
						name: "medication_order",
						parent_type: "patient",
						properties: [
							{ name: "case_name", label: proseText("Medication") },
							{ name: "medication_name", label: proseText("Medication") },
						],
					},
				],
			);

		it("a calculate inside a repeat reads its typed sibling", () => {
			const engine = new FormEngine(ordersFixture(), "patient");

			// Fallback arm computes at init…
			expect(engine.getState("/data/orders[0]/case_name").value).toBe(
				"Medication order",
			);

			// …and the typed value re-fires the calc in the same instance.
			engine.setValue("/data/orders[0]/medication_name", "Hydrangea");
			expect(engine.getState("/data/orders[0]/case_name").value).toBe(
				"Hydrangea",
			);
		});

		it("the typed value reaches the child case's name at submit", () => {
			const engine = new FormEngine(ordersFixture(), "patient");
			engine.setValue("/data/orders[0]/medication_name", "Hydrangea");

			const mutation = engine.computeSubmissionMutation({
				entryKey: ENTRY_KEY,
			});
			expect(mutation).toMatchObject({
				kind: "registration",
				children: [{ caseType: "medication_order", caseName: "Hydrangea" }],
			});
		});

		it("each instance's calc evaluates against its own values", () => {
			const engine = new FormEngine(ordersFixture(), "patient");
			engine.setValue("/data/orders[0]/medication_name", "Hydrangea");
			engine.addRepeat("/data/orders");
			engine.setValue("/data/orders[1]/medication_name", "Aspirin");

			expect(engine.getState("/data/orders[0]/case_name").value).toBe(
				"Hydrangea",
			);
			expect(engine.getState("/data/orders[1]/case_name").value).toBe(
				"Aspirin",
			);

			const mutation = engine.computeSubmissionMutation({
				entryKey: ENTRY_KEY,
			});
			expect(mutation).toMatchObject({
				kind: "registration",
				children: [
					{ caseType: "medication_order", caseName: "Hydrangea" },
					{ caseType: "medication_order", caseName: "Aspirin" },
				],
			});
		});

		it("a new instance's calc evaluates immediately on addRepeat", () => {
			const engine = new FormEngine(ordersFixture(), "patient");
			engine.addRepeat("/data/orders");

			expect(engine.getState("/data/orders[1]/case_name").value).toBe(
				"Medication order",
			);
		});

		it("relevance inside a repeat toggles per instance", () => {
			const input = dTree([
				{
					id: "orders",
					kind: "repeat",
					children: [
						{ id: "flag", kind: "text", label: proseText("Flag") },
						{
							id: "details",
							kind: "text",
							label: proseText("Details"),
							relevant: formXp("#form/orders/flag = 'yes'"),
						},
					],
				},
			]);
			const engine = new FormEngine(input);
			engine.addRepeat("/data/orders");

			engine.setValue("/data/orders[1]/flag", "yes");
			expect(engine.getState("/data/orders[0]/details").visible).toBe(false);
			expect(engine.getState("/data/orders[1]/details").visible).toBe(true);
		});

		it("validation inside a repeat judges per instance", () => {
			const input = dTree([
				{
					id: "orders",
					kind: "repeat",
					children: [
						{
							id: "qty",
							kind: "text",
							label: proseText("Qty"),
							validate: xp(". != 'bad'"),
							validate_msg: proseText("No bad values"),
						},
					],
				},
			]);
			const engine = new FormEngine(input);
			engine.addRepeat("/data/orders");

			engine.setValue("/data/orders[0]/qty", "good");
			engine.setValue("/data/orders[1]/qty", "bad");
			expect(engine.getState("/data/orders[0]/qty").valid).toBe(true);
			expect(engine.getState("/data/orders[1]/qty").valid).toBe(false);
		});

		it("bare-hashtag labels resolve per instance", () => {
			const input = dTree([
				{
					id: "orders",
					kind: "repeat",
					children: [
						{
							id: "medication_name",
							kind: "text",
							label: proseText("Medication"),
						},
						{
							id: "confirm",
							kind: "text",
							label: prose(
								{ kind: "text", text: "Confirm " },
								{
									kind: "field-ref",
									uuid: testUuid("form.orders.medication_name"),
								},
							),
						},
					],
				},
			]);
			const engine = new FormEngine(input);
			engine.addRepeat("/data/orders");
			engine.setValue("/data/orders[0]/medication_name", "Hydrangea");
			engine.setValue("/data/orders[1]/medication_name", "Aspirin");

			expect(engine.getState("/data/orders[0]/confirm").resolvedLabel).toBe(
				"Confirm Hydrangea",
			);
			expect(engine.getState("/data/orders[1]/confirm").resolvedLabel).toBe(
				"Confirm Aspirin",
			);
		});

		it("a reference to a field outside the repeat fans out to every instance", () => {
			const input = dTree([
				{ id: "prefix", kind: "text", label: proseText("Prefix") },
				{
					id: "orders",
					kind: "repeat",
					children: [
						{
							id: "tag",
							kind: "hidden",
							calculate: formXp("concat(#form/prefix, '-', position())"),
						},
					],
				},
			]);
			const engine = new FormEngine(input);
			engine.addRepeat("/data/orders");

			engine.setValue("/data/prefix", "RX");
			expect(engine.getState("/data/orders[0]/tag").value).toBe("RX-0");
			expect(engine.getState("/data/orders[1]/tag").value).toBe("RX-0");
		});

		it("position() on calculated repeat children stays at final-node zero", () => {
			const input = dTree([
				{
					id: "orders",
					kind: "repeat",
					children: [
						{ id: "idx", kind: "hidden", calculate: xp("position()") },
					],
				},
			]);
			const engine = new FormEngine(input);
			engine.addRepeat("/data/orders");
			engine.addRepeat("/data/orders");
			expect(engine.getState("/data/orders[2]/idx").value).toBe("0");

			engine.removeRepeat("/data/orders", 0);
			expect(engine.getState("/data/orders[0]/idx").value).toBe("0");
			expect(engine.getState("/data/orders[1]/idx").value).toBe("0");
		});

		it("default_value applies to a new instance against its own context", () => {
			const input = dTree([
				{
					id: "orders",
					kind: "repeat",
					children: [
						{
							id: "stamp",
							kind: "text",
							label: proseText("Stamp"),
							default_value: xp("concat('entry-', position())"),
						},
					],
				},
			]);
			const engine = new FormEngine(input);
			expect(engine.getState("/data/orders[0]/stamp").value).toBe("entry-0");

			engine.addRepeat("/data/orders");
			expect(engine.getState("/data/orders[1]/stamp").value).toBe("entry-0");
		});

		it("group visibility inside a repeat is per-instance", () => {
			const input = dTree([
				{
					id: "orders",
					kind: "repeat",
					children: [
						{ id: "flag", kind: "text", label: proseText("Flag") },
						{
							id: "extras",
							kind: "group",
							label: proseText("Extras"),
							relevant: formXp("#form/orders/flag = 'yes'"),
							children: [
								{ id: "note", kind: "text", label: proseText("Note") },
							],
						},
					],
				},
			]);
			const engine = new FormEngine(input);
			engine.addRepeat("/data/orders");
			engine.setValue("/data/orders[1]/flag", "yes");

			expect(engine.getState("/data/orders[0]/extras").visible).toBe(false);
			expect(engine.getState("/data/orders[1]/extras").visible).toBe(true);
		});

		it("a repeat with no leaf descendants still lives — expressions evaluate and Add works", () => {
			// Instance counts are tracked explicitly, never derived from which
			// value keys exist — a repeat whose children are all structural
			// (a common mid-authoring state) must not report zero instances.
			const input = dTree([
				{ id: "show", kind: "text", label: proseText("Show?") },
				{
					id: "section",
					kind: "repeat",
					children: [
						{
							id: "grp",
							kind: "group",
							label: proseText("Extras"),
							relevant: formXp("#form/show = 'yes'"),
							children: [],
						},
					],
				},
			]);
			const engine = new FormEngine(input);

			expect(engine.getRepeatCount("/data/section")).toBe(1);
			expect(engine.getState("/data/section").repeatCount).toBe(1);
			expect(engine.getState("/data/section[0]/grp").visible).toBe(false);

			engine.setValue("/data/show", "yes");
			expect(engine.getState("/data/section[0]/grp").visible).toBe(true);

			expect(engine.addRepeat("/data/section")).toBe(1);
			expect(engine.getRepeatCount("/data/section")).toBe(2);
			expect(engine.getState("/data/section[1]/grp").visible).toBe(true);
		});

		it("a new outer instance seeds the authored template shape, not [0]'s live shape", () => {
			const input = dTree([
				{
					id: "households",
					kind: "repeat",
					children: [
						{
							id: "members",
							kind: "repeat",
							children: [
								{ id: "first", kind: "text", label: proseText("First") },
							],
						},
					],
				},
			]);
			const engine = new FormEngine(input);
			engine.addRepeat("/data/households[0]/members");
			engine.addRepeat("/data/households[0]/members");
			expect(engine.getRepeatCount("/data/households[0]/members")).toBe(3);

			engine.addRepeat("/data/households");
			expect(engine.getRepeatCount("/data/households[1]/members")).toBe(1);
			expect(engine.getState("/data/households[1]/members").repeatCount).toBe(
				1,
			);
			// The grown instance keeps its own shape.
			expect(engine.getRepeatCount("/data/households[0]/members")).toBe(3);
		});

		it("position() on repeat children uses the final node multiplicity", () => {
			const input = dTree([
				{
					id: "orders",
					kind: "repeat",
					children: [
						{
							id: "final_note",
							kind: "text",
							label: proseText("Note"),
							relevant: xp("position() = 0"),
						},
					],
				},
			]);
			const engine = new FormEngine(input);
			expect(engine.getState("/data/orders[0]/final_note").visible).toBe(true);

			engine.addRepeat("/data/orders");
			expect(engine.getState("/data/orders[1]/final_note").visible).toBe(true);
			engine.addRepeat("/data/orders");
			expect(engine.getState("/data/orders[2]/final_note").visible).toBe(true);

			engine.removeRepeat("/data/orders", 0);
			expect(engine.getState("/data/orders[0]/final_note").visible).toBe(true);
			expect(engine.getState("/data/orders[1]/final_note").visible).toBe(true);
		});

		it("reevaluateDefault leaves a touched field's answer in the submission", () => {
			const input = dTree(
				[
					{
						id: "case_name",
						kind: "hidden",
						default_value: xp("'Patient'"),
						caseWrite: { caseType: "patient", property: "case_name" },
					},
					{
						id: "note",
						kind: "text",
						label: proseText("Note"),
						default_value: xp("'draft'"),
						caseWrite: { caseType: "patient", property: "note" },
					},
				],
				"registration",
				[
					{
						name: "patient",
						properties: [
							{ name: "case_name", label: proseText("Name") },
							{ name: "note", label: proseText("Note") },
						],
					},
				],
			);
			const engine = new FormEngine(input, "patient");
			engine.setValue("/data/note", "Alice's note");
			engine.touch("/data/note");

			const field = Object.values(input.fields).find((f) => f.id === "note");
			if (!field) throw new Error("fixture field missing");
			engine.reevaluateDefault("/data/note", field);

			expect(engine.getState("/data/note").value).toBe("Alice's note");
			const mutation = engine.computeSubmissionMutation({
				entryKey: ENTRY_KEY,
			});
			expect(mutation).toMatchObject({
				kind: "registration",
				primary: { properties: { note: "Alice's note" } },
			});
		});

		it("renamePaths moves every live instance's value and state", () => {
			const input = dTree([
				{
					id: "orders",
					kind: "repeat",
					children: [{ id: "name", kind: "text", label: proseText("Name") }],
				},
			]);
			const engine = new FormEngine(input);
			engine.addRepeat("/data/orders");
			engine.setValue("/data/orders[0]/name", "Hydrangea");
			engine.setValue("/data/orders[1]/name", "Aspirin");

			engine.renamePaths([
				{ oldPath: "/data/orders[0]/name", newPath: "/data/orders[0]/med" },
			]);

			expect(engine.getState("/data/orders[0]/med").value).toBe("Hydrangea");
			expect(engine.getState("/data/orders[1]/med").value).toBe("Aspirin");
			expect(engine.getState("/data/orders[0]/name").path).toBe("");
			expect(engine.getState("/data/orders[1]/name").path).toBe("");
		});

		it("renamePaths carries a renamed repeat container's count and children", () => {
			const input = dTree([
				{
					id: "orders",
					kind: "repeat",
					children: [{ id: "name", kind: "text", label: proseText("Name") }],
				},
			]);
			const engine = new FormEngine(input);
			engine.addRepeat("/data/orders");
			engine.setValue("/data/orders[1]/name", "Aspirin");

			engine.renamePaths([
				{ oldPath: "/data/orders", newPath: "/data/meds" },
				{ oldPath: "/data/orders[0]/name", newPath: "/data/meds[0]/name" },
			]);

			expect(engine.getRepeatCount("/data/meds")).toBe(2);
			expect(engine.getRepeatCount("/data/orders")).toBe(0);
			expect(engine.getState("/data/meds[1]/name").value).toBe("Aspirin");
		});

		it("renamePaths drops instances a repeat→group collapse leaves homeless", () => {
			const input = dTree([
				{
					id: "c",
					kind: "repeat",
					children: [{ id: "x", kind: "text", label: proseText("X") }],
				},
			]);
			const engine = new FormEngine(input);
			engine.addRepeat("/data/c");
			engine.setValue("/data/c[0]/x", "keep");
			engine.setValue("/data/c[1]/x", "gone");

			engine.renamePaths([{ oldPath: "/data/c[0]/x", newPath: "/data/c/x" }]);

			expect(engine.getState("/data/c/x").value).toBe("keep");
			expect(engine.getState("/data/c[1]/x").path).toBe("");
		});

		it("a rename deletes the old key — index-free reads can't resurrect it", () => {
			const input = dTree([
				{
					id: "c",
					kind: "group",
					children: [{ id: "x", kind: "text", label: proseText("X") }],
				},
				{ id: "copy", kind: "hidden", calculate: formXp("#form/c/x") },
			]);
			const engine = new FormEngine(input);
			engine.setValue("/data/c/x", "5");
			expect(engine.getState("/data/copy").value).toBe("5");

			// The group→repeat conversion move: /data/c/x → /data/c[0]/x.
			engine.renamePaths([{ oldPath: "/data/c/x", newPath: "/data/c[0]/x" }]);
			engine.evaluatePathsInto(["/data/copy"]);

			// The outside reference reads blank (documented: no nodeset
			// semantics into a repeat) — never the frozen pre-move value.
			expect(engine.getState("/data/copy").value).toBe("");
		});

		it("nested repeats bind to the innermost shared instance", () => {
			const input = dTree([
				{
					id: "households",
					kind: "repeat",
					children: [
						{ id: "surname", kind: "text", label: proseText("Surname") },
						{
							id: "members",
							kind: "repeat",
							children: [
								{ id: "first", kind: "text", label: proseText("First name") },
								{
									id: "full",
									kind: "hidden",
									calculate: formXp(
										"concat(#form/households/members/first, ' ', #form/households/surname)",
									),
								},
							],
						},
					],
				},
			]);
			const engine = new FormEngine(input);
			engine.addRepeat("/data/households");

			engine.setValue("/data/households[0]/surname", "Smith");
			engine.setValue("/data/households[1]/surname", "Jones");
			engine.setValue("/data/households[0]/members[0]/first", "Mary");
			engine.setValue("/data/households[1]/members[0]/first", "Ada");

			expect(engine.getState("/data/households[0]/members[0]/full").value).toBe(
				"Mary Smith",
			);
			expect(engine.getState("/data/households[1]/members[0]/full").value).toBe(
				"Ada Jones",
			);
		});
	});

	// A form saving to the worker's own record, mounted the way the running
	// preview mounts one. The engine's case-write surface is assembled from
	// the input rather than handed the whole document, and it once left the
	// worker-property catalog out — so admission saw a declared destination as
	// undeclared and every such form failed to open at all. The catalog is
	// optional on `BlueprintDoc`, so dropping it again type-checks; these two
	// are what notice.
	describe("the worker's own record", () => {
		const PROPERTY = testUuid("worker-property-visits-done");
		const usercaseInput = (): FormEngineInput => ({
			// A survey, deliberately: the worker's record is written by every
			// form type, and a survey is the arm with no case of its own, so it
			// proves the collection is independent of the primary case action.
			...dTree(
				[
					{
						id: "visits",
						kind: "text",
						label: proseText("Visits done"),
						caseWrite: {
							caseType: USERCASE_CASE_TYPE,
							property: "visits_done",
						},
					},
				],
				"survey",
			),
			userProperties: {
				[PROPERTY]: {
					uuid: PROPERTY,
					slug: "visits_done",
					label: "Visits done",
				},
			},
		});

		it("opens a form whose field saves to a declared worker detail", () => {
			expect(() => new FormEngine(usercaseInput())).not.toThrow();
		});

		it("carries the answer out on the submission as a usercase write", () => {
			const engine = new FormEngine(usercaseInput());
			engine.setValue("/data/visits", "7");
			const mutation = engine.computeSubmissionMutation({
				entryKey: ENTRY_KEY,
			});
			expect(mutation.usercase).toEqual({ visits_done: "7" });
		});
	});
});

describe("sections on submission", () => {
	it("carries the case writes a section's questions hold", () => {
		const sectionedCaseTypes: CaseType[] = [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name"), data_type: "text" },
					{ name: "notes", label: proseText("Notes"), data_type: "text" },
				],
			},
		];
		const engine = new FormEngine(
			dTree(
				[
					{
						id: "about",
						kind: "section",
						label: proseText("About"),
						children: [
							{
								id: "case_name",
								kind: "text",
								label: proseText("Name"),
								caseWrite: { caseType: "patient", property: "case_name" },
							},
							{
								id: "notes",
								kind: "text",
								label: proseText("Notes"),
								caseWrite: { caseType: "patient", property: "notes" },
							},
						],
					},
				],
				"registration",
				sectionedCaseTypes,
			),
			"patient",
		);
		engine.setValue("/data/about/case_name", "Ada");
		engine.setValue("/data/about/notes", "first visit");
		const mutation = engine.computeSubmissionMutation({
			entryKey: ENTRY_KEY,
			viewerTimeZone: "UTC",
		});
		if (mutation.kind !== "registration") throw new Error("expected register");
		expect(mutation.primary.caseName).toBe("Ada");
		expect(mutation.primary.properties.notes).toBe("first visit");
	});
});
