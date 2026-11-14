/**
 * The rounds of the expression stage end, and end soon: each withdraws a
 * fold site and a slot holds finitely many. The failures this holds: an
 * app's own expressions, read back, taking more than four rounds, in a
 * hand-built app and in the largest document of each of the emitter's
 * corpora; a loop that reaches the round limit; a slot equal in one round
 * left unchecked after a later round, as when a Hidden Value's fold is
 * withdrawn and its type changes under a comparison that read equal before:
 * every slot held with no rewrite prints, in the document the reading
 * returns, the text it was read from.
 */
import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import { slotContext } from "@/lib/domain/expression/context";
import type {
	Expression,
	SlotContextRef,
	Term,
} from "@/lib/domain/expression/types";
import type { LookupColumnId, LookupTableId } from "@/lib/domain/lookupIds";
import { expressionSlotValues } from "@/lib/domain/referenceSlots";
import type { PendingExpression } from "../../pendingExpressions";
import { sameXPathText } from "../../syntaxCompare";
import { canonicalExpression } from "../canonical";
import {
	EXPRESSION_ROUND_LIMIT,
	type ExpressionReadEnv,
	readExpressions,
} from "../index";
import { compareOptionsFor, lookupTypes, printSlot } from "../readExpression";
import { fieldNamed, readEnv, registration } from "./expressionReadFixture";
import { corpusDocs, READ_BACK_CORPORA, storedSlots } from "./readBackCorpus";

describe("the expression stage's rounds", () => {
	it("reads Nova's own expressions back in a few rounds", () => {
		const doc = buildDoc({
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "age", label: "Age", data_type: "int" },
						{ name: "p", label: "P" },
					],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: {
						columns: [],
						searchInputs: [],
						filter: "p = 'a' or p = 'b'",
					} as never,
					forms: [
						{
							name: "Visit",
							type: "followup",
							fields: [
								f({ kind: "text", id: "q1", label: "Q1" }),
								f({
									kind: "int",
									id: "n",
									label: "N",
									relevant: "#form/q1 = 'yes'",
								}),
								f({
									kind: "hidden",
									id: "h",
									calculate: "concat(#form/q1, '-', #patient/p)",
								}),
								f({
									kind: "text",
									id: "q2",
									label: "Q2",
									relevant: "#form/n > 3 and #form/h != 'x'",
									validate: "string-length(.) < 20",
								}),
							],
						},
					],
				},
			],
		});
		const env = readEnv();
		const owners = [
			...Object.keys(doc.fields).map((uuid) => ({
				entity: "field" as const,
				uuid,
			})),
			...Object.keys(doc.forms).map((uuid) => ({
				entity: "form" as const,
				uuid,
			})),
			...Object.keys(doc.modules).map((uuid) => ({
				entity: "module" as const,
				uuid,
			})),
		];
		const pending = owners.flatMap((owner) =>
			expressionSlotValues(doc, owner as never).map(({ ref, expression }) =>
				registration(doc, ref, printSlot(doc, ref, expression, env)),
			),
		);
		expect(pending.length).toBeGreaterThan(3);
		const reading = readExpressions(doc, pending, env);
		expect(reading.rounds).toBeLessThanOrEqual(4);
		expect(reading.rounds).toBeLessThan(EXPRESSION_ROUND_LIMIT);
		expect(reading.circumstances).toEqual([]);
		expect(reading.bound.every((tree) => tree !== undefined)).toBe(true);
		expectHeldPrintsItsText(reading, pending, env);
	});
});

