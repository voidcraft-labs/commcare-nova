// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Authored and returned markers remain literal data.
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { admitConstraintMessageFixture } from "@/lib/commcare/__tests__/constraintMessageFixture";
import type { LanguageTag, ProseTemplate } from "@/lib/domain";
import { proseText } from "@/lib/domain";
import { xpathToString } from "../../xpath/coerce";
import { createInProcessXPathWorkerFactory } from "../../xpath/inProcessWorkerClient";
import { PreviewXPathRuntimeError } from "../../xpath/runtimeError";
import { XPathNodeSet } from "../../xpath/runtimeValues";
import { XPathRuntime } from "../../xpath/workerClient";
import { deserializeXPathWorkerValue } from "../../xpath/workerProjection";
import type { XPathRuntimeError } from "../../xpath/workerProtocol";
import {
	FormEngine,
	type FormEngineAsyncEvaluator,
	type FormEngineInput,
} from "../formEngine";
import {
	resolveConstraintMessage,
	resolveConstraintMessageAsync,
} from "../labelRefs";

const VALUE = testUuid("message-repeat-value");
const COUNT = testUuid("message-repeat-count");
const CHECKED = testUuid("message-checked");
const REF: ProseTemplate = { parts: [{ kind: "field-ref", uuid: VALUE }] };
const MESSAGE: ProseTemplate = {
	parts: [
		{ kind: "text", text: "Literal ${0}: " },
		{ kind: "field-ref", uuid: VALUE },
	],
};

function input(
	language: LanguageTag,
	options: {
		empty?: boolean;
		refOnly?: boolean;
		blankValue?: boolean;
		ruleReadsMany?: boolean;
		labelReadsMany?: boolean;
		userControlled?: boolean;
	} = {},
): FormEngineInput {
	const doc = buildDoc({
		modules: [
			{
				name: "Work",
				forms: [
					{
						name: "Check",
						type: "survey",
						fields: [
							f({
								kind: "int",
								uuid: COUNT,
								id: "count",
								default_value:
									options.ruleReadsMany || options.labelReadsMany
										? "2"
										: options.blankValue
											? "1"
											: "0",
							}),
							f({
								kind: "repeat",
								id: "rows",
								...(options.userControlled
									? { repeat_mode: "user_controlled" as const }
									: {
											repeat_mode: "count_bound" as const,
											repeat_count: "#form/count",
										}),
								children: [
									f({
										kind: "text",
										uuid: VALUE,
										id: "value",
										default_value: options.blankValue
											? "''"
											: "'Data ${0} / ${00}'",
									}),
								],
							}),
							...(options.labelReadsMany
								? [f({ kind: "label", id: "ordinary", label: REF })]
								: []),
							f({
								kind: "int",
								uuid: CHECKED,
								id: "checked",
								default_value: "4",
								validate: options.ruleReadsMany
									? "#form/rows/value = 'never'"
									: ". < 10",
								validate_msg: options.empty
									? proseText("")
									: options.refOnly
										? REF
										: MESSAGE,
							}),
						],
					},
				],
			},
		],
	});
	admitConstraintMessageFixture(doc);
	const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
	return {
		formUuid,
		form: doc.forms[formUuid],
		fields: doc.fields,
		fieldOrder: doc.fieldOrder,
		caseTypes: [],
		language,
	};
}

/** Own the real worker dispatcher, snapshots, requests, and terminal teardown. */
function worker(engine: FormEngine) {
	const runtime = new XPathRuntime({
		workerFactory: createInProcessXPathWorkerFactory(),
	});
	const world = engine.createWorkerWorld("constraint-messages");
	const failures: XPathRuntimeError[] = [];
	const evaluateAsync = (async (
		source: string,
		path: string,
		resultMode: "scalar" | "nodeset-values-or-scalar" = "scalar",
		stateOverrides?: Parameters<FormEngineAsyncEvaluator>[3],
	) => {
		const result = await runtime.request({
			entryKey: "constraint-message-entry",
			revision: 0,
			profile: "form",
			source,
			resultMode,
			instances: engine.workerInstances(source, path, world, stateOverrides),
		});
		if (!result.ok) {
			failures.push(result.error);
			throw new PreviewXPathRuntimeError(result.error);
		}
		if (result.nodesetValues !== undefined)
			return { kind: "nodeset-values" as const, values: result.nodesetValues };
		return deserializeXPathWorkerValue(result.value);
	}) as FormEngineAsyncEvaluator;
	return { runtime, evaluateAsync, failures };
}

