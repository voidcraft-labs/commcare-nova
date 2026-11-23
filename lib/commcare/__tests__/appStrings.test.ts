/**
 * A document's local app strings, read without a deployment: the tables
 * `compileCcz` writes into each language's `app_strings.txt`, as values.
 *
 * The reader of CommCare HQ's apps judges each generated translation key
 * against these strings, so the plausible failures are a table no build
 * makes (one that depends on the stand-in target, on what a table and its
 * columns are called, or on anything but the document), a reading that
 * throws on a string the archive spells otherwise than it holds, and a
 * split of the compiler that changed the archive it packages.
 *
 * The corpus is every targeted and producer document Nova's publish admits
 * (`reader/__tests__/publishedDocuments.ts`), with the Project data and
 * media each one is published with.
 */

import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { localAppStringTable } from "@/lib/commcare/appStrings";
import {
	type CompilePartsOptions,
	compileCcz,
	compileCczParts,
} from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { hqLocaleFileValue } from "@/lib/commcare/localeFile";
import { buildLookupFixtures } from "@/lib/commcare/lookup/fixtures";
import { lookupWireNaming } from "@/lib/commcare/lookup/naming";
import { jrFileRef } from "@/lib/commcare/multimedia/assetWirePath";
import type { AppStringTable } from "@/lib/commcare/reader/types";
import type { RuntimeTarget } from "@/lib/commcare/runtimeTarget";
import { DERIVED_WIRE_IDENTITY } from "@/lib/commcare/wireIdentity";
import {
	EMPTY_LOOKUP_REFERENCE_TARGETS,
	extractLookupReferenceTargets,
} from "@/lib/doc/lookupReferences";
import type { BlueprintDoc } from "@/lib/domain";
import { compileLocalArchive } from "@/lib/export/localArchive";
import { parseLookupRevision } from "@/lib/lookup/schema";
import type {
	LookupFixtureDataSnapshot,
	LookupTableDefinition,
} from "@/lib/lookup/types";
import type { CorpusDocument } from "@/proof/corpus/documents";
import {
	hydrated,
	publishExpansion,
	publishedCorpus,
	publishRefuses,
} from "../reader/__tests__/publishedDocuments";
import { TEST_RUNTIME_TARGET } from "./runtimeTargetFixture";
import { readXmlEvidence, type XmlEvidence } from "./xmlEvidence";

/** A second stand-in target: another server, project space and app id. */
const OTHER_TARGET: RuntimeTarget = {
	server: "india",
	domain: "another-space",
	appId: "another-app",
};

interface Admitted {
	readonly document: CorpusDocument;
	readonly doc: BlueprintDoc;
}

function admittedCorpus(): Admitted[] {
	return publishedCorpus().flatMap((document) => {
		const doc = hydrated(document);
		return publishRefuses(document, doc) ? [] : [{ document, doc }];
	});
}

/** Every table of the document's Project, as the reading's catalog binds them. */
function definitionsOf(document: CorpusDocument): LookupTableDefinition[] {
	return [...(document.lookup?.definitions ?? [])];
}

/** The lookup data a publish of `doc` carries: the tables it reads, with their rows. */
function referencedLookup(
	doc: BlueprintDoc,
	lookup: LookupFixtureDataSnapshot | undefined,
): LookupFixtureDataSnapshot | undefined {
	if (lookup === undefined) return undefined;
	const read = new Set<string>(extractLookupReferenceTargets(doc).tableIds);
	if (read.size === 0) return undefined;
	return {
		projectId: lookup.projectId,
		projectRevision: lookup.projectRevision,
		definitions: lookup.definitions.filter((table) => read.has(table.id)),
		rowsByTable: new Map(
			[...lookup.rowsByTable].filter(([id]) => read.has(id)),
		),
	};
}

/** The same tables under other tags and other column names. */
function respelled(
	definitions: readonly LookupTableDefinition[],
): LookupTableDefinition[] {
	return definitions.map((table) => ({
		...table,
		tag: `other_${table.tag}`,
		columns: table.columns.map((column) => ({
			...column,
			wireName: `other_${column.wireName}`,
		})),
	}));
}

/** The archive's table of each language, by code, as `key -> the value as written`. */
function writtenTables(
	archive: Buffer,
	codes: readonly string[],
): Record<string, Map<string, string>> {
	const zip = new AdmZip(archive);
	return Object.fromEntries(
		codes.map((code) => {
			const lines = new Map<string, string>();
			for (const line of zip
				.readAsText(`${code}/app_strings.txt`)
				.split("\n")) {
				const at = line.indexOf("=");
				lines.set(line.slice(0, at), line.slice(at + 1));
			}
			return [code, lines];
		}),
	);
}

/** A table's values as an archive writes them. */
function asWritten(table: AppStringTable): Record<string, Map<string, string>> {
	return Object.fromEntries(
		Object.entries(table.languages).map(([code, strings]) => [
			code,
			new Map(
				Object.entries(strings).map(([key, value]) => [
					key,
					hqLocaleFileValue(value),
				]),
			),
		]),
	);
}

