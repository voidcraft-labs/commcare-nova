/**
 * A child case's condition that reads one question alone, `boolean_true`,
 * read as the commit gate judges it. Contract: where the question is a Hidden
 * Value a condition calculates, CommCare holds a yes or no and the reading
 * holds the bare read; where it is a question whose answer is no yes or no (a
 * select here), the reading holds the explicit operation Core applies,
 * `boolean(...)` of the question, which the gate admits as a case change's
 * condition and Nova's emitter states back as the same `boolean_true`, so
 * CommCare HQ's stored condition comes back as it was. The chat and MCP
 * tools read that condition as `boolean(#form/<question>)` and take it back
 * in the same spelling. The plausible
 * failure: the reader admitting a bare read the gate refuses, which stopped
 * CommCare HQ's WASH starter app at the gate; refusing the condition it can
 * now hold; holding it in a shape that comes back as another operator or
 * question; or the record dialect neither printing nor reading it, which
 * leaves the form's case changes unreadable to an agent.
 */
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { makeAuthoringHarness } from "@/lib/agent/__tests__/authoringHarness";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { type BlueprintDoc, moduleUuidOfForm, type Uuid } from "@/lib/domain";
import { formField, term } from "@/lib/domain/expression/builders";
import { proseText } from "@/lib/domain/prose";
import { exportedBody, inputFor } from "../../__tests__/novaExport";
import { readHqApp } from "./heldReading";

const FORM = testUuid("not-yes-no-form");
const FLAG = testUuid("not-yes-no-flag");
const REFERRAL = testUuid("not-yes-no-referral");
const NAME = testUuid("not-yes-no-name");

function inspection(): BlueprintDoc {
	const built = buildDoc({
		caseTypes: [
			{ name: "household", properties: [] },
			{ name: "referral", parent_type: "household", properties: [] },
		],
		modules: [
			{
				name: "Households",
				caseType: "household",
				forms: [
					{
						uuid: FORM,
						name: "Inspection",
						type: "followup",
						fields: [
							f({
								uuid: NAME,
								kind: "text",
								id: "referral_name",
								label: "Name",
							}),
							f({
								kind: "single_select",
								id: "outcome",
								label: "Outcome",
								optionsSource: {
									kind: "inline",
									options: [
										{
											value: "1",
											label: proseText("Yes"),
											uuid: testUuid("not-yes-no-yes"),
										},
										{
											value: "0",
											label: proseText("No"),
											uuid: testUuid("not-yes-no-no"),
										},
									],
								},
							}),
							f({
								uuid: FLAG,
								kind: "hidden",
								id: "create_referral",
								calculate: "#form/outcome = '1'",
							}),
						],
					},
				],
			},
			{
				// A basic child case's type is a menu's case type.
				name: "Referrals",
				caseType: "referral",
				forms: [
					{
						name: "Follow up",
						type: "followup",
						fields: [f({ kind: "text", id: "note", label: "Note" })],
					},
				],
			},
		],
	});
	const form = built.forms[FORM];
	return {
		...built,
		forms: {
			...built.forms,
			[FORM]: {
				...form,
				caseOperations: [
					...(form.caseOperations ?? []),
					{
						uuid: REFERRAL,
						id: "referral",
						action: "create",
						caseType: "referral",
						target: { kind: "new" },
						name: term(formField(NAME)),
						links: [
							{
								identifier: "parent",
								targetType: "household",
								relationship: "child",
								target: { kind: "session" },
							},
						],
						condition: term(formField(FLAG)),
					},
				],
			},
		},
	};
}

type Modules = {
	forms: { actions: { subcases: { condition: Record<string, unknown> }[] } }[];
}[];

/** The child case's stored condition of an export of `doc`. */
function storedCondition(modules: unknown): Record<string, unknown> {
	const condition = (modules as Modules)[0]?.forms[0]?.actions.subcases[0]
		?.condition;
	if (condition === undefined)
		throw new Error("The form keeps its child case in a basic slot.");
	return condition;
}

/** A reading of `doc`'s export, its child case's condition pointed at
 *  `question` when one is named. */
async function reading(doc: BlueprintDoc, question?: string) {
	const body = exportedBody(doc, {
		modules: (modules) =>
			produce(modules, (draft) => {
				const condition = storedCondition(draft);
				expect(condition).toMatchObject({ operator: "boolean_true" });
				if (question !== undefined) condition.question = question;
			}),
	});
	return {
		outcome: readHqApp(await inputFor(body)),
		stored: storedCondition(body.modules),
	};
}

