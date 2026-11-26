// This entry runs in the archived source release. It consumes only read-only
// row evidence and uses that release's parser, empty base and reducer.
import { produce } from "immer";
import { foldCanonicalAppChangeSuffixBounded } from "@/lib/db/canonicalMutationFold";
import {
	assemblePersistedBlueprintJsonText,
	parsePersistedMutationBatchText,
} from "@/lib/db/persistedJson";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import { applyMutations } from "@/lib/doc/mutations";
import { emptyBlueprintDoc } from "@/lib/doc/scaffolds";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";

export { readLookupDefinitionsInTransaction as releasedLookups } from "@/lib/lookup/definitionSnapshot";

export function privateBase(input) {
	if (input.kind === "genesis") {
		return {
			snapshot: toPersistableDoc(emptyBlueprintDoc(input.appId)),
			projectId: input.projectId,
		};
	}
	return foldCanonicalAppChangeSuffixBounded(input.canonical);
}

export function privateStep(text, digest) {
	const batch = parsePersistedMutationBatchText(text, "source authoring step");
	if (canonicalJsonDigest(batch) !== digest)
		throw new Error("A private step does not match its original receipt.");
	return batch;
}

export function privateOverlay(snapshot, prefix) {
	const batch = parsePersistedMutationBatchText(
		JSON.stringify(prefix),
		"source authoring replay",
	);
	return toPersistableDoc(
		produce(hydratePersistedBlueprint(snapshot), (draft) => {
			applyMutations(draft, batch);
		}),
	);
}

export function readCarriers(appId, root, entities) {
	return assemblePersistedBlueprintJsonText(appId, root, entities);
}
