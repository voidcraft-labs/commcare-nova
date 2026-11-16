import { produce } from "immer";
import { describe, expect, it, vi } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc, SearchInputDef, Uuid } from "@/lib/domain";
import { plainColumn } from "@/lib/domain/modules";
import { proseText } from "@/lib/domain/prose";
import { planFormCaseWire } from "../../casePlacementPlan";
import { expandDoc } from "../../expander";
import { assembleDocument } from "../assemble";
import { withCandidate } from "../candidate";
import { patients, uuid } from "../caseList/__tests__/fixtures";
import { STAGES } from "../index";
import {
	readContext,
	readerInput,
	retainedSourceBody,
	sourceFromBody,
} from "./readerInput";

/** Every document the production projection of a module's expression contexts was asked about,
 *  in order: the settle functions judge each candidate through it. */
const asked = vi.hoisted(() => [] as unknown[]);
vi.mock("../../expressionContext", async (original) => {
	const actual = await original<typeof import("../../expressionContext")>();
	return {
		...actual,
		moduleExpressionContexts: (
			...args: Parameters<typeof actual.moduleExpressionContexts>
		) => {
			asked.push(args[0]);
			return actual.moduleExpressionContexts(...args);
		},
	};
});

function followup(): BlueprintDoc {
	return buildDoc({
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [
							f({
								kind: "text",
								id: "weight",
								caseWrite: { caseType: "patient", property: "weight" },
							}),
						],
					},
				],
			},
		],
	});
}

/** The production projection behind a counting wrapper: each document object it was asked about. */
function counting() {
	const seen: BlueprintDoc[] = [];
	return {
		seen,
		plan(doc: BlueprintDoc, formUuid: Uuid) {
			seen.push(doc);
			return planFormCaseWire(doc, formUuid);
		},
	};
}

describe("each candidate is judged over a document of its own", () => {
	it("gives a new frozen document for every candidate, a patch that changes nothing included", () => {
		const doc = Object.freeze(followup()) as BlueprintDoc;
		const same = withCandidate(doc, () => {});
		expect(same).not.toBe(doc);
		expect(Object.isFrozen(same)).toBe(true);
		expect(same.forms).toBe(doc.forms);
	});

	it("freezes only what the candidate does not share with a document that is not frozen", () => {
		const doc = followup();
		const formUuid = Object.keys(doc.forms)[0] as Uuid;
		const candidate = withCandidate(doc, (draft) => {
			const form = draft.forms[formUuid];
			if (form !== undefined) form.type = "close";
		});
		expect(Object.isFrozen(candidate)).toBe(true);
		expect(Object.isFrozen(candidate.forms[formUuid])).toBe(true);
		expect(candidate.fields).toBe(doc.fields);
		expect(Object.isFrozen(doc)).toBe(false);
		expect(Object.isFrozen(doc.fields)).toBe(false);
		expect(Object.isFrozen(doc.forms[formUuid])).toBe(false);
		const same = withCandidate(doc, () => {});
		expect(Object.isFrozen(same)).toBe(true);
		expect(Object.isFrozen(doc.forms)).toBe(false);
	});

	it("leaves the document a candidate came from untouched", () => {
		const doc = followup();
		const formUuid = Object.keys(doc.forms)[0] as Uuid;
		const before = JSON.stringify(doc.forms[formUuid]);
		const candidate = withCandidate(doc, (draft) => {
			const form = draft.forms[formUuid];
			if (form !== undefined) form.type = "close";
		});
		expect(JSON.stringify(doc.forms[formUuid])).toBe(before);
		expect(candidate.forms[formUuid]?.type).toBe("close");
		expect(Object.isFrozen(candidate.forms[formUuid])).toBe(true);
	});

	it("judges a second candidate on its own plan when the first failed, never on the first one's memo", () => {
		const doc = followup();
		const formUuid = Object.keys(doc.forms)[0] as Uuid;
		const wrapper = counting();
		// The first candidate drops the form's own write, and its plan writes
		// no update; the second keeps it.
		const first = withCandidate(doc, (draft) => {
			const own = draft.forms[formUuid]?.caseOperations?.[0];
			if (own !== undefined) delete own.writes;
		});
		const second = withCandidate(doc, () => {});
		const rejected = wrapper.plan(first, formUuid);
		const accepted = wrapper.plan(second, formUuid);
		expect(wrapper.seen[0]).not.toBe(wrapper.seen[1]);
		expect(
			rejected.kind === "basic" &&
				Object.keys(rejected.actions.update_case.update),
		).toEqual([]);
		expect(
			accepted.kind === "basic" &&
				Object.keys(accepted.actions.update_case.update),
		).toEqual(["weight"]);
		// The draft the reading keeps holds the accepted candidate alone.
		expect(
			doc.forms[formUuid]?.caseOperations?.[0]?.writes?.[0]?.property,
		).toBe("weight");
	});

	it("settles a date Search field over a property no writer types on its second candidate, `datetime`, over a document of its own", async () => {
		const seen: SearchInputDef = {
			uuid: uuid(9),
			name: "seen",
			label: "Seen",
			kind: "simple",
			type: "date",
			property: "seen_at",
		};
		const doc = produce(
			patients([plainColumn(uuid(1), "case_name", "Name")], {
				searchInputs: [seen],
				search: {},
			}),
			(draft) => {
				draft.caseTypes = [
					{
						name: "patient",
						properties: [
							{
								name: "seen_at",
								label: proseText("Seen at"),
								data_type: "datetime",
							},
						],
					},
				];
			},
		);
		const emitted = expandDoc(doc);
		const app = JSON.parse(
			JSON.stringify({
				...retainedSourceBody("shell/app-source"),
				modules: emitted.modules,
				_attachments: emitted._attachments,
			}),
		) as Record<string, unknown>;
		const ctx = readContext(readerInput(await sourceFromBody(app)));
		asked.length = 0;
		for (const stage of STAGES.slice(0, STAGES.indexOf(assembleDocument)))
			stage(ctx);
		const typeOf = (one: unknown) =>
			(one as BlueprintDoc).caseTypes
				?.find((type) => type.name === "patient")
				?.properties.find((property) => property.name === "seen_at")?.data_type;
		const first = asked.find((one) => typeOf(one) === "date");
		const second = asked.find((one) => typeOf(one) === "datetime");
		// The first candidate was judged and failed; the second, a document of its own, passed.
		expect(first).toBeDefined();
		expect(second).toBeDefined();
		expect(first).not.toBe(second);
		const read = ctx.doc;
		expect(typeOf(read)).toBe("datetime");
		expect(
			Object.values(read?.modules ?? {})[0]?.caseListConfig?.searchInputs,
		).toMatchObject([{ kind: "simple", type: "date", property: "seen_at" }]);
		expect(
			ctx.accounting.findings().filter((one) => one.place.kind === "search"),
		).toEqual([]);
	});
});
