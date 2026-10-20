/**
 * The head emitter's output is a fixed point of the frozen census
 * normalizer over the corpus (part 09 §7): every XPath the head serializer
 * prints in an XForm, the suite or the HQ app JSON is already the
 * normalizer's canonical spelling, and every instance it declares is read.
 *
 * The plausible failure is a respelling the serializer makes that the
 * normalizer does not (a space, a parenthesis, a quote, a number's digits),
 * or an unread declaration the derived declarations keep. Either would make
 * the census compare a spelling the normalizer cannot see through, so a
 * difference in the census would read as a change of meaning, or a real
 * change could hide behind one. The observation is each emitted file beside
 * its normalization, the only difference allowed being the normalizer's own
 * serialization (attribute order, the suite's fixture data dropped).
 *
 * The documents are the corpus the proof tests build in process: the
 * producers' documents, the workforce documents over them, the targeted
 * documents and the fuzz sample at the corpus's seed, each emitted through
 * the census's own head emission. The expander corpus is written only by
 * `expander.test.ts` as a Vitest writer, so it is not built here.
 */

import { type Document, type Element, isTag } from "domhandler";
import { removeElement } from "domutils";
import { describe, expect, it } from "vitest";
import { manifestFor } from "@/lib/commcare/__tests__/compilerEvidence";
import { serializeXml } from "@/lib/commcare/serializeXml";
import { parseXml } from "@/lib/commcare/xmlParse";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import {
	DEFAULT_CORPUS_SEED,
	DEFAULT_SAMPLE_SIZE,
} from "../../../../proof/corpus/defaults";
import type { CorpusDocument } from "../../../../proof/corpus/documents";
import { sampleFuzzDocuments } from "../../../../proof/corpus/fuzzSample";
import { producerDocuments } from "../../../../proof/corpus/producers";
import { workforceDocuments } from "../../../../proof/corpus/workforce";
import { targetedDocuments } from "../../../../proof/targeted/index";
import { emitCensusFiles } from "../census";
import {
	normalizeHqApplication,
	normalizeSuite,
	normalizeXForm,
} from "../emissionNormal";

/** The normalizer's own serialization of a file, with nothing else changed. */
function serializedAsNormalized(
	xml: string,
	edit?: (doc: Document) => void,
): string {
	const doc = parseXml(xml);
	edit?.(doc);
	const visit = (element: Document | Element) => {
		for (const child of element.children) {
			if (!isTag(child)) continue;
			child.attribs = Object.fromEntries(
				Object.entries(child.attribs).sort(([a], [b]) =>
					a < b ? -1 : a > b ? 1 : 0,
				),
			);
			visit(child);
		}
	};
	visit(doc);
	return serializeXml(doc);
}

/** The suite as the normalizer writes it when it changes no slot: its fixture data dropped. */
function suiteAsNormalized(xml: string): string {
	return serializedAsNormalized(xml, (doc) => {
		for (const root of doc.children) {
			if (!isTag(root)) continue;
			for (const child of [...root.children]) {
				if (isTag(child) && child.name === "fixture") removeElement(child);
			}
		}
	});
}

function corpus(): CorpusDocument[] {
	const producers = producerDocuments();
	return [
		...producers,
		...workforceDocuments(producers),
		...targetedDocuments(),
		...sampleFuzzDocuments({
			size: DEFAULT_SAMPLE_SIZE,
			seed: DEFAULT_CORPUS_SEED,
			manifestFor,
		}).map((sampled) => sampled.document),
	];
}

describe("the head emission is a fixed point of the census normalizer", () => {
	it("tells a respelled XPath and an unread declaration from the normalizer's own serialization", () => {
		const form = (bind: string, instances = "") =>
			`<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms"><h:head><model><instance><data xmlns="urn:nova:test"><a/></data></instance>${instances}${bind}</model></h:head><h:body/></h:html>`;
		const canonical = form('<bind nodeset="/data/a" calculate="1 + 2"/>');
		expect(normalizeXForm(canonical)).toBe(serializedAsNormalized(canonical));
		const respelled = form('<bind nodeset="/data/a" calculate="(1+2)"/>');
		expect(normalizeXForm(respelled)).not.toBe(
			serializedAsNormalized(respelled),
		);
		const unread = form(
			'<bind nodeset="/data/a" calculate="1 + 2"/>',
			'<instance id="casedb" src="jr://instance/casedb"/>',
		);
		expect(normalizeXForm(unread)).not.toBe(serializedAsNormalized(unread));
	});

	// Emits and normalizes every corpus document: under 3 seconds alone on a
	// laptop, near 9 beside other suites, and slower again on a CI runner.
	it("over every corpus document's XForms, suite and HQ app JSON", {
		timeout: 60_000,
	}, () => {
		const moved: string[] = [];
		let emitted = 0;
		for (const document of corpus()) {
			const { hqApp, localFiles } = emitCensusFiles(
				hydratePersistedBlueprint(document.doc),
				document.lookup?.definitions ?? [],
			);
			emitted++;
			for (const [name, contents] of localFiles) {
				const expected =
					name === "suite.xml"
						? suiteAsNormalized(contents)
						: serializedAsNormalized(contents);
				const normalized =
					name === "suite.xml"
						? normalizeSuite(contents)
						: normalizeXForm(contents);
				if (normalized !== expected) moved.push(`${document.id} local/${name}`);
			}
			const app = JSON.parse(JSON.stringify(hqApp)) as {
				_attachments?: Record<string, string>;
			};
			const attachments = app._attachments ?? {};
			const normalized = normalizeHqApplication(app) as {
				_attachments?: Record<string, string>;
			};
			for (const [name, xml] of Object.entries(attachments)) {
				if (normalized._attachments?.[name] !== serializedAsNormalized(xml))
					moved.push(`${document.id} hq/${name}`);
			}
			const withoutAttachments = (value: object) =>
				JSON.stringify({ ...value, _attachments: undefined });
			if (withoutAttachments(normalized) !== withoutAttachments(app))
				moved.push(`${document.id} hq/app.json`);
		}
		expect(emitted).toBeGreaterThan(100);
		expect(moved).toEqual([]);
	});
});
