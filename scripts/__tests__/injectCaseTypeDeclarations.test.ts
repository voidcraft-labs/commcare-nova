import { describe, expect, it } from "vitest";
import type { Mutation } from "@/lib/doc/types";
import type { Event, MutationEvent } from "@/lib/log/types";
import { injectMissingCaseTypeDeclarations } from "../lib/injectCaseTypeDeclarations";

// ── Minimal event builders ─────────────────────────────────────────────
// The transform reads only `kind`, the mutation discriminant, and the
// case-type slots (`field.case_property_on`, `patch.case_property_on`,
// `caseTypes[].name`, `module.caseType`, `caseType`), so the fixtures cast
// minimal shapes rather than spelling whole valid entities.

let nextSeq = 0;
function mEvent(
	mutation: Mutation,
	over: Partial<MutationEvent> = {},
): MutationEvent {
	return {
		runId: "run-1",
		ts: 1000,
		seq: nextSeq++,
		source: "chat",
		kind: "mutation",
		actor: "agent",
		mutation,
		...over,
	};
}

const addField = (id: string, caseType?: string): Mutation =>
	({
		kind: "addField",
		parentUuid: "form-1",
		field: {
			kind: "text",
			uuid: `${id}-uuid`,
			id,
			label: id,
			...(caseType !== undefined && { case_property_on: caseType }),
		},
	}) as unknown as Mutation;

const updateFieldTo = (caseType: string): Mutation =>
	({
		kind: "updateField",
		uuid: "f-uuid",
		targetKind: "text",
		patch: { case_property_on: caseType },
	}) as unknown as Mutation;

const setCaseTypes = (...names: string[]): Mutation =>
	({
		kind: "setCaseTypes",
		caseTypes: names.map((name) => ({ name, properties: [] })),
	}) as unknown as Mutation;

const addModule = (caseType: string): Mutation =>
	({ kind: "addModule", module: { caseType } }) as unknown as Mutation;

const declareCaseType = (caseType: string): Mutation => ({
	kind: "declareCaseType",
	caseType,
});

const conversation = (): Event =>
	({
		runId: "run-1",
		ts: 1000,
		seq: nextSeq++,
		source: "chat",
		kind: "conversation",
		payload: { type: "user-message", text: "hi" },
	}) as unknown as Event;

/** The case types of the synthetic declares in an output stream, in order. */
function declaredIn(events: Event[]): string[] {
	return events.flatMap((e) =>
		e.kind === "mutation" && e.mutation.kind === "declareCaseType"
			? [e.mutation.caseType]
			: [],
	);
}

describe("injectMissingCaseTypeDeclarations", () => {
	it("injects a declare before the first add_fields writer of an undeclared child type", () => {
		// A registration run: module type `patient` (declared via setCaseTypes),
		// its own `case_name` writer, then a subcase field writing the CHILD type
		// `household` — which pre-P2 only existed via the auto-mint side effect.
		const addModuleEv = mEvent(addModule("patient"));
		const setTypesEv = mEvent(setCaseTypes("patient"));
		const primary = mEvent(addField("case_name", "patient"));
		const child = mEvent(addField("household_name", "household"));
		const { events, injections } = injectMissingCaseTypeDeclarations([
			addModuleEv,
			setTypesEv,
			primary,
			child,
		]);

		expect(injections).toEqual([
			{ caseType: "household", index: 3, trigger: "addField" },
		]);
		// Exactly one synthetic declare, for the child type only — the module
		// type `patient` was already declared, so it is not injected.
		expect(declaredIn(events)).toEqual(["household"]);
		// It sits immediately before the child writer.
		expect(events[events.indexOf(child) - 1]).toBe(events[3]);
		expect(events).toHaveLength(5); // 4 original + 1 injected
		// Originals are identity-stable.
		expect(events.filter((e) => e === primary)).toHaveLength(1);
	});

	it("injects nothing when the type is already declared via setCaseTypes", () => {
		const result = injectMissingCaseTypeDeclarations([
			mEvent(setCaseTypes("patient")),
			mEvent(addField("case_name", "patient")),
		]);
		expect(result.injections).toHaveLength(0);
		expect(result.events).toHaveLength(2);
	});

	it("injects nothing when an explicit declareCaseType precedes the writer (post-P2 stream)", () => {
		const result = injectMissingCaseTypeDeclarations([
			mEvent(declareCaseType("household")),
			mEvent(addField("household_name", "household")),
		]);
		expect(result.injections).toHaveLength(0);
	});

	it("injects one declare for multiple writers of the same undeclared type", () => {
		const { injections, events } = injectMissingCaseTypeDeclarations([
			mEvent(addField("a", "household")),
			mEvent(addField("b", "household")),
			mEvent(addField("c", "household")),
		]);
		expect(injections).toHaveLength(1);
		expect(injections[0].caseType).toBe("household");
		expect(declaredIn(events)).toEqual(["household"]);
	});

	it("is idempotent — re-running over the injected stream injects nothing", () => {
		const original = [mEvent(addField("household_name", "household"))];
		const once = injectMissingCaseTypeDeclarations(original);
		expect(once.injections).toHaveLength(1);
		const twice = injectMissingCaseTypeDeclarations(once.events);
		expect(twice.injections).toHaveLength(0);
		expect(twice.events).toHaveLength(once.events.length);
	});

	it("injects for an updateField that re-targets a field onto a new undeclared type", () => {
		const { injections } = injectMissingCaseTypeDeclarations([
			mEvent(updateFieldTo("referral")),
		]);
		expect(injections).toEqual([
			{ caseType: "referral", index: 0, trigger: "updateField" },
		]);
	});

	it("ignores field writes with no case_property_on and conversation events", () => {
		const result = injectMissingCaseTypeDeclarations([
			conversation(),
			mEvent(addField("note")), // no case_property_on
			conversation(),
		]);
		expect(result.injections).toHaveLength(0);
		expect(result.events).toHaveLength(3);
	});

	it("suppresses injection for a module's own type when addModule precedes the writer", () => {
		// A module declares `patient`; its later case_name writer needs no declare
		// (module types are materialized separately).
		const result = injectMissingCaseTypeDeclarations([
			mEvent(addModule("patient")),
			mEvent(addField("case_name", "patient")),
		]);
		expect(result.injections).toHaveLength(0);
	});

	it("copies the trigger's envelope onto the synthetic declare (same chapter)", () => {
		const trigger = mEvent(addField("household_name", "household"), {
			ts: 5000,
			seq: 7,
			stage: "module:1",
			runId: "run-x",
			source: "mcp",
			actor: "agent",
		});
		const [decl] = injectMissingCaseTypeDeclarations([trigger]).events;
		expect(decl).toEqual({
			runId: "run-x",
			ts: 5000,
			seq: 7,
			source: "mcp",
			kind: "mutation",
			actor: "agent",
			stage: "module:1",
			mutation: { kind: "declareCaseType", caseType: "household" },
		});
	});
});