describe.each([false, true])(
	"constraint wording (worker: %s)",
	(stagedAsync) => {
		it.each(["eng", "spa"] as const)(
			"uses the existing %s invalid wording only for an ambiguous reference",
			async (language) => {
				const engine = new FormEngine(
					input(language),
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					{
						stagedAsync,
					},
				);
				const owned = worker(engine);
				try {
					if (stagedAsync) await engine.initializeAsync(owned.evaluateAsync);
					const set = async (path: string, value: string) => {
						if (stagedAsync)
							await engine.setValueAsync(path, value, owned.evaluateAsync);
						else engine.setValue(path, value);
					};
					await set("/data/checked", "99");
					// Count decreases retain existing rows and their answers on device.
					for (const [count, rows] of [
						[0, 0],
						[1, 1],
						[2, 2],
						[1, 2],
					]) {
						await set("/data/count", String(count));
						expect(engine.getRepeatCount("/data/rows")).toBe(rows);
						expect(
							engine.getState("/data/checked"),
							`validation wording after live count ${count}`,
						).toMatchObject({
							value: "99",
							valid: false,
							errorMessage:
								rows === 2
									? language === "spa"
										? "Valor no válido"
										: "Invalid value"
									: rows === 0
										? "Literal ${0}: "
										: "Literal ${0}: Data ${0} / ${00}",
						});
						if (count === 1)
							expect(engine.getState("/data/rows[0]/value").value).toBe(
								"Data ${0} / ${00}",
							);
					}
					if (stagedAsync) {
						expect(owned.failures.length).toBeGreaterThan(0);
						for (const failure of owned.failures)
							expect(failure).toMatchObject({
								code: "evaluation-failed",
								reason: { phase: "evaluation", kind: "nodeset-cardinality" },
							});
					}
				} finally {
					owned.runtime.dispose();
				}
			},
		);

		it.each(["literal", "zero-nodes", "blank-node"] as const)(
			"uses the standard warning for resolved empty %s wording",
			async (emptyMode) => {
				const engine = new FormEngine(
					input("eng", {
						empty: emptyMode === "literal",
						refOnly: emptyMode !== "literal",
						blankValue: emptyMode === "blank-node",
					}),
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					{ stagedAsync },
				);
				const owned = worker(engine);
				try {
					if (stagedAsync) await engine.initializeAsync(owned.evaluateAsync);
					expect(engine.getRepeatCount("/data/rows")).toBe(
						emptyMode === "blank-node" ? 1 : 0,
					);
					if (stagedAsync)
						await engine.setValueAsync(
							"/data/checked",
							"99",
							owned.evaluateAsync,
						);
					else engine.setValue("/data/checked", "99");
					expect(engine.getState("/data/checked")).toMatchObject({
						value: "99",
						valid: false,
						errorMessage: "Invalid value",
					});
				} finally {
					owned.runtime.dispose();
				}
			},
		);

		it("restores exact custom wording after an authored repeat row is removed", async () => {
			const engine = new FormEngine(
				input("eng", { userControlled: true }),
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				{ stagedAsync },
			);
			const owned = worker(engine);
			try {
				if (stagedAsync) {
					await engine.initializeAsync(owned.evaluateAsync);
					await engine.setValueAsync(
						"/data/checked",
						"99",
						owned.evaluateAsync,
					);
					await engine.addRepeatAsync("/data/rows", owned.evaluateAsync);
				} else {
					engine.setValue("/data/checked", "99");
					engine.addRepeat("/data/rows");
				}
				expect(engine.getRepeatCount("/data/rows")).toBe(2);
				expect(engine.getState("/data/checked")).toMatchObject({
					value: "99",
					valid: false,
					errorMessage: "Invalid value",
				});
				if (stagedAsync)
					await engine.removeRepeatAsync("/data/rows", 1, owned.evaluateAsync);
				else engine.removeRepeat("/data/rows", 1);
				expect(engine.getRepeatCount("/data/rows")).toBe(1);
				expect(engine.getState("/data/checked")).toMatchObject({
					value: "99",
					valid: false,
					errorMessage: "Literal ${0}: Data ${0} / ${00}",
				});
			} finally {
				owned.runtime.dispose();
			}
		});

		it.each(["ruleReadsMany", "labelReadsMany"] as const)(
			"retains the %s cardinality failure",
			async (surface) => {
				if (!stagedAsync) {
					expect(
						() => new FormEngine(input("eng", { [surface]: true })),
					).toThrow("XPath nodeset has more than one node");
					return;
				}
				const engine = new FormEngine(
					input("eng", { [surface]: true }),
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					{ stagedAsync },
				);
				const owned = worker(engine);
				try {
					await expect(
						engine.initializeAsync(owned.evaluateAsync),
					).rejects.toMatchObject({
						failureKind:
							"xpath:evaluation-failed:evaluation:nodeset-cardinality",
					});
				} finally {
					owned.runtime.dispose();
				}
			},
		);
	},
);

it("does not replace invalid paths, generic errors or non-cardinality worker failures", async () => {
	const invalidPath = () => xpathToString(new XPathNodeSet([], false));
	expect(() => resolveConstraintMessage(invalidPath)).toThrow(
		"path that does not exist",
	);
	await expect(
		resolveConstraintMessageAsync(async () => invalidPath()),
	).rejects.toThrow("path that does not exist");
	const generic = new Error(
		"XPath nodeset has more than one node from unrelated code",
	);
	expect(() =>
		resolveConstraintMessage(() => {
			throw generic;
		}),
	).toThrow(generic);
	for (const code of ["cancelled", "timeout", "worker-failed"] as const) {
		const failure = new PreviewXPathRuntimeError({
			code,
			operation: "evaluate",
			entryKey: "constraint-message-entry",
			revision: 0,
			profile: "form",
			reason: { phase: "evaluation", kind: "nodeset-cardinality" },
		});
		await expect(
			resolveConstraintMessageAsync(async () => {
				throw failure;
			}),
		).rejects.toThrow(failure);
	}
});
