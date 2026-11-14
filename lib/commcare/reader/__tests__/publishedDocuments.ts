/**
 * The documents the proof lane publishes, and how a publish expands each, shared by the
 * yardsticks that read them back (`targetedReadBack.test.ts`) and that print the canonical
 * rows' members (`canonicalRowsKeepExport.test.ts`).
 */
import { manifestFor } from "@/lib/commcare/__tests__/compilerEvidence";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { ensureReferenceIndex } from "@/lib/doc/referenceIndex";
import { type BlueprintDoc, blueprintDocSchema } from "@/lib/domain";
import type { CorpusDocument } from "@/proof/corpus/documents";
import { publishFindings } from "@/proof/corpus/editBatches";
import { producerDocuments } from "@/proof/corpus/producers";
import { targetedDocuments } from "@/proof/targeted/index";
import type { ExpandOptions } from "../../expander";
import { type LookupWireNaming, lookupWireNaming } from "../../lookup/naming";

export const PUBLISH_ORIGIN = "https://india.commcarehq.org";
export const PUBLISH_DOMAIN = "clinic";

/** Every targeted proof document and every producer document of the corpus. */
export function publishedCorpus(): CorpusDocument[] {
	return [...targetedDocuments(), ...producerDocuments()];
}

/** The stored document as Nova's load boundary hydrates it. */
export function hydrated(document: CorpusDocument): BlueprintDoc {
	const doc = hydratePersistedBlueprint(blueprintDocSchema.parse(document.doc));
	ensureReferenceIndex(doc);
	return doc;
}

/** Whether Nova's publish refuses the document, so it never reaches CommCare HQ. */
export function publishRefuses(
	document: CorpusDocument,
	doc: BlueprintDoc,
): boolean {
	return publishFindings(doc, document.lookup).length > 0;
}

/**
 * What a publish hands the emitter for one document: the project space's attachment target,
 * the media its assets give and the table names its Project data gives.
 */
export function publishExpansion(
	document: CorpusDocument,
	doc: BlueprintDoc,
): {
	readonly options: ExpandOptions;
	readonly manifest: ReturnType<typeof manifestFor>;
	readonly naming: LookupWireNaming | undefined;
} {
	const manifest = manifestFor(doc);
	const naming =
		document.lookup === undefined
			? undefined
			: lookupWireNaming(document.lookup.definitions);
	return {
		manifest,
		naming,
		options: {
			attachmentTarget: { origin: PUBLISH_ORIGIN, domain: PUBLISH_DOMAIN },
			...(manifest.size > 0 && { assets: manifest }),
			...(naming !== undefined && { lookupNaming: naming }),
		},
	};
}
