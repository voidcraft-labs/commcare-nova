// components/builder/case-operations/__tests__/seeds.test.ts
//
// Adding a change lands one the validator already accepts.
//
// The app is valid by construction, so "born valid" cannot be a hope
// about the seed shapes — it has to be proved against the same commit
// gate the dispatch runs through. Each seed goes through
// `mutationCommitVerdict` here for exactly that reason; a seed that
// forgets a required facet fails this test rather than the author.

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { addCaseOperationMutations } from "@/lib/doc/caseOperationMutations";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { asUuid } from "@/lib/doc/types";
import type { BlueprintDoc, CaseOperation } from "@/lib/domain";
import {
	actionChangeLosses,
	type CaseOperationSeedKind,
	nextLinkIdentifier,
	nextOperationId,
	reshapeForAction,
	seedCaseOperation,
	takenOperationIds,
} from "../seeds";

const NAME = asUuid("44444444-4444-4444-8444-444444444444");

/** A seed carries no lookup carrier, so the explicit no-snapshot context
 *  is the honest one — the same one every client-side gate passes. */
const NO_LOOKUPS = LOOKUP_CONTEXT_UNAVAILABLE;

/** A case-first module: every form loads a case, so a change may act on
 *  "the case this form opened". */
function caseFirstDoc(): {
	doc: BlueprintDoc;
	formUuid: ReturnType<typeof asUuid>;
} {
	const doc = buildDoc({
		caseTypes: [
			{ name: "patient", properties: [{ name: "nickname", label: "Nick" }] },
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				forms: [
					{
						name: "Edit",
						type: "followup",
						fields: [
							f({
								uuid: NAME,
								kind: "text",
								id: "nickname",
								label: "Nickname",
								case_property_on: "patient",
							}),
						],
					},
				],
			},
		],
	});
	const moduleUuid = doc.moduleOrder[0];
	return { doc, formUuid: doc.formOrder[moduleUuid][0] };
}

function commits(
	doc: BlueprintDoc,
	formUuid: ReturnType<typeof asUuid>,
	operation: CaseOperation,
) {
	return mutationCommitVerdict(
		doc,
		addCaseOperationMutations(doc, formUuid, operation),
		NO_LOOKUPS,
	);
}

describe("case-operation seeds", () => {
	const seeds: readonly CaseOperationSeedKind[] = [
		{ kind: "create", caseType: "referral" },
		{ kind: "update-session", caseType: "patient" },
		{ kind: "close-session", caseType: "patient" },
	];

	for (const seed of seeds) {
		it(`"${seed.kind}" is accepted by the commit gate as-is`, () => {
			const { doc, formUuid } = caseFirstDoc();
			const verdict = commits(
				doc,
				formUuid,
				seedCaseOperation(seed, new Set()),
			);
			expect(verdict.ok).toBe(true);
		});
	}

	it("declares a brand-new case type in the same batch", () => {
		// The create seed may name a type the catalog has never seen; the
		// batch has to bring it with it, or the gate refuses an unknown type.
		const { doc, formUuid } = caseFirstDoc();
		const mutations = addCaseOperationMutations(
			doc,
			formUuid,
			seedCaseOperation({ kind: "create", caseType: "referral" }, new Set()),
		);
		expect(mutations.some((m) => m.kind === "declareCaseType")).toBe(true);
	});

	it("gives every change a distinct, readable id", () => {
		const first = seedCaseOperation(
			{ kind: "create", caseType: "referral" },
			new Set(),
		);
		const second = seedCaseOperation(
			{ kind: "create", caseType: "referral" },
			takenOperationIds([first]),
		);
		expect(first.id).toBe("create_referral");
		expect(second.id).toBe("create_referral_2");
		expect(first.uuid).not.toBe(second.uuid);
	});

	it("makes an id legal whatever the case type is called", () => {
		expect(nextOperationId("create_2_way", new Set())).toBe("create_2_way");
		expect(nextOperationId("9lives", new Set())).toBe("lives");
		expect(nextOperationId("!!!", new Set())).toBe("change");
	});

	it("keeps link identifiers unique inside one change", () => {
		expect(nextLinkIdentifier(new Set())).toBe("parent");
		expect(nextLinkIdentifier(new Set(["parent"]))).toBe("parent_2");
		expect(nextLinkIdentifier(new Set(["parent", "parent_2"]))).toBe(
			"parent_3",
		);
	});
});

describe("changing what a change does", () => {
	const create = seedCaseOperation(
		{ kind: "create", caseType: "patient" },
		new Set(),
	);

	it("drops exactly the facets the destination action forbids", () => {
		const asClose = reshapeForAction(create, "close", { kind: "session" });
		// Close forbids a new target, a name, an owner, a rename, a retype,
		// and links — and keeps its writes, so "record and close" is one change.
		expect(asClose.action).toBe("close");
		expect(asClose.target).toEqual({ kind: "session" });
		expect(asClose.name).toBeUndefined();
		expect("name" in asClose).toBe(false);
	});

	it("still passes the gate after the change of action", () => {
		const { doc, formUuid } = caseFirstDoc();
		for (const action of ["update", "close"] as const) {
			const reshaped = reshapeForAction(create, action, { kind: "session" });
			expect(commits(doc, formUuid, reshaped).ok).toBe(true);
		}
	});

	it("names what the author would lose, so the confirmation can say it", () => {
		expect(actionChangeLosses(create, "close")).toContain(
			"the new case it makes",
		);
		expect(actionChangeLosses(create, "close")).toContain("the name it sets");
		// Nothing is lost turning a plain session update into a close.
		const update = seedCaseOperation(
			{ kind: "update-session", caseType: "patient" },
			new Set(),
		);
		expect(actionChangeLosses(update, "close")).toEqual([]);
	});
});
