/**
 * The emission acceptance re-reads and the reader's own re-emissions are one
 * projection.
 *
 * Contract: over every retained source of CommCare HQ's that reads whole, and
 * over Nova's own exports served on HQ's shell with a lookup table, media and
 * a Web Apps logo HQ holds, `readingEmissionOptions` (built from the draft
 * alone) equals `readProjectionInputs(ctx)` (built from the reader's context)
 * in every menu's and form's id and `xmlns`, the attachment target, the
 * tables' names and each asset's id and path, and the two emissions are byte
 * for byte one; every asset a media reference names is in `emissionAssets`;
 * `sourceFromEmission` gives every member of a source; and the emission,
 * wrapped as a source with the source's own `build_spec`, media map and logo,
 * re-reads to the reading's document with no finding (so none under the
 * build-version floor's refusal) and with its Web Apps logo.
 *
 * Plausible failures: the reader's comparisons and acceptance's printing a
 * reading under another id, address, table name or path, so one of them
 * fails a correct reading; a thrown missing-asset error inside acceptance; a
 * re-read that refuses every app for a key Nova never writes, or drops a
 * logo CommCare HQ holds.
 */

import { describe, expect, it } from "vitest";
import {
	retainedBodyJson,
	retainedGroupRead,
} from "@/__tests__/helpers/retainedHqReads";
import { recordDialectRoundTrip } from "@/lib/agent/authoring/recordRoundTrip";
import { expandDoc } from "@/lib/commcare/expander";
import type { HqAppSource } from "@/lib/commcare/hq/appSource";
import {
	knownCaseTypesOf,
	knownLanguageCodesOf,
	type ReadDraft,
	type ReaderInput,
	readHqApp,
	STAGES,
} from "@/lib/commcare/reader";
import {
	hydrated,
	publishedCorpus,
} from "@/lib/commcare/reader/__tests__/publishedDocuments";
import {
	readerInput,
	sourceFromBody,
} from "@/lib/commcare/reader/__tests__/readerInput";
import { createReadContext } from "@/lib/commcare/reader/context";
import { mintingResolver } from "@/lib/commcare/reader/identity";
import { readProjectionInputs } from "@/lib/commcare/reader/projectionInputs";
import { inventoryIndex } from "@/lib/commcare/surface/inventory";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import type { LookupFixtureDataSnapshot } from "@/lib/lookup/types";
import type { AdoptedMediaFile } from "../../adoption";
import {
	alignedFromEmission,
	emissionAssets,
	readingEmission,
	readingEmissionOptions,
	sourceFromEmission,
} from "../emission";
import {
	lookupCatalog,
	mediaIndex,
	NOVA_DOMAIN,
	NOVA_ORIGIN,
	servedExport,
} from "./novaReading";

const APP_ID = "parity-app";

/** HQ's slot for the Web Apps logo, and the path its uploader writes there. */
const WEB_APPS_LOGO = "hq_logo_web_apps";
const LOGO_PATH = `jr://file/commcare/logo/data/${WEB_APPS_LOGO}.png`;

interface Reading {
	readonly name: string;
	readonly input: ReaderInput;
	readonly lookup?: LookupFixtureDataSnapshot;
	/** The content hash and extension of each asset, where a test knows them. */
	readonly assetFacts: ReadonlyMap<string, { hash: string; extension: string }>;
	readonly logo?: string;
}

/** CommCare HQ's retained sources of an app, each of which reads whole. */
const RETAINED_READ = [
	"navigation-base/app-source",
	"navigation-base/app-source-after-form-builder-save",
	"case-list-inline/app-source",
] as const;

async function retained(name: string): Promise<Reading> {
	return {
		name,
		input: {
			...readerInput(
				await sourceFromBody(retainedBodyJson(retainedGroupRead(name))),
			),
			appId: APP_ID,
			resolver: mintingResolver(APP_ID),
			recordDialect: recordDialectRoundTrip,
		},
		assetFacts: new Map(),
	};
}

/** A corpus document's export as HQ serves it, a person having added a Web
 *  Apps logo in HQ where the document holds one. */
async function novaServed(id: string): Promise<Reading> {
	const document = publishedCorpus().find((one) => one.id === id);
	if (document === undefined) throw new Error(`No corpus document ${id}.`);
	const doc = hydrated(document);
	const logo = doc.logo;
	const served = servedExport(doc, {
		lookup: document.lookup,
		...(logo !== undefined && {
			root: {
				logo_refs: { [WEB_APPS_LOGO]: { path: LOGO_PATH, m_id: "logo-file" } },
			},
		}),
	});
	const assetOfPath = new Map(served.assetOfPath);
	if (logo !== undefined) assetOfPath.set(LOGO_PATH, logo);
	const assetFacts = new Map(
		[...served.manifest].map(([assetId, asset]) => [
			assetId as string,
			{ hash: asset.contentHash, extension: asset.extension },
		]),
	);
	return {
		name: id,
		input: {
			...readerInput(await sourceFromBody(served.body)),
			appId: APP_ID,
			target: { origin: NOVA_ORIGIN, domain: NOVA_DOMAIN },
			resolver: mintingResolver(APP_ID),
			recordDialect: recordDialectRoundTrip,
			lookup: lookupCatalog(document.lookup),
			media: mediaIndex(assetOfPath),
		},
		...(document.lookup !== undefined && { lookup: document.lookup }),
		assetFacts,
		...(logo !== undefined && { logo }),
	};
}

