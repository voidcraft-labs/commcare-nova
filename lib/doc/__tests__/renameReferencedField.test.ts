/**
 * Renaming a field's local id must stay free when something references it.
 *
 * That is the whole point of "references are identity, text is a projection":
 * a close condition stores the field's UUID, so changing the friendly `id`
 * rewrites nothing and can never invalidate the reference. If the gate refuses
 * this, a referenced field becomes unrenameable — which is the behaviour the
 * foundation exists to remove.
 *
 * The builder emits exactly the mutation asserted here
 * (`useBlueprintMutations`'s `renameField` → `updateField` with `patch.id`), so
 * a refusal here is the one an author would hit in the inspector.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { Mutation } from "@/lib/doc/types";
import { asUuid, plainColumn } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";

const MODULE = asUuid("11111111-1111-4111-8111-111111111111");
const FORM = asUuid("22222222-2222-4222-8222-222222222222");
const FIELD = asUuid("33333333-3333-4333-8333-333333333333");
const COLUMN = asUuid("44444444-4444-4444-8444-444444444444");

function docWithCloseConditionOn(fieldUuid: typeof FIELD) {
	const doc = buildDoc({
		caseTypes: [
			{
				name: "patient",
				properties: [
					{
						name: "case_name",
						label: proseText("Name"),
						data_type: "text",
					},
				],
			},
		],
		modules: [
			{
				uuid: MODULE,
				id: "patients",
				name: "Patients",
				caseType: "patient",
				caseListConfig: {
					columns: [plainColumn(COLUMN, "case_name", "Patient")],
					listColumnOrder: [COLUMN],
					detailColumnOrder: [COLUMN],
					searchInputs: [],
				},
				forms: [
					{
						uuid: FORM,
						id: "visit",
						name: "Visit",
						type: "close",
						closeCondition: {
							field: fieldUuid,
							operator: "=",
							answer: "yes",
						},
						fields: [
							f({
								uuid: fieldUuid,
								kind: "text",
								id: "first_name",
								label: proseText("First name"),
							}),
						],
					},
				],
			},
		],
	});
	return hydratePersistedBlueprint(toPersistableDoc(doc));
}

describe("renaming a field that a close condition references", () => {
	it("commits, because the condition holds the uuid and not the id", () => {
		const doc = docWithCloseConditionOn(FIELD);
		const rename: Mutation = {
			kind: "updateField",
			uuid: FIELD,
			targetKind: "text",
			patch: { id: "given_name" },
		} as Mutation;

		const verdict = mutationCommitVerdict(
			doc,
			[rename],
			LOOKUP_CONTEXT_UNAVAILABLE,
		);

		expect(
			verdict.ok,
			verdict.ok ? "" : JSON.stringify(verdict.findings, null, 2),
		).toBe(true);
		if (!verdict.ok) return;
		expect(verdict.nextDoc.fields[FIELD]?.id).toBe("given_name");
		// The reference still points at the same field, untouched.
		expect(verdict.nextDoc.forms[FORM]?.closeCondition?.field).toBe(FIELD);
	});
});
