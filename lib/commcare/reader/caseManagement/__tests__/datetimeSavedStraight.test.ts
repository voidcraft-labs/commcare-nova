/**
 * A date-and-time question's answer saved straight to a case property.
 *
 * Contract: HQ's build binds a case block's leaf with no type, so Core keeps
 * the day of a date and time a basic update names straight
 * (`Recalculate.wrapData` wraps a `Date` under any bind but a date-and-time
 * one as `DateData`). Nova holds that as a date-and-time question saving to a
 * `date` property: its export names the question itself, with no
 * `nova_datetime_` sibling, its reading declares the property `date` and
 * holds the write, and the document read back exports the same update. A
 * moment still goes through its sibling into a `datetime` property, a day
 * beside a moment of one property is a pair of writers no one type holds,
 * and a day saved as the case's external id or to the worker's record (no
 * catalogued type, where Nova saves the moment) is refused under its own
 * entry.
 *
 * Plausible failures: the export keeping the sibling for a day (Nova then
 * saves the moment's text to a date property), the reading typing the
 * property `datetime` (the write then comes back through the sibling), a
 * day and a moment read into one property the gate refuses, and a day as an
 * external id or a worker property held as a write Nova exports as the
 * moment.
 */
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	placementFixture,
	own as placementOwn,
	read as placementRead,
} from "@/lib/commcare/__tests__/placementFixture";
import { expandDoc } from "@/lib/commcare/expander";
import { runValidation } from "@/lib/commcare/validator/runner";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type {
	BlueprintDoc,
	CaseOperationWrite,
	CasePropertyDataType,
} from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { exportedBody, inputFor } from "../../__tests__/novaExport";
import { readHqApp } from "./heldReading";

const F = "forms-and-case-writes";

type Modules = {
	forms: {
		unique_id: string;
		actions: {
			update_case: { update: Record<string, Record<string, unknown>> };
			usercase_update: {
				update: Record<string, Record<string, unknown>>;
				condition: Record<string, unknown>;
			};
		};
	}[];
}[];

/** One menu of patients whose follow-up forms each ask a date and time
 *  `seen`, saved to `seen_on`, declared `declared`. */
function visits(declared: CasePropertyDataType, forms = 1): BlueprintDoc {
	return buildDoc({
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "seen_on", label: proseText("Seen"), data_type: declared },
				],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				forms: Array.from({ length: forms }, (_, index) => ({
					name: `Visit ${index + 1}`,
					type: "followup" as const,
					fields: [
						f({
							kind: "datetime",
							id: "seen",
							label: "Seen",
							caseWrite: { caseType: "patient", property: "seen_on" },
						}),
					],
				})),
			},
		],
	});
}

function update(modules: unknown, form = 0) {
	const found = (modules as Modules)[0]?.forms[form]?.actions.update_case
		.update;
	if (found === undefined) throw new Error("The form keeps its own update.");
	return found;
}

function source(body: Record<string, unknown>, form = 0): string {
	const id = (body.modules as Modules)[0]?.forms[form]?.unique_id;
	const xml = (body._attachments as Record<string, string>)[`${id}.xml`];
	if (xml === undefined) throw new Error("The form has a source.");
	return xml;
}

async function read(body: Record<string, unknown>) {
	return readHqApp(await inputFor(body));
}