describe("a later round that changes a Hidden Value's type", () => {
	const TABLE = "01890000-0000-7000-8000-000000000401" as LookupTableId;
	const NAME = "01890000-0000-7000-8000-000000000402" as LookupColumnId;
	const WHEN = "01890000-0000-7000-8000-000000000403" as LookupColumnId;
	const ROWS = "instance('visits')/visits_list/visits";
	const env = readEnv({
		lookup: new Map([
			[
				TABLE,
				{
					id: TABLE,
					name: "Visits",
					tag: "visits",
					columns: [
						{ id: NAME, wireName: "name", label: "Name", dataType: "text" },
						{
							id: WHEN,
							wireName: "when",
							label: "When",
							dataType: "datetime",
						},
					],
				},
			],
		]) as ExpressionReadEnv["lookup"],
	});
	const term = (one: Term): Expression => ({ kind: "term", term: one });

	it("judges again a slot that read equal before the type changed", () => {
		const provisional = buildDoc({
			modules: [
				{
					name: "Survey",
					forms: [
						{
							name: "Survey",
							type: "survey",
							fields: [
								f({ kind: "text", id: "q1", label: "Q1" }),
								f({ kind: "datetime", id: "start", label: "Start" }),
								f({ kind: "hidden", id: "h" }),
								f({ kind: "text", id: "q2", label: "Q2" }),
								f({
									kind: "single_select",
									id: "pick",
									label: "Pick",
									optionsSource: {
										kind: "lookup",
										tableId: TABLE,
										valueColumnId: NAME,
										labelColumnId: NAME,
									},
								}),
							],
						},
					],
				},
			],
		});
		const q1 = fieldNamed(provisional, "q1");
		const start = fieldNamed(provisional, "start");
		const hidden = fieldNamed(provisional, "h");
		const q2 = fieldNamed(provisional, "q2");
		const calculate: SlotContextRef = {
			entity: "field",
			uuid: hidden,
			slot: "calculate",
		};
		const relevant: SlotContextRef = {
			entity: "field",
			uuid: q2,
			slot: "relevant",
		};
		// The read the empty-rows guard proposes for the Hidden Value: a date
		// and time from the table.
		const visitTime: Expression = {
			kind: "table-lookup",
			tableId: TABLE,
			resultColumnId: WHEN,
			where: {
				kind: "eq",
				left: term({ kind: "table-column", tableId: TABLE, columnId: NAME }),
				right: term({ kind: "field", uuid: q1 }),
			},
		};
		const asProposed = hydratePersistedBlueprint(toPersistableDoc(provisional));
		(asProposed.fields[hidden] as { calculate?: Expression }).calculate =
			visitTime;
		const before: Expression = {
			kind: "lt",
			left: term({ kind: "field", uuid: hidden }),
			right: term({ kind: "field", uuid: start }),
		};
		// HQ's guard falls back to 0 where Nova's falls back to '', so the
		// proposal prints otherwise and is withdrawn in the second round, and
		// the Hidden Value is no date and time for the rounds after it. The
		// comparison is Nova's own print where the Hidden Value is one: equal
		// in the first round, and printed otherwise once the type changed.
		// The Hidden Value's guard is a rewrite, so it is held at the second
		// level as the date and time Nova's print reads back as, and the
		// comparison, judged again over it, is the comparison once more.
		const pending = [
			registration(
				asProposed,
				calculate,
				`if(count(${ROWS}) > 0, ${ROWS}[name = /data/q1][1]/when, 0)`,
			),
			registration(
				asProposed,
				relevant,
				printSlot(asProposed, relevant, before, env),
			),
		];
		const reading = readExpressions(provisional, pending, env);
		expect(reading.rounds).toBeGreaterThan(1);
		expect(reading.rounds).toBeLessThanOrEqual(4);
		expect(reading.bound[0]).toEqual(visitTime);
		expect(reading.bound[1]).toEqual(before);
		expectHeldPrintsItsText(reading, pending, env);
	});

	it("judges every slot again once a Hidden Value is held at the second level", () => {
		const provisional = buildDoc({
			modules: [
				{
					name: "Survey",
					forms: [
						{
							name: "Survey",
							type: "survey",
							fields: [
								f({ kind: "text", id: "q1", label: "Q1" }),
								f({ kind: "datetime", id: "start", label: "Start" }),
								f({ kind: "hidden", id: "h" }),
								f({ kind: "text", id: "q2", label: "Q2" }),
							],
						},
					],
				},
			],
		});
		const q1 = fieldNamed(provisional, "q1");
		const start = fieldNamed(provisional, "start");
		const hidden = fieldNamed(provisional, "h");
		const q2 = fieldNamed(provisional, "q2");
		const calculate: SlotContextRef = {
			entity: "field",
			uuid: hidden,
			slot: "calculate",
		};
		const relevant: SlotContextRef = {
			entity: "field",
			uuid: q2,
			slot: "relevant",
		};
		const visitTime: Expression = {
			kind: "table-lookup",
			tableId: TABLE,
			resultColumnId: WHEN,
			where: {
				kind: "eq",
				left: term({ kind: "table-column", tableId: TABLE, columnId: NAME }),
				right: term({ kind: "field", uuid: q1 }),
			},
		};
		const asNova = hydratePersistedBlueprint(toPersistableDoc(provisional));
		(asNova.fields[hidden] as { calculate?: Expression }).calculate = visitTime;
		const before: Expression = {
			kind: "lt",
			left: term({ kind: "field", uuid: hidden }),
			right: term({ kind: "field", uuid: start }),
		};
		// The Hidden Value's text reads the table with no guard, which Nova's
		// print adds: it is held at the second level, as the date and time
		// Nova's print reads back as. The comparison is Nova's own print of
		// it over a date and time, lowered to arithmetic, which reads as the
		// comparison only once the Hidden Value is held so.
		const pending = [
			registration(provisional, calculate, `${ROWS}[name = /data/q1]/when`),
			registration(asNova, relevant, printSlot(asNova, relevant, before, env)),
		];
		const reading = readExpressions(provisional, pending, env);
		expect(reading.rewrites.map((one) => one.key)).toEqual([pending[0]?.key]);
		expect(reading.bound[0]).toBeDefined();
		expect(reading.bound[1]).toEqual(before);
		expect(reading.rounds).toBeLessThan(EXPRESSION_ROUND_LIMIT);
		// The reader's answer is canonical in the document it returns.
		pending.forEach((one, index) => {
			const tree = reading.bound[index];
			const context = slotContext(reading.doc, one.ref, lookupTypes(env));
			if (tree === undefined || context === undefined)
				throw new Error(`The slot ${one.key} is not held.`);
			expect(canonicalExpression(tree, context)).toEqual(tree);
		});
		expectHeldPrintsItsText(reading, pending, env);
	});
});