/** The read document's child case condition, with the field it reads named by id. */
function readCondition(read: BlueprintDoc): unknown {
	const form = Object.values(read.forms).find(
		(one) => one.name === "Inspection",
	);
	const create = form?.caseOperations?.find((one) => one.id === "referral");
	const named = JSON.stringify(create?.condition, (_key, value) =>
		typeof value === "string" && read.fields[value as never] !== undefined
			? `#${read.fields[value as never]?.id}`
			: value,
	);
	return named === undefined ? undefined : JSON.parse(named);
}

const AT = (id: string) => ({
	kind: "term",
	term: { kind: "field", uuid: `#${id}` },
});

describe("a child case's condition reading one question alone", () => {
	it("holds a Hidden Value a condition calculates as the bare read", async () => {
		const { outcome } = await reading(inspection());
		if (outcome.kind !== "read") throw new Error("The form does not come in.");
		expect(readCondition(outcome.draft.doc)).toEqual(AT("create_referral"));
	});

	it("holds a choice question, whose answer no yes or no holds, through boolean(...), and states it back as HQ stored it", async () => {
		const { outcome, stored } = await reading(inspection(), "/data/outcome");
		if (outcome.kind !== "read")
			throw new Error(
				`The form does not come in: ${outcome.findings.map((one) => one.code).join(", ")}`,
			);
		expect(readCondition(outcome.draft.doc)).toEqual({
			kind: "call",
			fn: "boolean",
			args: [AT("outcome")],
		});
		const again = exportedBody(outcome.draft.doc);
		expect(storedCondition(again.modules)).toEqual(stored);
	});

	it("emits Nova's own boolean(...) of a question as that same condition", async () => {
		const doc = inspection();
		const outcomeField = Object.values(doc.fields).find(
			(field) => field.id === "outcome",
		);
		if (outcomeField === undefined) throw new Error("The form asks outcome.");
		const explicit = produce(doc, (draft) => {
			const create = draft.forms[FORM]?.caseOperations?.find(
				(one) => one.uuid === REFERRAL,
			);
			if (create === undefined || create.action !== "create")
				throw new Error("The form opens the referral.");
			create.condition = {
				kind: "call",
				fn: "boolean",
				args: [term(formField(outcomeField.uuid))],
			};
		});
		const { outcome, stored } = await reading(explicit);
		expect(stored).toMatchObject({
			type: "if",
			question: "/data/outcome",
			operator: "boolean_true",
		});
		if (outcome.kind !== "read") throw new Error("The form does not come in.");
		expect(readCondition(outcome.draft.doc)).toEqual({
			kind: "call",
			fn: "boolean",
			args: [AT("outcome")],
		});
	});

	it("is read by the case change tools as boolean(...) and written back in that spelling", async () => {
		const { outcome } = await reading(inspection(), "/data/outcome");
		if (outcome.kind !== "read") throw new Error("The form does not come in.");
		const doc = outcome.draft.doc;
		const [formUuid] = Object.entries(doc.forms).find(
			([, form]) => form.name === "Inspection",
		) as [Uuid, unknown];
		const moduleUuid = moduleUuidOfForm(doc, formUuid);
		if (moduleUuid === undefined) throw new Error("The form has a menu.");
		// Called as a chat or MCP client calls the tools: authored text in and out.
		const h = makeAuthoringHarness({}, doc);
		const authored = (await h.call("getCaseOperations", {
			moduleUuid,
			formUuid,
		})) as { operations: Record<string, unknown>[] };
		const operation = doc.forms[formUuid]?.caseOperations?.find(
			(one) => one.id === "referral",
		);
		if (operation === undefined) throw new Error("The form opens a referral.");
		const projected = authored.operations.find(
			(one) => one.uuid === operation.uuid,
		);
		if (projected === undefined)
			throw new Error("The tool reads the referral.");
		expect(projected.condition).toBe("boolean(#form/outcome)");
		// The same condition over another answer, written back by an agent.
		const {
			uuid: _uuid,
			placement: _placement,
			placementKept: _kept,
			...input
		} = projected;
		const written = await h.call("updateCaseOperation", {
			moduleUuid,
			formUuid,
			operationUuid: operation.uuid,
			operation: { ...input, condition: "boolean(#form/referral_name)" },
		});
		expect(written).not.toHaveProperty("error");
		const after = h.currentDoc();
		const condition = after.forms[formUuid]?.caseOperations?.find(
			(one) => one.uuid === operation.uuid,
		)?.condition;
		expect(condition).toMatchObject({
			kind: "call",
			fn: "boolean",
			args: [{ kind: "term", term: { kind: "field" } }],
		});
		const verdict = mutationCommitVerdict(
			after,
			[],
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict.ok ? [] : verdict.findings).toEqual([]);
	});
});
