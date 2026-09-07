import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import {
	LOOKUP_CONTEXT_UNAVAILABLE,
	type LookupValidationContext,
} from "@/lib/doc/lookupReferences";
import { type BlueprintDoc, blueprintDocSchema } from "@/lib/domain";

/** Reachable-app fixtures must pass the same schema and whole-document gate as
 * a user edit. Deliberately malformed low-level parser fixtures don't use this. */
export function assertAdmittedPreviewDoc(
	doc: BlueprintDoc,
	lookupContext: LookupValidationContext = LOOKUP_CONTEXT_UNAVAILABLE,
): BlueprintDoc {
	blueprintDocSchema.parse(toPersistableDoc(doc));
	const verdict = mutationCommitVerdict(
		structuredClone(doc),
		[{ kind: "setAppName", name: doc.appName }],
		lookupContext,
	);
	if (!verdict.ok)
		throw new Error(
			`Invalid Preview fixture: ${JSON.stringify(verdict.findings)}`,
		);
	return doc;
}
