import { expect } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	evaluatePreparedMutationCandidate,
	prepareMutationCandidate,
} from "@/lib/doc/commitVerdicts";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import {
	LOOKUP_CONTEXT_UNAVAILABLE,
	type LookupValidationContext,
} from "@/lib/doc/lookupReferences";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import { type BlueprintDoc, blueprintDocSchema } from "@/lib/domain";

/** Assert reachability before a test describes a persisted application's behavior. */
export function expectAdmittedDoc(
	doc: BlueprintDoc,
	lookupContext: LookupValidationContext = LOOKUP_CONTEXT_UNAVAILABLE,
): BlueprintDoc {
	blueprintDocSchema.parse(toPersistableDoc(doc));
	const verdict = evaluatePreparedMutationCandidate(
		prepareMutationCandidate(doc, admitMutationBatch([])),
		lookupContext,
	);
	expect(
		verdict.ok,
		verdict.ok ? undefined : JSON.stringify(verdict.findings),
	).toBe(true);
	return doc;
}

export function surveyFixture() {
	return buildDoc({
		modules: [
			{
				name: "Survey",
				forms: [
					{
						name: "Intake",
						type: "survey",
						fields: [f({ id: "note", kind: "text", label: "Note" })],
					},
				],
			},
		],
	});
}