/** The reading's context after every stage, as `readHqApp` runs it. */
function readWhole(input: ReaderInput) {
	const ctx = createReadContext(input, {}, inventoryIndex());
	for (const stage of STAGES) stage(ctx);
	const closed = ctx.close();
	expect(closed.findings.map((finding) => finding.code)).toEqual([]);
	const draft = ctx.assembled as ReadDraft;
	expect(draft).toBeDefined();
	return { ctx, draft };
}

/** One held file per media path the reading resolved. */
function heldFiles(
	draft: ReadDraft,
	facts: Reading["assetFacts"],
): AdoptedMediaFile[] {
	return draft.facts.mediaReferences.map((reference) => {
		const known = facts.get(reference.assetId);
		return {
			hqPath: reference.path,
			assetId: reference.assetId as AdoptedMediaFile["assetId"],
			contentHash: known?.hash ?? "0".repeat(64),
			extension: known?.extension ?? ".png",
		};
	});
}

function plain(value: unknown): unknown {
	return JSON.parse(JSON.stringify(value));
}

async function readings(): Promise<Reading[]> {
	return [
		...(await Promise.all(RETAINED_READ.map(retained))),
		await novaServed("media-rich"),
		await novaServed("lookup-app"),
		await novaServed("targeted-media-slots"),
	];
}

describe("a reading's emission", () => {
	it("is the reader's own projection of the reading, and re-reads to it", {
		timeout: 120_000,
	}, async () => {
		const checked: string[] = [];
		for (const reading of await readings()) {
			const { ctx, draft } = readWhole(reading.input);
			const source: HqAppSource = reading.input.source;
			const files = heldFiles(draft, reading.assetFacts);
			const definitions = reading.lookup?.definitions ?? [];
			const emissionInput = {
				doc: draft.doc,
				source,
				draft,
				reader: reading.input,
				lookupDefinitions: definitions,
				files,
			};
			const options = readingEmissionOptions(emissionInput);
			const inputs = readProjectionInputs(ctx);

			// Every menu's and form's id and `xmlns`, a folded hidden menu's included.
			const identity = options.identity;
			if (identity === undefined) throw new Error("No identity.");
			for (const module of draft.identities.modules)
				expect(identity.moduleUniqueId(module.uuid), reading.name).toBe(
					inputs.identity.moduleUniqueId(module.uuid),
				);
			for (const form of Object.values(draft.doc.forms)) {
				expect(identity.formUniqueId(form.uuid), reading.name).toBe(
					inputs.identity.formUniqueId(form.uuid),
				);
				expect(identity.formXmlns(form), reading.name).toBe(
					inputs.identity.formXmlns(form),
				);
			}
			expect(options.attachmentTarget).toEqual(inputs.attachmentTarget);
			// The tables' names: none where the reading bound none.
			expect(
				options.lookupNaming === undefined
					? []
					: plain(options.lookupNaming.tables),
				reading.name,
			).toEqual(plain(inputs.lookupNaming.tables));
			// Each asset's id and path, and every asset a reference names.
			const paths = (manifest: NonNullable<typeof options.assets>) =>
				[...manifest].map(([id, asset]) => [id, asset.wirePath]).sort();
			expect(paths(options.assets ?? new Map()), reading.name).toEqual(
				paths(inputs.assets),
			);
			const assets = emissionAssets(draft.facts.mediaReferences, files);
			for (const reference of draft.facts.mediaReferences)
				expect(assets.has(reference.assetId as never), reading.name).toBe(true);

			// The two emissions are byte for byte one.
			const emission = readingEmission(emissionInput);
			expect(JSON.stringify(emission), reading.name).toBe(
				JSON.stringify(
					expandDoc(draft.doc, {
						...inputs,
						keyedCaseIdPrefixes: options.keyedCaseIdPrefixes,
					}),
				),
			);

			// The wrapped source holds every member, and re-reads to the document.
			const again = sourceFromEmission(emission, source);
			expect(Object.keys(again).sort()).toEqual(
				[
					"addOns",
					"buildProfiles",
					"buildSpecVersion",
					"cloudcareEnabled",
					"docType",
					"langs",
					"lastModified",
					"logoRefs",
					"modules",
					"multimediaMap",
					"name",
					"profile",
					"raw",
					"translations",
				].sort(),
			);
			expect(again.raw.build_spec).toEqual(source.raw.build_spec);
			expect(again.logoRefs).toEqual(source.logoRefs);
			const reRead = readHqApp({
				...reading.input,
				source: again,
				modules: alignedFromEmission(emission),
				resolver: mintingResolver(APP_ID),
				knownCaseTypes: knownCaseTypesOf(draft.doc),
				knownLanguageCodes: knownLanguageCodesOf(draft.doc),
			});
			if (reRead.kind !== "read")
				throw new Error(
					`${reading.name} re-read to an account: ${reRead.findings
						.map((finding) => finding.code)
						.join(", ")}`,
				);
			expect(reRead.defects, reading.name).toEqual([]);
			expect(plain(toPersistableDoc(reRead.draft.doc)), reading.name).toEqual(
				plain(toPersistableDoc(draft.doc)),
			);
			if (reading.logo !== undefined) {
				expect(draft.doc.logo, reading.name).toBe(reading.logo);
				expect(reRead.draft.doc.logo, reading.name).toBe(reading.logo);
			}
			checked.push(reading.name);
		}
		expect(checked).toHaveLength(RETAINED_READ.length + 3);
	});
});
