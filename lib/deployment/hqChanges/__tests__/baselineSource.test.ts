/**
 * A stored baseline reads to the document its read gave.
 *
 * Contract: for every source CommCare HQ answered that the proof lane
 * retained under `proof/hq-reads/` (each body that is an `Application`), the
 * production reader, given the same project data, media index and app
 * strings and a fresh minting resolver each time, gives the same outcome for
 * the source as a review reads it (`inStoredKeyOrder`) and for
 * `sourceFromBaseline(JSON.parse(normalizeHqAppSource(raw).text))`, the
 * value a baseline stores: the same document, facts and declarations where
 * it reads clean, the same findings where it gives an account. The retained
 * sources hold almost no map of several keys out of code-unit order, so the
 * same holds over Nova's own export of an app whose operations write out
 * of that order.
 *
 * Plausible failure: the reader reads a value that belongs to one read (a
 * form id CommCare HQ minted for it) into the document or its facts, so a
 * baseline read beside a fresh read differs where nothing changed; the
 * normalization drops a key the reader reads; or the reader reads a map in
 * its key order, which the stored text sorts.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { recordDialectRoundTrip } from "@/lib/agent/authoring/recordRoundTrip";
import type { HqAppSource } from "@/lib/commcare/hq/appSource";
import {
	type ReaderInput,
	type ReadOutcome,
	readHqApp,
} from "@/lib/commcare/reader";
import { sourceFromBody } from "@/lib/commcare/reader/__tests__/readerInput";
import { mintingResolver } from "@/lib/commcare/reader/identity";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import type { BlueprintDoc } from "@/lib/domain";
import type { LookupRevision } from "@/lib/lookup/types";
import { normalizeHqAppSource } from "../../hqSourceBaseline";
import { servedExport } from "../../reading/__tests__/novaReading";
import { readingAppStrings } from "../../reading/appStrings";
import {
	alignedFromSource,
	inStoredKeyOrder,
	sourceFromBaseline,
} from "../baselineSource";

const ROOT = join(process.cwd(), "proof", "hq-reads");

/** A clinic whose registration saves, and whose follow-up loads and saves, three properties out
 *  of code-unit order. */
function outOfOrder(): BlueprintDoc {
	const properties = ["zeta", "alpha", "mid"];
	return buildDoc({
		appId: APP_ID,
		appName: "Clinic",
		caseTypes: [
			{
				name: "patient",
				properties: properties.map((name) => ({ name, label: name })),
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				forms: [
					{
						name: "Register",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "name",
								label: "Name",
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
							...properties.map((property) =>
								f({
									kind: "text",
									id: property,
									label: property,
									caseWrite: { caseType: "patient", property },
								}),
							),
						],
					},
					{
						name: "Visit",
						type: "followup",
						fields: properties.map((property) =>
							f({
								kind: "text",
								id: property,
								label: property,
								default_value: {
									kind: "term",
									term: { kind: "form-case", caseType: "patient", property },
								},
								caseWrite: { caseType: "patient", property },
							}),
						),
					},
				],
			},
		],
	});
}
const APP_ID = "baseline-source-app";

function jsonFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return jsonFiles(path);
		return name.endsWith(".json") ? [path] : [];
	});
}

/** Every retained answer whose body is an app's source, by its path under `proof/hq-reads/`. */
function retainedSources(): { name: string; body: Record<string, unknown> }[] {
	return jsonFiles(ROOT)
		.sort()
		.flatMap((path) => {
			const raw = JSON.parse(readFileSync(path, "utf8")) as {
				body?: unknown;
			};
			const value =
				typeof raw.body === "string"
					? (() => {
							try {
								return JSON.parse(raw.body as string) as unknown;
							} catch {
								return undefined;
							}
						})()
					: raw.body;
			if (
				typeof value !== "object" ||
				value === null ||
				Array.isArray(value) ||
				(value as Record<string, unknown>).doc_type !== "Application"
			)
				return [];
			return [
				{
					name: relative(ROOT, path),
					body: value as Record<string, unknown>,
				},
			];
		});
}

function inputFor(source: HqAppSource): ReaderInput {
	return {
		appId: APP_ID,
		target: { origin: "https://india.commcarehq.org", domain: "clinic" },
		source,
		modules: alignedFromSource(source),
		resolver: mintingResolver(APP_ID),
		lookup: { table: () => undefined, definitions: new Map() },
		organization: { levelCodes: [], levels: [] },
		media: { resolve: () => ({ kind: "no-entry" }) },
		appStrings: readingAppStrings({
			kind: "available",
			projectId: "project-1",
			projectRevision: "0" as LookupRevision,
			definitions: [],
		}),
		recordDialect: recordDialectRoundTrip,
	};
}

/** What of an outcome a review reads: the document, its facts and its declarations, or the
 *  findings of an account. */
function compared(outcome: ReadOutcome): unknown {
	if (outcome.kind === "account")
		return { kind: "account", findings: outcome.findings };
	return {
		kind: "read",
		doc: toPersistableDoc(outcome.draft.doc),
		facts: outcome.draft.facts,
		declaration: outcome.draft.declaration,
	};
}

describe("a stored baseline read by the reader", () => {
	const sources = retainedSources();

	it("covers every retained source", () => {
		expect(sources.length).toBeGreaterThan(30);
	});

	for (const { name, body } of sources)
		it(`gives the document its read gave: ${name}`, async () => {
			const read = await sourceFromBody(body);
			const normalized = normalizeHqAppSource(read.raw);
			if ("malformed" in normalized)
				throw new Error(
					`The retained source ${name} does not normalize: ${normalized.malformed}`,
				);
			const stored = sourceFromBaseline(JSON.parse(normalized.text));
			expect(compared(readHqApp(inputFor(stored)))).toEqual(
				compared(readHqApp(inputFor(inStoredKeyOrder(read)))),
			);
		});

	it("gives the document its read gave where operations write out of code-unit order", async () => {
		const doc = outOfOrder();
		const read = await sourceFromBody(servedExport(doc).body);
		const normalized = normalizeHqAppSource(read.raw);
		if ("malformed" in normalized)
			throw new Error(`The export does not normalize: ${normalized.malformed}`);
		const stored = sourceFromBaseline(JSON.parse(normalized.text));
		const outcome = readHqApp(inputFor(stored));
		expect(outcome.kind).toBe("read");
		expect(compared(outcome)).toEqual(
			compared(readHqApp(inputFor(inStoredKeyOrder(read)))),
		);
	});

	it("refuses a value that is no normalized source, naming the key", () => {
		expect(() => sourceFromBaseline({ doc_type: "Application" })).toThrow(
			"Nova tried to read a stored baseline as an app source and it is not one (missing modules). `readAppBaseline` verifies a baseline before it is read; this value did not come from it.",
		);
		expect(() => sourceFromBaseline([])).toThrow("(missing doc_type)");
	});
});
