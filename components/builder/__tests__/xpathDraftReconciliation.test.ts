/**
 * Draft reconciliation over pairs of documents: the open editor's draft,
 * printed under the document it started from, against the document a peer's
 * edit produced (applied through the production reducer). The plausible
 * failures: a renamed identity left in its old spelling (which would then
 * parse as something else or not at all), the person's own spacing or
 * additions overwritten, and a change to the stored expression itself
 * silently merged into the draft.
 */

import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { reconcileXPathDraft } from "@/components/builder/xpathDraftReconciliation";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { buildExpressionEditorContext } from "@/lib/codemirror/expressionEditorContext";
import { projectFormExpression } from "@/lib/doc/expressionText";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { applyMutations } from "@/lib/doc/mutations";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc } from "@/lib/domain";
import type { ExpressionSlotRef } from "@/lib/domain/expression/types";
import { proseText } from "@/lib/domain/prose";

const ATTENDING = testUuid("reconcile-attending");
const YES = testUuid("reconcile-yes");
const NO = testUuid("reconcile-no");
const GROUP = testUuid("reconcile-group");
const BEE = testUuid("reconcile-bee");
const CALC = testUuid("reconcile-calc");
const REGION = testUuid("reconcile-region");

const SLOT: ExpressionSlotRef = {
	entity: "field",
	uuid: CALC,
	slot: "relevant",
};

function fixture(relevant = "../a = 'yes'"): BlueprintDoc {
	return buildDoc(
		{
			modules: [
				{
					name: "Visits",
					forms: [
						{
							name: "Visit",
							type: "survey",
							fields: [
								f({
									uuid: ATTENDING,
									id: "a",
									kind: "single_select",
									label: "Attending",
									options: [
										{ uuid: YES, value: "yes", label: "Yes" },
										{ uuid: NO, value: "no", label: "No" },
									],
								}),
								f({ uuid: BEE, id: "b", kind: "text", label: "Bee" }),
								f({
									uuid: GROUP,
									id: "grp",
									kind: "group",
									label: "Group",
									children: [],
								}),
								f({ uuid: CALC, id: "calc", kind: "hidden", relevant }),
							],
						},
					],
				},
			],
		},
		(doc) => {
			doc.userProperties = {
				[REGION]: { uuid: REGION, slug: "region", label: "Region" },
			};
			doc.userPropertyOrder = [REGION];
		},
	);
}

function apply(doc: BlueprintDoc, ...mutations: Mutation[]): BlueprintDoc {
	return produce(doc, (draft) => {
		applyMutations(draft, mutations);
	});
}

const renameField = (uuid: string, id: string): Mutation =>
	({
		kind: "updateField",
		uuid,
		targetKind: uuid === ATTENDING ? "single_select" : "text",
		patch: { id },
	}) as Mutation;