describe("a date-and-time question saved straight to a case", () => {
	it("is exported to a date property as the question itself, with no sibling", () => {
		const body = exportedBody(visits("date"));
		expect(update(body.modules).seen_on?.question_path).toBe("/data/seen");
		expect(source(body)).not.toContain("nova_datetime_");
	});

	it("is exported to a date-and-time property through its sibling", () => {
		const body = exportedBody(visits("datetime"));
		expect(update(body.modules).seen_on?.question_path).toBe(
			"/data/nova_datetime_seen",
		);
	});

	it("is read as a date property's writer and exported again as it came", async () => {
		const body = exportedBody(visits("datetime"));
		// The update HQ's form builder writes: the question named straight.
		const straight = {
			...body,
			modules: produce(body.modules as Modules, (draft) => {
				const seen = update(draft).seen_on;
				if (seen === undefined) throw new Error("The form saves seen_on.");
				seen.question_path = "/data/seen";
			}),
		};
		const outcome = await read(straight);
		if (outcome.kind !== "read")
			throw new Error(
				`The form does not come in: ${outcome.findings.map((one) => one.code).join(", ")}`,
			);
		const doc = outcome.draft.doc;
		expect(
			doc.caseTypes
				?.find((type) => type.name === "patient")
				?.properties.find((property) => property.name === "seen_on")?.data_type,
		).toBe("date");
		// The sibling the edited source still holds is a Hidden Value of the
		// person's own now, which the update names nowhere.
		const again = exportedBody(doc);
		expect(update(again.modules).seen_on?.question_path).toBe("/data/seen");
	});

	it("beside a moment saved to the same property is a pair of writers no one type holds", async () => {
		const body = exportedBody(visits("datetime", 2));
		const mixed = {
			...body,
			modules: produce(body.modules as Modules, (draft) => {
				const seen = update(draft, 1).seen_on;
				if (seen === undefined) throw new Error("The form saves seen_on.");
				seen.question_path = "/data/seen";
			}),
		};
		const outcome = await read(mixed);
		expect(
			outcome.kind === "account" ? outcome.findings.map((one) => one.code) : [],
		).toEqual([`${F}/any-other-mixed-writer-pair`]);
	});

	it("as the case's external id is refused under its own entry", async () => {
		const body = exportedBody(visits("datetime"));
		const asExternalId = {
			...body,
			modules: produce(body.modules as Modules, (draft) => {
				update(draft).external_id = {
					question_path: "/data/seen",
					update_mode: "always",
					doc_type: "ConditionalCaseUpdate",
				};
			}),
		};
		const outcome = await read(asExternalId);
		expect(
			outcome.kind === "account" ? outcome.findings.map((one) => one.code) : [],
		).toContain(`${F}/a-date-and-time-saved-straight-in-no-shape-nova-keeps`);
	});
	it("to the worker's record is refused under its own entry", async () => {
		const body = exportedBody(visits("date"));
		// HQ's build binds the usercase leaf untyped too, so a device keeps the
		// day there; Nova's worker properties are text and would get the moment.
		const toWorker = {
			...body,
			modules: produce(body.modules as Modules, (draft) => {
				const form = draft[0]?.forms[0];
				if (form === undefined) throw new Error("The menu keeps its form.");
				form.actions.usercase_update.update.last_seen = {
					question_path: "/data/seen",
					update_mode: "always",
					doc_type: "ConditionalCaseUpdate",
				};
				form.actions.usercase_update.condition = {
					type: "always",
					question: null,
					answer: null,
					operator: "=",
					doc_type: "FormActionCondition",
				};
			}),
		};
		const outcome = await read(toWorker);
		expect(
			outcome.kind === "account" ? outcome.findings.map((one) => one.code) : [],
		).toContain(`${F}/a-date-and-time-saved-straight-in-no-shape-nova-keeps`);
	});
});

/**
 * One date-and-time question saved to one property name on the form's own
 * case, a `datetime` property, and on the case above it, a `date` property:
 * each write is exported to its own destination, the moment through the
 * sibling and the day straight, whichever the operation writes first.
 */
describe("one date and time saved to a property of the same name on two cases", () => {
	const own: CaseOperationWrite = {
		property: "visited",
		value: placementRead("seen"),
	};
	const above: CaseOperationWrite = {
		...own,
		via: [{ identifier: "host", throughCaseType: "household" }],
	};

	function exported(writes: readonly CaseOperationWrite[]) {
		const { doc } = placementFixture("followup", {
			extraRoot: [{ kind: "datetime", id: "seen" }],
			operations: () => [placementOwn({ writes: [...writes] })],
		});
		const typed = produce(doc, (draft) => {
			for (const [type, data_type] of [
				["patient", "datetime"],
				["household", "date"],
			] as const)
				draft.caseTypes
					?.find((one) => one.name === type)
					?.properties.push({
						name: "visited",
						label: proseText("Visited"),
						data_type,
					});
		});
		expect(
			runValidation(typed, LOOKUP_CONTEXT_UNAVAILABLE).map((one) => one.code),
		).toEqual([]);
		const app = expandDoc(typed) as unknown as {
			modules: {
				forms: {
					name: Record<string, string>;
					actions: {
						update_case: { update: Record<string, { question_path: string }> };
					};
				}[];
			}[];
		};
		const update = app.modules[0]?.forms.find(
			(form) => form.name.en === "Under test",
		)?.actions.update_case.update;
		return Object.fromEntries(
			Object.entries(update ?? {}).map(([key, value]) => [
				key,
				value.question_path,
			]),
		);
	}

	const orders: readonly (readonly [string, CaseOperationWrite[]])[] = [
		["own case first", [own, above]],
		["case above first", [above, own]],
	];
	for (const [order, writes] of orders)
		it(`exports each to its own destination with the ${order}`, () => {
			expect(exported(writes)).toEqual({
				visited: "/data/nova_datetime_seen",
				"host/visited": "/data/seen",
			});
		});
});