/** Whether a generated key is one only a media manifest writes: a menu's
 *  media path, or an image map's alt text, keyed by the file's path. */
function mediaKey(key: string): boolean {
	return (
		key.endsWith(".icon") ||
		key.endsWith(".audio") ||
		key.includes(".alt_text.")
	);
}

/** The tables `compileCczParts` gives over `definitions` and `runtimeTarget`,
 *  in `localAppStringTable`'s shape. */
function partsTable(
	doc: BlueprintDoc,
	definitions: readonly LookupTableDefinition[],
	runtimeTarget: RuntimeTarget,
): AppStringTable {
	const read = new Set<string>(extractLookupReferenceTargets(doc).tableIds);
	const naming = lookupWireNaming(
		definitions.filter((table) => read.has(table.id)),
	);
	const opts: CompilePartsOptions = {
		runtimeTarget,
		lookupNaming: naming,
		lookupFixtures: buildLookupFixtures(
			naming,
			new Map(naming.tables.map((table) => [table.tableId, []])),
		),
	};
	const hqJson = expandDoc(doc, { runtimeTarget, lookupNaming: naming });
	const parts = compileCczParts(hqJson, doc.appName, doc, opts);
	return {
		languages: Object.fromEntries(
			Object.entries(parts.tables)
				.filter(([dir]) => dir !== "default")
				.map(([code, table]) => [code, Object.fromEntries(table)]),
		),
		units: parts.appStringUnits,
		wordingUnits: parts.wordingUnits,
	};
}

function* elements(node: XmlEvidence): Generator<XmlEvidence> {
	yield node;
	for (const child of node.children) yield* elements(child);
}

/** Whether a suite declares a lookup table's instance. */
function suiteReadsATable(suiteXml: string): boolean {
	for (const element of elements(readXmlEvidence(suiteXml)))
		if (
			element.name === "instance" &&
			(element.attributes.src ?? "").startsWith("jr://fixture/item-list:")
		)
			return true;
	return false;
}

function tableOf(document: CorpusDocument, doc: BlueprintDoc): AppStringTable {
	try {
		return localAppStringTable(doc, definitionsOf(document));
	} catch (error) {
		throw new Error(`${document.id}: ${String(error)}`);
	}
}

