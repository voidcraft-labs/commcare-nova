import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { parseXPathForField, printXPathInDoc } from "@/lib/doc/expressionText";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { BlueprintDocStore } from "@/lib/doc/provider";
import type { Mutation } from "@/lib/doc/types";
import { fieldSchema, type XPathExpression } from "@/lib/domain";
import type { PersistableDoc } from "@/lib/domain/blueprint";
import { assertAdmittedPreviewDoc } from "../../../__tests__/fixtures/admittedDoc";

/** Fixture authoring follows the real text-to-identity bridge before admission.
 * The tests may write readable /data paths; a running app receives canonical ASTs. */
export function admittedControllerDoc(input: PersistableDoc): PersistableDoc {
	const doc = hydratePersistedBlueprint(structuredClone(input));
	for (const field of Object.values(doc.fields)) {
		const next = { ...field };
		for (const slot of [
			"calculate",
			"relevant",
			"required",
			"validate",
			"default_value",
			"repeat_count",
		] as const) {
			const expression = (
				field as unknown as Record<string, XPathExpression | undefined>
			)[slot];
			if (expression !== undefined)
				Object.assign(next, {
					[slot]: parseXPathForField(
						doc,
						field.uuid,
						printXPathInDoc(doc, expression),
					),
				});
		}
		doc.fields[field.uuid] = fieldSchema.parse(next);
	}
	assertAdmittedPreviewDoc(doc);
	return doc;
}

export function applyControllerEdit(
	store: BlueprintDocStore,
	mutations: Mutation[],
): void {
	const verdict = mutationCommitVerdict(
		store.getState(),
		mutations,
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	if (!verdict.ok)
		throw new Error(
			`Unreachable controller edit: ${JSON.stringify(verdict.findings)}`,
		);
	store.getState().applyMany(mutations);
}
