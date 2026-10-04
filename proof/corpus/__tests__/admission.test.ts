/**
 * Every document the corpus's producers build, and every workforce document
 * built over them, is admitted, and Nova's publish takes every one but the
 * two nested-menu scenarios HQ refuses.
 *
 * Contract: each corpus document is one Nova's stores hold and admit (the
 * strict schema, and full validation under its own Project's lookup data),
 * and the documents the emitter keeps are exactly those Nova's publish and
 * both export modes take. `../producers.ts` rebuilds the native producers'
 * documents from their fixture modules, copies the two specs the XML and
 * XPath producers build inline, and reads two search fixtures' lookup rows
 * back from their compiled blocks; the plausible failures are a fixture or
 * a copy drifting into a document no store would admit, a read-back row
 * that no longer matches its table, and a refusal other than the two the
 * plan leaves out (or one of those two becoming publishable), each of which
 * would otherwise surface only when the proof lane emits the corpus. The
 * workforce documents (`../workforce.ts`) add roles, personas, organization
 * levels, a place property, automations and a language to a producer
 * document; the plausible failure is an entity the commit gate admits but
 * Nova's publish or an export refuses, which would leave the document out
 * of the corpus and with it the only targets of five removal kinds. A small
 * fuzz sample is held to the same publish and export checks.
 */

import { describe, expect, it } from "vitest";
import { manifestFor } from "@/lib/commcare/__tests__/compilerEvidence";
import { runValidation } from "@/lib/commcare/validator/runner";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { blueprintDocSchema } from "@/lib/domain";
import { DEFAULT_CORPUS_SEED } from "../defaults";
import { type CorpusDocument, lookupContextOf } from "../documents";
import { publishFindings } from "../editBatches";
import { sampleFuzzDocuments } from "../fuzzSample";
import { producerDocuments } from "../producers";
import { exportFindings } from "../publish";
import { WORKFORCE_BASES, workforceDocuments } from "../workforce";

/** The two nested-menu scenarios whose HQ projection Nova's publish refuses. */
const REFUSED = new Set([
	"nested-menu-same-smaller",
	"nested-menu-parent-multiple",
]);

/** What Nova's admission, publish and two export modes say of one document, by finding code. */
async function verdicts(document: CorpusDocument) {
	const parsed = blueprintDocSchema.safeParse(document.doc);
	if (!parsed.success) {
		return { schema: parsed.error.message } as const;
	}
	const doc = hydratePersistedBlueprint(parsed.data);
	const codes = (findings: readonly { code: string }[]) =>
		[...new Set(findings.map((finding) => finding.code))].sort();
	const source = {
		id: document.id,
		doc: document.doc,
		compiledAtSeq: 1,
		...(document.lookup !== undefined && { lookup: document.lookup }),
		...(document.media !== undefined && { media: document.media }),
	};
	const validation = codes(
		runValidation(doc, lookupContextOf(document.lookup)),
	);
	const publish = codes(publishFindings(doc, document.lookup));
	// The capture's export boundary takes only a document Nova's publish
	// takes, as the emitter asks it (`../emitCorpus.ts::refusal`).
	if (validation.length > 0 || publish.length > 0) {
		return { validation, publish } as const;
	}
	return {
		validation,
		publish,
		hqUpload: codes(await exportFindings(source, "hq-upload")),
		ccz: codes(await exportFindings(source, "ccz")),
	} as const;
}

describe("the corpus's fixed and sampled documents", () => {
	it("are admitted, and Nova's publish and exports take all but the two nested-menu scenarios HQ refuses", {
		// About 160 documents through two export boundaries: a few seconds on
		// a laptop, and CI runners are slower.
		timeout: 60_000,
	}, async () => {
		const producers = producerDocuments();
		const workforce = workforceDocuments(producers);
		const sampled = sampleFuzzDocuments({
			size: 4,
			seed: DEFAULT_CORPUS_SEED,
			manifestFor,
		}).map((sample) => sample.document);
		const unexpected: string[] = [];
		const refused: string[] = [];
		for (const document of [...producers, ...workforce, ...sampled]) {
			const verdict = await verdicts(document);
			const accepted = {
				validation: [],
				publish: [],
				hqUpload: [],
				ccz: [],
			};
			if (REFUSED.has(document.id)) {
				refused.push(document.id);
				// Admitted, and refused only by the HQ projection.
				expect(verdict, document.id).toEqual({
					validation: [],
					publish: ["HQ_NESTED_SELECTION_UNREPRESENTABLE"],
				});
				continue;
			}
			if (JSON.stringify(verdict) !== JSON.stringify(accepted)) {
				unexpected.push(`${document.id}: ${JSON.stringify(verdict)}`);
			}
		}
		expect(unexpected).toEqual([]);
		expect(refused.sort()).toEqual([...REFUSED].sort());
		// Every family the native producers cover reaches the corpus.
		expect(producers.length).toBeGreaterThan(150);
		expect(workforce).toHaveLength(WORKFORCE_BASES.length);
		// Each holds what the five removal kinds remove, beyond its base.
		for (const document of workforce) {
			const doc = document.doc;
			expect(
				[
					doc.userPropertyOrder?.length,
					doc.userTypeOrder?.length,
					doc.personaOrder?.length,
					doc.locationPropertyOrder?.length,
					doc.automationOrder?.length,
				],
				document.id,
			).toEqual([1, 2, 2, 1, 2]);
		}
	});
});
