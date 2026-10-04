/**
 * The corpus's fixed-seed sample of the compiler fuzz generators.
 *
 * The two generators are the XForm oracle's
 * (`lib/commcare/__tests__/xformDocArbitrary.ts::blueprintDocArbitrary`) and
 * the suite oracle's (`suiteDocArbitrary.ts::suiteDocArbitrary`). Each draw
 * is taken as its fuzz test takes it: the suite fuzz makes the second module
 * a child of the first after drawing (`suiteOracle.fuzz.test.ts`), so the
 * sample does the same. A draw is then read as Nova's load boundary reads a
 * stored document (`hydratePersistedBlueprint` over the strict schema's
 * parse), and must pass full validation.
 *
 * The media each draw references is uploaded with the bytes the compiler
 * fuzz publishes (`compilerEvidence.ts::manifestFor`), passed in as
 * `manifestFor` because that module imports Vitest, which loads only inside
 * Vitest's runner.
 *
 * `fc.sample` draws from one random stream per seed, so a generator's first
 * k draws of n are its draws of k: a document's id (generator, seed, index)
 * names the same document whatever the sample's size.
 */

import * as fc from "fast-check";
import { suiteDocArbitrary } from "@/lib/commcare/__tests__/suiteDocArbitrary";
import { blueprintDocArbitrary } from "@/lib/commcare/__tests__/xformDocArbitrary";
import type { AssetManifest } from "@/lib/commcare/multimedia/assetWirePath";
import { runValidation } from "@/lib/commcare/validator/runner";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { type BlueprintDoc, blueprintDocSchema } from "@/lib/domain";
import {
	type CorpusDocument,
	FUZZ_GENERATORS,
	type FuzzGenerator,
	fuzzDocumentId,
	fuzzSplit,
	storedDocument,
	uploadedMedia,
} from "./documents";

/** The media manifest the compiler fuzz builds for a document. */
export type ManifestFor = (doc: BlueprintDoc) => AssetManifest;

const ARBITRARIES: Record<FuzzGenerator, fc.Arbitrary<BlueprintDoc>> = {
	xform: blueprintDocArbitrary,
	suite: suiteDocArbitrary,
};

/** The suite fuzz's own step after each draw: the second module nests under the first. */
function afterDraw(generator: FuzzGenerator, doc: BlueprintDoc): BlueprintDoc {
	if (generator !== "suite") return doc;
	const [root, child] = doc.moduleOrder;
	const childModule = child === undefined ? undefined : doc.modules[child];
	if (root !== undefined && childModule !== undefined) {
		childModule.parentModuleUuid = root;
	}
	return doc;
}

/** A draw as Nova's load boundary reads it, refused when it is not admitted. */
function admitted(id: string, raw: BlueprintDoc): BlueprintDoc {
	const parsed = blueprintDocSchema.safeParse(toPersistableDoc(raw));
	if (!parsed.success) {
		throw new Error(
			`Fuzz document ${id} does not parse under Nova's strict blueprint schema: ${parsed.error.message}`,
		);
	}
	const doc = hydratePersistedBlueprint(parsed.data);
	const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
	if (findings.length > 0) {
		throw new Error(
			`Fuzz document ${id} parses but full validation reports ${findings.map((f) => f.code).join(", ")}. The fuzz generators construct admitted documents, so this is a generator or validator defect.`,
		);
	}
	return doc;
}

/** One sampled document, and how long drawing and admitting it took. */
export interface SampledDocument {
	readonly document: CorpusDocument;
	readonly generator: FuzzGenerator;
	readonly index: number;
	readonly milliseconds: number;
}

/**
 * The first `size` documents of the fixed-seed sample (`fuzzSplit` says how
 * many from each generator), each admitted, with its uploaded media.
 */
export function sampleFuzzDocuments(options: {
	readonly size: number;
	readonly seed: number;
	readonly manifestFor: ManifestFor;
}): SampledDocument[] {
	const { size, seed, manifestFor } = options;
	if (!Number.isSafeInteger(size) || size < 0) {
		throw new Error(`The fuzz sample's size is a whole number; got ${size}.`);
	}
	if (!Number.isSafeInteger(seed)) {
		throw new Error(`The fuzz sample's seed is a whole number; got ${seed}.`);
	}
	const split = fuzzSplit(size);
	const sampled: SampledDocument[] = [];
	for (const generator of FUZZ_GENERATORS) {
		const count = split[generator];
		if (count === 0) continue;
		const draws = fc.sample(ARBITRARIES[generator], { seed, numRuns: count });
		for (const [index, raw] of draws.entries()) {
			const started = performance.now();
			const id = fuzzDocumentId(generator, seed, index);
			const doc = admitted(id, afterDraw(generator, raw));
			const media = uploadedMedia(manifestFor(doc));
			sampled.push({
				document: {
					id,
					source: { kind: "fuzz", generator, seed, index },
					doc: storedDocument(doc),
					...(media !== undefined && { media }),
				},
				generator,
				index,
				milliseconds: performance.now() - started,
			});
		}
	}
	return sampled;
}
