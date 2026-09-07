import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import AdmZip from "adm-zip";
import { afterAll, expect } from "vitest";
import type { BlueprintDoc } from "@/lib/domain";
import { compileCcz } from "../compiler";
import type { HqApplication } from "../types";

const destination = process.env.NOVA_EXPANDER_EVIDENCE_DIR;
const records = new Map<
	string,
	{ id: string; tests: string[]; localForms: string[] }
>();

/** Optional producer: only the caller's already-admitted documents reach here. */
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
		const filename = `${id}.${entry.entryName.replaceAll("/", ".")}`;
		localForms.push(filename);
		writeFileSync(resolve(destination, filename), entry.getData());
	}
	records.set(id, { id, tests: [test], localForms });
}

afterAll(() => {
	if (!destination) return;
	writeFileSync(
		resolve(destination, "manifest.json"),
		JSON.stringify([...records.values()], null, 2),
	);
});
