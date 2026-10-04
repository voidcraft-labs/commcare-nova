import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import AdmZip from "adm-zip";
import { afterAll, expect } from "vitest";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import type { BlueprintDoc } from "@/lib/domain";
import { compileCcz } from "../compiler";
import type { HqApplication } from "../types";

const destination = process.env.NOVA_EXPANDER_EVIDENCE_DIR;
const records = new Map<
	string,
	{ id: string; tests: string[]; localForms: string[]; document: string }
>();

/**
 * Optional producer: only the caller's already-admitted documents reach here.
 * Beside the expansion it writes the document itself in its stored form
 * (`<id>.document.json`), which the proof corpus publishes and edits
 * (`proof/corpus/documents.ts::readExpanderCapture`); the manifest names each
 * document's file and the tests that expand it, first one first.
 */
export function captureExpanderEvidence(
	doc: BlueprintDoc,
	hq: HqApplication,
): void {
	if (!destination) return;
	mkdirSync(destination, { recursive: true });
	const id = createHash("sha256")
		.update(JSON.stringify(doc))
		.digest("hex")
		.slice(0, 20);
	const test = expect.getState().currentTestName ?? "unnamed";
	const existing = records.get(id);
	if (existing) {
		if (!existing.tests.includes(test)) existing.tests.push(test);
		return;
	}
	const zip = new AdmZip(compileCcz(hq, doc.appName, doc));
	const document = `${id}.document.json`;
	writeFileSync(
		resolve(destination, document),
		JSON.stringify({ doc: toPersistableDoc(doc) }),
	);
	writeFileSync(resolve(destination, `${id}.json`), JSON.stringify(hq));
	writeFileSync(
		resolve(destination, `${id}.suite.xml`),
		zip.readAsText("suite.xml"),
	);
	writeFileSync(
		resolve(destination, `${id}.app_strings.txt`),
		zip.readAsText("en/app_strings.txt"),
	);
	const localForms: string[] = [];
	for (const entry of zip.getEntries()) {
		if (
			!entry.entryName.startsWith("modules-") ||
			!entry.entryName.endsWith(".xml")
		)
			continue;
		const formPath = /^modules-(\d+)\/forms-(\d+)\.xml$/.exec(entry.entryName);
		if (!formPath)
			throw new Error(`Unexpected form archive path: ${entry.entryName}`);
		// Construct the output name from numeric coordinates; archive paths
		// never become filesystem paths, even in the optional evidence producer.
		const filename = `${id}.modules-${Number(formPath[1])}.forms-${Number(formPath[2])}.xml`;
		localForms.push(filename);
		writeFileSync(resolve(destination, filename), entry.getData());
	}
	records.set(id, { id, tests: [test], localForms, document });
}

afterAll(() => {
	if (!destination) return;
	writeFileSync(
		resolve(destination, "manifest.json"),
		JSON.stringify([...records.values()], null, 2),
	);
});