describe("localAppStringTable", () => {
	const corpus = admittedCorpus();

	it("holds a corpus that reads lookup tables in a suite", () => {
		const suites = corpus.flatMap(({ document, doc }) => {
			const lookup = referencedLookup(doc, document.lookup);
			if (lookup === undefined) return [];
			const naming = lookupWireNaming(lookup.definitions);
			const hqJson = expandDoc(doc, {
				runtimeTarget: TEST_RUNTIME_TARGET,
				lookupNaming: naming,
			});
			const parts = compileCczParts(hqJson, doc.appName, doc, {
				runtimeTarget: TEST_RUNTIME_TARGET,
				lookupNaming: naming,
				lookupFixtures: buildLookupFixtures(naming, lookup.rowsByTable),
			});
			return [parts.files["suite.xml"] ?? ""];
		});
		expect(suites.length).toBeGreaterThan(1);
		expect(suites.some(suiteReadsATable)).toBe(true);
	});

	it("equals, language by language, the tables a local archive of the document writes", {
		timeout: 120_000,
	}, () => {
		let mediaStrings = 0;
		for (const { document, doc } of corpus) {
			const table = tableOf(document, doc);
			const { manifest } = publishExpansion(document, doc);
			const lookup = referencedLookup(doc, document.lookup);
			const snapshot: LookupFixtureDataSnapshot = lookup ?? {
				projectId: "project",
				projectRevision: parseLookupRevision("1"),
				definitions: [],
				rowsByTable: new Map(),
			};
			const naming =
				lookup === undefined ? undefined : lookupWireNaming(lookup.definitions);
			const archive = compileLocalArchive(
				{
					mode: "ccz",
					doc,
					compiledAtSeq: 3,
					assets: manifest,
					lookupTargets:
						lookup === undefined
							? EMPTY_LOOKUP_REFERENCE_TARGETS
							: extractLookupReferenceTargets(doc),
					lookupSnapshot: snapshot,
					lookupContext: {
						kind: "available",
						projectId: snapshot.projectId,
						projectRevision: snapshot.projectRevision,
						definitions: snapshot.definitions,
					},
					...(naming !== undefined && {
						lookupNaming: naming,
						lookupWire: {
							naming,
							fixtures: buildLookupFixtures(naming, snapshot.rowsByTable),
						},
					}),
					attachmentTarget: null,
					managedLookupTables: [],
					managedLookupWorkbooks: [],
				},
				TEST_RUNTIME_TARGET,
				DERIVED_WIRE_IDENTITY,
				{
					emptyCaseListText: false,
					earlierHqApps: 0,
					adopted: false,
					targetFacts: null,
					keyedCaseIdPrefixes: new Map(),
				},
			);
			const codes = Object.keys(table.languages);
			expect(codes.length, document.id).toBeGreaterThan(0);
			const written = writtenTables(archive, codes);
			const own = asWritten(table);
			const paths = new Set(
				[...manifest.values()].map((asset) =>
					hqLocaleFileValue(jrFileRef(asset.wirePath)),
				),
			);
			for (const code of codes) {
				const where = `${document.id} ${code}`;
				const archived = written[code] ?? new Map<string, string>();
				const expected = own[code] ?? new Map<string, string>();
				expect(
					new Map([...archived].filter(([key]) => expected.has(key))),
					where,
				).toEqual(expected);
				/* The archive is made with the document's media: beside the
				 * document's own strings it holds only what a manifest writes. */
				const beside = [...archived].filter(([key]) => !expected.has(key));
				expect(
					beside.filter(([key]) => !mediaKey(key)),
					where,
				).toEqual([]);
				for (const [key, value] of beside)
					if (!key.includes(".alt_text."))
						expect(paths.has(value), `${where} ${key}`).toBe(true);
				expect([...expected.keys()].filter(mediaKey), where).toEqual([]);
				mediaStrings += beside.length;
			}
		}
		expect(mediaStrings).toBeGreaterThan(0);
	});

	it("gives the same tables under two stand-in targets, and under two namings of the same tables", {
		timeout: 120_000,
	}, () => {
		let renamed = 0;
		for (const { document, doc } of corpus) {
			const table = tableOf(document, doc);
			const definitions = definitionsOf(document);
			expect(partsTable(doc, definitions, OTHER_TARGET), document.id).toEqual(
				table,
			);
			if (extractLookupReferenceTargets(doc).tableIds.length === 0) continue;
			expect(
				partsTable(doc, respelled(definitions), TEST_RUNTIME_TARGET),
				document.id,
			).toEqual(table);
			renamed += 1;
		}
		expect(renamed).toBeGreaterThan(1);
	});

	it("gives a string holding a literal backslash then n as the text it is, and does not throw", () => {
		const [first] = corpus;
		if (first === undefined) throw new Error("The corpus holds a document.");
		const doc = hydrated(first.document);
		const name = String.raw`Clinic\nvisits`;
		doc.appName = name;
		const table = localAppStringTable(doc, definitionsOf(first.document));
		const languages = Object.values(table.languages);
		expect(languages.length).toBeGreaterThan(0);
		for (const strings of languages) {
			expect(strings["app.display.name"]).toBe(name);
			expect(strings["homescreen.title"]).toBe(name);
		}
	});
});

describe("compileCcz", () => {
	it("packages exactly the parts its walk gives: every text entry, each table as HQ's build writes it, and the media", {
		timeout: 120_000,
	}, () => {
		for (const { document, doc } of admittedCorpus()) {
			const { options, manifest, naming } = publishExpansion(document, doc);
			const fixtures =
				naming !== undefined && document.lookup !== undefined
					? buildLookupFixtures(naming, document.lookup.rowsByTable)
					: undefined;
			const hqJson = expandDoc(doc, {
				...options,
				runtimeTarget: TEST_RUNTIME_TARGET,
			});
			const shared = {
				runtimeTarget: TEST_RUNTIME_TARGET,
				...(manifest.size > 0 && { assets: manifest }),
				compiledAtSeq: 4,
				earlierHqApps: 1,
			};
			const archive = new AdmZip(
				compileCcz(hqJson, doc.appName, doc, {
					...shared,
					...(naming !== undefined &&
						fixtures !== undefined && { lookup: { naming, fixtures } }),
				}),
			);
			const parts = compileCczParts(hqJson, doc.appName, doc, {
				...shared,
				...(naming !== undefined && { lookupNaming: naming }),
				...(fixtures !== undefined && { lookupFixtures: fixtures }),
			});
			const expected = new Map<string, Buffer>([
				...Object.entries(parts.files).map(([path, text]): [string, Buffer] => [
					path,
					Buffer.from(text, "utf8"),
				]),
				...Object.entries(parts.tables).map(
					([dir, table]): [string, Buffer] => [
						`${dir}/app_strings.txt`,
						Buffer.from(
							[...table]
								.map(([key, value]) => `${key}=${hqLocaleFileValue(value)}`)
								.join("\n"),
							"utf8",
						),
					],
				),
				...parts.mediaEntries.map((entry): [string, Buffer] => [
					entry.path,
					entry.bytes,
				]),
			]);
			const entries = archive.getEntries();
			expect(
				entries.map((entry) => entry.entryName).sort(),
				document.id,
			).toEqual([...expected.keys()].sort());
			for (const entry of entries)
				expect(
					entry
						.getData()
						.equals(expected.get(entry.entryName) ?? Buffer.alloc(0)),
					`${document.id} ${entry.entryName}`,
				).toBe(true);
		}
	});
});
