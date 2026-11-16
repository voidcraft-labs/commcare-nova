/**
 * Showing a menu's forms in the menu above, and giving it its own screen
 * again, through the commit gate, a serialization round trip and the
 * document diff: the one writer
 * (`displayConditionMutations.ts::setModuleFormsInMenuAboveMutation`), the
 * after-submit reconcile every `updateModule` runs
 * (`mutations/modules.ts::reconcilePostSubmitWithMenuShape`), and the diff's
 * module patch.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import { setModuleFormsInMenuAboveMutation } from "@/lib/doc/displayConditionMutations";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { type Mutation, mutationSchema } from "@/lib/doc/types";
import {
	type BlueprintDoc,
	defaultPostSubmitOf,
	effectivePostSubmit,
} from "@/lib/domain";
import { assertAdmittedDoc } from "./admittedDoc";

const VISITS = testUuid("visits");
const MODULE_FORM = testUuid("visit-module");
const PREVIOUS_FORM = testUuid("visit-previous");
const DEFAULT_FORM = testUuid("visit-default");

/** A top-level menu of patient follow-ups: one goes to its menu after
 *  submit, one to the previous screen, one by its default. */
function visitsDoc(): BlueprintDoc {
	const visit = (
		uuid: string,
		postSubmit: "module" | "previous" | undefined,
	) => ({
		uuid,
		name: uuid,
		type: "followup" as const,
		...(postSubmit !== undefined && { postSubmit }),
		fields: [{ kind: "text" as const, id: "note", label: "Note" }],
	});
	const doc = buildDoc({
		appName: "Visits",
		caseTypes: [{ name: "patient", properties: [] }],
		modules: [
			{
				uuid: "visits",
				name: "Visits",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					visit("visit-module", "module"),
					visit("visit-previous", "previous"),
					visit("visit-default", undefined),
				],
			},
		],
	});
	assertAdmittedDoc(doc);
	return doc;
}

function committed(doc: BlueprintDoc, mutations: Mutation[]): BlueprintDoc {
	const verdict = mutationCommitVerdict(
		doc,
		mutations,
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	expect(verdict.ok ? [] : verdict.findings).toEqual([]);
	return verdict.nextDoc;
}

/** The hop a durable mutation takes: `JSON.stringify` drops an
 *  `undefined`-valued key, so only a `null` clear survives it. */
function throughTheWire(mutation: Mutation): Mutation {
	return mutationSchema.parse(JSON.parse(JSON.stringify(mutation)));
}

describe("setModuleFormsInMenuAboveMutation", () => {
	it("sets the slot with true and clears it with a null the wire keeps", () => {
		expect(setModuleFormsInMenuAboveMutation(VISITS, true)).toMatchObject({
			kind: "updateModule",
			patch: { formsInMenuAbove: true },
		});
		const clear = throughTheWire(
			setModuleFormsInMenuAboveMutation(VISITS, false),
		);
		expect(clear).toMatchObject({ patch: { formsInMenuAbove: null } });
	});

	it("survives a serialization round trip both ways", () => {
		const doc = visitsDoc();
		const on = committed(doc, [
			throughTheWire(setModuleFormsInMenuAboveMutation(VISITS, true)),
		]);
		expect(on.modules[VISITS].formsInMenuAbove).toBe(true);
		const off = committed(on, [
			throughTheWire(setModuleFormsInMenuAboveMutation(VISITS, false)),
		]);
		expect(Object.hasOwn(off.modules[VISITS], "formsInMenuAbove")).toBe(false);
	});
});

describe("after submit, when a menu shows its forms on the app's first menu", () => {
	it("moves an explicit module or previous destination to the first menu", () => {
		const next = committed(visitsDoc(), [
			setModuleFormsInMenuAboveMutation(VISITS, true),
		]);
		expect(next.forms[MODULE_FORM].postSubmit).toBe("firstMenu");
		expect(next.forms[PREVIOUS_FORM].postSubmit).toBe("firstMenu");
	});

	it("leaves an absent after-submit absent for its new default", () => {
		const next = committed(visitsDoc(), [
			setModuleFormsInMenuAboveMutation(VISITS, true),
		]);
		expect(next.forms[DEFAULT_FORM].postSubmit).toBeUndefined();
		expect(defaultPostSubmitOf(next, DEFAULT_FORM)).toBe("firstMenu");
	});

	it("pins an absent after-submit whose destination is still offered when the default moves back", () => {
		const above = committed(visitsDoc(), [
			setModuleFormsInMenuAboveMutation(VISITS, true),
		]);
		expect(effectivePostSubmit(above, DEFAULT_FORM)).toBe("firstMenu");
		const own = committed(above, [
			throughTheWire(setModuleFormsInMenuAboveMutation(VISITS, false)),
		]);
		// The default is `previous` again, and the form keeps the first menu.
		expect(defaultPostSubmitOf(own, DEFAULT_FORM)).toBe("previous");
		expect(own.forms[DEFAULT_FORM].postSubmit).toBe("firstMenu");
	});

	it("survives the replay of its serialized batch", () => {
		const doc = visitsDoc();
		const batch = [setModuleFormsInMenuAboveMutation(VISITS, true)];
		const first = committed(doc, batch);
		const replayed = committed(doc, batch.map(throughTheWire));
		expect(replayed.forms).toEqual(first.forms);
		expect(replayed.modules).toEqual(first.modules);
	});
});

describe("the document diff", () => {
	it("carries the slot when it is set and when it is cleared", () => {
		const doc = visitsDoc();
		const above = committed(doc, [
			setModuleFormsInMenuAboveMutation(VISITS, true),
		]);
		const forward = diffDocsToMutations(doc, above);
		expect(
			forward.some(
				(mutation) =>
					mutation.kind === "updateModule" &&
					mutation.uuid === VISITS &&
					mutation.patch.formsInMenuAbove === true,
			),
		).toBe(true);
		expect(
			committed(doc, forward.map(throughTheWire)).modules[VISITS]
				.formsInMenuAbove,
		).toBe(true);

		const back = diffDocsToMutations(above, doc);
		expect(
			back.some(
				(mutation) =>
					mutation.kind === "updateModule" &&
					mutation.uuid === VISITS &&
					mutation.patch.formsInMenuAbove === null,
			),
		).toBe(true);
		const restored = committed(above, back.map(throughTheWire));
		expect(Object.hasOwn(restored.modules[VISITS], "formsInMenuAbove")).toBe(
			false,
		);
		expect(restored.forms).toEqual(doc.forms);
	});
});
