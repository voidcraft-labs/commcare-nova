import { expect, it } from "vitest";
import { recordDialectRoundTrip } from "@/lib/agent/authoring/recordRoundTrip";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import {
	parseFormExpressionForSlot,
	projectFormExpression,
} from "@/lib/doc/expressionText";
import { replaceFieldOptionsSourceMutation } from "@/lib/doc/lookupOptionsSourceMutations";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc } from "@/lib/domain";
import { choiceValues } from "../../../../../proof/targeted/documents/choiceValues";
import { closeConditions } from "../../../../../proof/targeted/documents/closeConditions";
import { planFormCaseWire } from "../../../casePlacementPlan";
import { hydrated } from "../../__tests__/publishedDocuments";
import { readEmission } from "../../expressions/__tests__/readBackCorpus";

function field(doc: BlueprintDoc, id: string) {
	const result = Object.values(doc.fields).find((field) => field.id === id);
	if (result === undefined) throw new Error(`No question named ${id}`);
	return result;
}

it("keeps a choice identity through formula editing, export, read-back and a value rename", async () => {
	const doc = hydrated(choiceValues());
	const answer = field(doc, "answer");
	const times = field(doc, "times");
	const notes = field(doc, "schedule_note");
	if (
		answer.kind !== "single_select" ||
		answer.optionsSource.kind !== "inline" ||
		times.kind !== "multi_select" ||
		times.optionsSource.kind !== "inline"
	)
		throw new Error("The witness must offer fixed choices");
	const value = `it's_"here"`;
	const choice = answer.optionsSource.options.find(
		(option) => option.value === value,
	);
	const time = times.optionsSource.options.find(
		(option) => option.value === value,
	);
	if (
		choice === undefined ||
		time === undefined ||
		answer.default_value === undefined
	)
		throw new Error("Missing quoted starting answer");

	const starting = {
		kind: "term",
		term: { kind: "choice", field: answer.uuid, options: [choice.uuid] },
	};
	const selected = {
		kind: "multi-select-contains",
		values: [{ kind: "choice", field: times.uuid, options: [time.uuid] }],
	};
	expect(answer.default_value).toEqual(starting);
	expect(notes).toMatchObject({ relevant: selected });
	const slot = {
		entity: "field",
		uuid: answer.uuid,
		slot: "default_value",
	} as const;
	const text = projectFormExpression(
		doc,
		slot,
		answer.default_value,
		new Map(),
	);
	expect(text.unresolved).toEqual([]);
	expect(text.text).toBe(`concat('it', "'", 's_"here"')`);
	expect(
		parseFormExpressionForSlot(
			doc,
			slot,
			`concat("it's_", '"here"')`,
			new Map(),
		),
	).toMatchObject({ ok: true, expression: starting });
	expect(
		parseFormExpressionForSlot(
			doc,
			slot,
			`concat(#form/name, '"here"')`,
			new Map(),
		),
	).toMatchObject({ ok: true, expression: { kind: "concat" } });
	const rename = mutationCommitVerdict(
		doc,
		[
			replaceFieldOptionsSourceMutation(answer.uuid, answer.kind, {
				kind: "inline",
				options: answer.optionsSource.options.map((option) =>
					option.uuid === choice.uuid
						? { ...option, value: `'"revised"` }
						: option,
				),
			}),
		],
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	expect(rename.ok ? [] : rename.findings).toEqual([]);
	for (const current of [doc, rename.nextDoc]) {
		const reading = await readEmission(current, recordDialectRoundTrip);
		expect(reading.closed.defects).toEqual([]);
		expect(reading.closed.findings).toEqual([]);
		expect(reading.doc?.fields[answer.uuid]).toMatchObject({
			default_value: starting,
		});
		expect(reading.doc?.fields[notes.uuid]).toMatchObject({
			relevant: selected,
		});
	}
});

it("writes and reads a quoted close condition at HQ's editable Save to Case block", async () => {
	const doc = hydrated(closeConditions());
	const form = Object.values(doc.forms).find(
		(form) => form.name === "Close on a quoted outcome",
	);
	if (!form) throw new Error("Missing close form");
	const plan = planFormCaseWire(doc, form.uuid);
	if (plan.kind !== "basic") throw new Error("Expected a basic menu");
	expect(plan.actions.close_case.condition.type).toBe("never");
	expect(plan.saveToCase).toContainEqual(
		expect.objectContaining({ subject: { kind: "own-close" } }),
	);
	const reading = await readEmission(doc, recordDialectRoundTrip);
	expect(reading.closed.defects).toEqual([]);
	expect(reading.closed.findings).toEqual([]);
	expect(reading.doc?.forms[form.uuid].closeCondition).toMatchObject({
		kind: "eq",
		right: { kind: "term", term: { kind: "choice" } },
	});
});
