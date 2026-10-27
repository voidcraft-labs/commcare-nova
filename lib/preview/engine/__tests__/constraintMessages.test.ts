// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Authored and returned markers remain literal data.
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { admitConstraintMessageFixture } from "@/lib/commcare/__tests__/constraintMessageFixture";
import type { LanguageTag, ProseTemplate } from "@/lib/domain";
import { proseText, USERCASE_CASE_TYPE } from "@/lib/domain";
import { xpathToString } from "../../xpath/coerce";
import { createInProcessXPathWorkerFactory } from "../../xpath/inProcessWorkerClient";
import { PreviewXPathRuntimeError } from "../../xpath/runtimeError";
import { XPathNodeSet } from "../../xpath/runtimeValues";
import { XPathRuntime } from "../../xpath/workerClient";
import { deserializeXPathWorkerValue } from "../../xpath/workerProjection";
import type { XPathRuntimeError } from "../../xpath/workerProtocol";
import type { CaseRow } from "../caseDataBindingTypes";
import {
	FormEngine,
	type FormEngineAsyncEvaluator,
	type FormEngineInput,
} from "../formEngine";
import { previewAsMe } from "../identity";
import {
	resolveConstraintMessage,
	resolveConstraintMessageAsync,
} from "../labelRefs";

const CHECKED = testUuid("message-checked");
const WORKER = "worker-7";
const IDENTITY = previewAsMe({ id: WORKER, email: "worker@example.org" });
/** The worker's record is a case-database read, so only the device's data
 * decides how many records answer it: the document is admitted, and several
 * matching records meet Core's one-node unpack at run time. */
const REF: ProseTemplate = {
	parts: [{ kind: "user-ref", property: "username" }],
};
const MESSAGE: ProseTemplate = {
	parts: [{ kind: "text", text: "Literal ${0}: " }, REF.parts[0]],
};

function workerRecord(index: number, username: string | undefined): CaseRow {
	return {
		case_id: `worker-record-${index}`,
		app_id: "app-1",
		case_type: USERCASE_CASE_TYPE,
		owner_id: WORKER,
		status: "open",
		opened_on: null,
		modified_on: null,
		closed_on: null,
		case_name: `Worker record ${index}`,
		external_id: null,
		parent_case_id: null,
		properties: {
			hq_user_id: WORKER,
			...(username === undefined ? {} : { username }),
		},
	};
}

function input(
	language: LanguageTag,
	options: {
		empty?: boolean;
		refOnly?: boolean;
		ruleReadsMany?: boolean;
		labelReadsMany?: boolean;
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
							...(options.labelReadsMany
								? [f({ kind: "label", id: "ordinary", label: REF })]
								: []),
							f({
								kind: "int",
								uuid: CHECKED,
								id: "checked",
								default_value: "4",
								validate: options.ruleReadsMany
									? "#user/username = 'never'"
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
		doc,
		formUuid,
		form: doc.forms[formUuid],
		fields: doc.fields,
		fieldOrder: doc.fieldOrder,
		caseTypes: [],
		language,
	};
}

/** A form engine for the worker whose device holds these worker records. */
function engineFor(
	engineInput: FormEngineInput,
	records: readonly CaseRow[],
	stagedAsync = false,
): FormEngine {
	return new FormEngine(
		engineInput,
		undefined,
		undefined,
		IDENTITY,
		undefined,
		{ rows: records, indices: [] },
		{ stagedAsync },
	);
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
			dayNumberEpoch: "device-zone",
			entryKey: "constraint-message-entry",
			revision: 0,
			profile: "form",
			source,
			resultMode,
			instances: engine.workerInstances(path, world, stateOverrides),
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
				for (const records of [1, 2]) {
					const engine = engineFor(
						input(language),
						Array.from({ length: records }, (_, index) =>
							workerRecord(index, "Data ${0} / ${00}"),
						),
						stagedAsync,
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
						} else engine.setValue("/data/checked", "99");
						expect(
							engine.getState("/data/checked"),
							`validation wording beside ${records} worker records`,
						).toMatchObject({
							value: "99",
							valid: false,
							errorMessage:
								records === 2
									? language === "spa"
										? "Valor no válido"
										: "Invalid value"
									: "Literal ${0}: Data ${0} / ${00}",
						});
						if (stagedAsync && records === 2) {
							expect(owned.failures.length).toBeGreaterThan(0);
							for (const failure of owned.failures)
								expect(failure).toMatchObject({
									code: "evaluation-failed",
									reason: {
										phase: "evaluation",
										kind: "nodeset-cardinality",
									},
								});
						}
					} finally {
						owned.runtime.dispose();
					}
				}
			},
		);

		it.each(["literal", "zero-nodes", "blank-node"] as const)(
			"uses the standard warning for resolved empty %s wording",
			async (emptyMode) => {
				const engine = engineFor(
					input("eng", {
						empty: emptyMode === "literal",
						refOnly: emptyMode !== "literal",
					}),
					[workerRecord(0, emptyMode === "zero-nodes" ? undefined : "")],
					stagedAsync,
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
					} else engine.setValue("/data/checked", "99");
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

		it.each(["ruleReadsMany", "labelReadsMany"] as const)(
			"retains the %s cardinality failure",
			async (surface) => {
				const records = [workerRecord(0, "first"), workerRecord(1, "second")];
				if (!stagedAsync) {
					expect(
						engineFor(input("eng", { [surface]: true }), records.slice(0, 1)),
					).toBeInstanceOf(FormEngine);
					expect(() =>
						engineFor(input("eng", { [surface]: true }), records),
					).toThrow("XPath nodeset has more than one node");
					return;
				}
				const engine = engineFor(
					input("eng", { [surface]: true }),
					records,
					stagedAsync,
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