/** Every slot the reading holds with no rewrite reported prints, in the
 *  document the reading returns, the text it was read from: a slot judged
 *  equal in an early round was judged again after every change of a later
 *  one. */
function expectHeldPrintsItsText(
	reading: ReturnType<typeof readExpressions>,
	pending: readonly PendingExpression[],
	env: ExpressionReadEnv,
): void {
	pending.forEach((registration, index) => {
		const tree = reading.bound[index];
		if (tree === undefined || registration.mode.target === "search-row") return;
		const leveled = reading.rewrites.some(
			(one) =>
				one.key === registration.key &&
				isDeepStrictEqual(one.place, registration.place),
		);
		if (leveled) return;
		const context = slotContext(
			reading.doc,
			registration.ref,
			lookupTypes(env),
		);
		if (context === undefined)
			throw new Error(`The reading has no slot ${registration.key}.`);
		const printed = printSlot(reading.doc, registration.ref, tree, env);
		expect(
			sameXPathText(
				printed,
				registration.text,
				compareOptionsFor(reading.doc, registration, env, context.ruleSet),
			),
			`${registration.ref.slot}: ${printed}`,
		).toBe(true);
	});
}

describe("the rounds over the emitter's corpora", () => {
	for (const corpus of READ_BACK_CORPORA)
		it(`reads the largest document of the ${corpus.name} corpus in a few rounds`, {
			timeout: 60_000,
		}, () => {
			const [largest] = corpusDocs(corpus, 30)
				.map((doc) => ({ doc, slots: storedSlots(doc) }))
				.sort((a, b) => b.slots.length - a.slots.length);
			if (largest === undefined) throw new Error("The corpus is empty.");
			const { doc, slots } = largest;
			const env = readEnv();
			const pending = slots.flatMap(({ ref, expression }) => {
				// A search filter row is read through CSQL by the search reader.
				if (ref.entity === "module" && ref.slot === "search_input_predicate")
					return [];
				try {
					return [registration(doc, ref, printSlot(doc, ref, expression, env))];
				} catch {
					// A slot the emitter writes nowhere (a dormant case list).
					return [];
				}
			});
			const reading = readExpressions(doc, pending, env);
			expect(reading.rounds).toBeLessThanOrEqual(4);
			expect(reading.rounds).toBeLessThan(EXPRESSION_ROUND_LIMIT);
			expectHeldPrintsItsText(reading, pending, env);
		});
});