function scope(doc: BlueprintDoc) {
	const context = buildExpressionEditorContext(
		doc,
		SLOT,
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	if (context === undefined) throw new Error("The slot has no context");
	return context.scope;
}

function shown(doc: BlueprintDoc): string {
	const field = doc.fields[CALC];
	const stored = "relevant" in field ? field.relevant : undefined;
	if (stored === undefined) return "";
	return projectFormExpression(doc, SLOT, stored, "unavailable", {
		layout: true,
	}).text;
}

/** The editor's reconciliation when `after` replaces `before` under a draft. */
function reconcile(before: BlueprintDoc, after: BlueprintDoc, draft: string) {
	return reconcileXPathDraft({
		base: shown(before),
		incoming: shown(after),
		draft,
		baseScope: scope(before),
		incomingScope: scope(after),
	});
}

describe("reconcileXPathDraft", () => {
	it("moves a clean draft to the incoming text", () => {
		const before = fixture();
		const after = apply(before, renameField(ATTENDING, "c"));
		expect(reconcile(before, after, shown(before))).toEqual({
			base: "../c = 'yes'",
			draft: "../c = 'yes'",
			conflict: false,
		});
	});

	it("respells a renamed question in the person's draft and keeps their spacing and additions", () => {
		const before = fixture();
		const after = apply(before, renameField(ATTENDING, "c"));
		expect(
			reconcile(before, after, "../a  =  'yes' and #form/a != 'no'"),
		).toEqual({
			base: "../c = 'yes'",
			draft: "../c  =  'yes' and #form/c != 'no'",
			conflict: false,
		});
	});

	it("respells an identity only the draft reads, while the shown text stays the same", () => {
		const before = fixture();
		const after = apply(before, renameField(BEE, "d"));
		expect(shown(after)).toBe(shown(before));
		expect(reconcile(before, after, "../a = 'yes' and ../b = 'x'")).toEqual({
			base: "../a = 'yes'",
			draft: "../a = 'yes' and ../d = 'x'",
			conflict: false,
		});
	});

	it("follows a move in a relative spelling", () => {
		const before = fixture();
		const after = apply(before, {
			kind: "moveField",
			uuid: BEE,
			toParentUuid: GROUP,
			after: null,
		} as Mutation);
		expect(reconcile(before, after, "../a = 'yes' and ../b = 'x'")).toEqual({
			base: "../a = 'yes'",
			draft: "../a = 'yes' and ../grp/b = 'x'",
			conflict: false,
		});
	});

	it("respells a worker-information slug and a choice's value", () => {
		const before = fixture();
		const after = apply(
			before,
			{
				kind: "updateUserProperty",
				uuid: REGION,
				patch: { slug: "district" },
			} as Mutation,
			{
				kind: "updateOption",
				fieldUuid: ATTENDING,
				uuid: YES,
				option: { uuid: YES, value: "y", label: proseText("Yes") },
			} as Mutation,
		);
		expect(
			reconcile(before, after, "../a = 'yes' and #user/region = 'north'"),
		).toEqual({
			base: "../a = 'y'",
			draft: "../a = 'y' and #user/district = 'north'",
			conflict: false,
		});
	});

	it("conflicts when the stored expression itself changed", () => {
		const before = fixture();
		const after = fixture("../a = 'no'");
		expect(reconcile(before, after, "../a = 'yes' and ../b = 'x'")).toEqual({
			base: "../a = 'no'",
			draft: "../a = 'yes' and ../b = 'x'",
			conflict: true,
		});
	});

	it("conflicts on a draft that does not parse when the shown text changed, and leaves it to the linter otherwise", () => {
		const before = fixture();
		const renamed = apply(before, renameField(ATTENDING, "c"));
		expect(reconcile(before, renamed, "../a = 'yes' and (")).toEqual({
			base: "../c = 'yes'",
			draft: "../a = 'yes' and (",
			conflict: true,
		});
		const unrelated = apply(before, renameField(BEE, "d"));
		expect(reconcile(before, unrelated, "../a = 'yes' and (")).toEqual({
			base: "../a = 'yes'",
			draft: "../a = 'yes' and (",
			conflict: false,
		});
	});

	it("conflicts when a read the draft makes is gone from the new document", () => {
		const before = fixture();
		const after = apply(before, renameField(ATTENDING, "c"), {
			kind: "removeField",
			uuid: BEE,
		} as Mutation);
		expect(reconcile(before, after, "../a = 'yes' and ../b = 'x'")).toEqual({
			base: "../c = 'yes'",
			draft: "../a = 'yes' and ../b = 'x'",
			conflict: true,
		});
	});

	it("keeps a conflict once it is observed", () => {
		const before = fixture();
		const after = apply(before, renameField(ATTENDING, "c"));
		expect(
			reconcileXPathDraft({
				base: shown(before),
				incoming: shown(after),
				draft: "../a = 'yes' and ../b = 'x'",
				baseScope: scope(before),
				incomingScope: scope(after),
				conflict: true,
			}),
		).toEqual({
			base: "../c = 'yes'",
			draft: "../a = 'yes' and ../b = 'x'",
			conflict: true,
		});
	});
});
