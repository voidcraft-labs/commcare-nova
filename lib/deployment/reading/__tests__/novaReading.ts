/**
 * A Nova document's export as CommCare HQ serves it, and the reader's input
 * over it as a read back of a document Nova holds is made: the document's
 * own app id and identities through a matching resolver, the case types its
 * indices reach and the languages its wire codes name, its lookup tables,
 * its levels as a publish sets them up, its media index by the path each
 * asset went out at, and its app strings as Nova's build gives them behind
 * the gate.
 */

import { createHash } from "node:crypto";
import { recordDialectRoundTrip } from "@/lib/agent/authoring/recordRoundTrip";
import { manifestFor } from "@/lib/commcare/__tests__/compilerEvidence";
import { expandDoc } from "@/lib/commcare/expander";
import { lookupWireNaming } from "@/lib/commcare/lookup/naming";
import {
	type AssetManifest,
	wirePathFor,
} from "@/lib/commcare/multimedia/assetWirePath";
import {
	knownCaseTypesOf,
	knownLanguageCodesOf,
	type ReaderInput,
	type ReaderLookupCatalog,
	type ReaderMediaResolution,
} from "@/lib/commcare/reader";
import { inputFor } from "@/lib/commcare/reader/__tests__/novaExport";
import { retainedSourceBody } from "@/lib/commcare/reader/__tests__/readerInput";
import { matchingResolver } from "@/lib/commcare/reader/identity";
import { externalIdentityMap } from "@/lib/commcare/reader/identityMap";
import { levelsAsPublished } from "@/lib/commcare/reader/worldEntities";
import {
	DERIVED_WIRE_IDENTITY,
	type WireIdentity,
} from "@/lib/commcare/wireIdentity";
import type { LookupValidationContext } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc, MediaKind } from "@/lib/domain";
import type { LookupFixtureDataSnapshot } from "@/lib/lookup/types";
import { readingAppStrings } from "../appStrings";

const JR_FILE = "jr://file/";

export const NOVA_ORIGIN = "https://india.commcarehq.org";
export const NOVA_DOMAIN = "clinic";

const MEDIA_KIND_OF_EXTENSION: Readonly<Record<string, MediaKind>> = {
	".png": "image",
	".wav": "audio",
	".mp4": "video",
};

/**
 * `manifest` with each asset its own file: the compiler's corpora give every
 * asset of a kind the same bytes, while a Project holds one asset per content
 * (an upload of a content it holds is an alias of that asset), so two assets
 * of a document never share a path a publish sends.
 */
function ownFiles(manifest: AssetManifest): AssetManifest {
	return new Map(
		[...manifest].map(([assetId, asset]) => {
			const contentHash = createHash("sha256")
				.update(`${asset.contentHash}:${assetId}`)
				.digest("hex");
			return [
				assetId,
				{
					...asset,
					contentHash,
					wirePath: wirePathFor(contentHash, asset.extension),
				},
			];
		}),
	);
}

/** What a publish of a Nova document sends, served on CommCare HQ's own shell. */
export interface ServedExport {
	readonly body: Record<string, unknown>;
	readonly manifest: AssetManifest;
	/** The asset each media path the export spells names. */
	readonly assetOfPath: ReadonlyMap<string, string>;
}

/**
 * HQ's source body for `doc`'s export under `identity`, with the media the
 * compiler's corpora give it and the names `lookup`'s tables carry, every
 * key the export carries written over HQ's shell, as HQ's import replaces
 * each top-level key a body holds (`models/applications.py::_merge_source_into_app`).
 */
export function servedExport(
	doc: BlueprintDoc,
	options: {
		readonly lookup?: LookupFixtureDataSnapshot;
		readonly identity?: WireIdentity;
		readonly root?: Readonly<Record<string, unknown>>;
	} = {},
): ServedExport {
	const manifest = ownFiles(manifestFor(doc));
	const definitions = options.lookup?.definitions ?? [];
	const emitted = expandDoc(doc, {
		attachmentTarget: { origin: NOVA_ORIGIN, domain: NOVA_DOMAIN },
		...(options.identity !== undefined && { identity: options.identity }),
		...(manifest.size > 0 && { assets: manifest }),
		...(definitions.length > 0 && {
			lookupNaming: lookupWireNaming(definitions),
		}),
	});
	const assetOfPath = new Map<string, string>();
	for (const [assetId, asset] of manifest) {
		const path = `${JR_FILE}${asset.wirePath}`;
		if (!assetOfPath.has(path)) assetOfPath.set(path, assetId);
	}
	return {
		body: {
			...retainedSourceBody("shell/app-source"),
			...(JSON.parse(JSON.stringify(emitted)) as Record<string, unknown>),
			...options.root,
		},
		manifest,
		assetOfPath,
	};
}

/** The project space's tables, by tag, as a reading is given them. */
export function lookupCatalog(
	lookup: LookupFixtureDataSnapshot | undefined,
): ReaderLookupCatalog {
	const definitions = lookup?.definitions ?? [];
	return {
		table: (tag) => {
			const table = definitions.find((one) => one.tag === tag);
			return table === undefined
				? undefined
				: {
						tableId: table.id,
						column: (name) =>
							table.columns.find((column) => column.wireName === name)?.id,
					};
		},
		definitions: new Map(definitions.map((table) => [table.id, table])),
	};
}

/** The gate's context over `lookup`'s tables, or none where there is none. */
export function lookupContextOf(
	lookup: LookupFixtureDataSnapshot | undefined,
): LookupValidationContext {
	return {
		kind: "available",
		projectId: lookup?.projectId ?? "project-1",
		projectRevision: lookup?.projectRevision ?? "0",
		definitions: lookup?.definitions ?? [],
	} as LookupValidationContext;
}

/** A media index that answers each path the export spells with the asset it names. */
export function mediaIndex(
	assetOfPath: ReadonlyMap<string, string>,
): ReaderInput["media"] {
	return {
		resolve: (path): ReaderMediaResolution => {
			const assetId = assetOfPath.get(path);
			if (assetId === undefined) return { kind: "no-entry" };
			const mediaKind =
				MEDIA_KIND_OF_EXTENSION[path.slice(path.lastIndexOf("."))];
			return mediaKind === undefined
				? { kind: "unreadable" }
				: { kind: "asset", assetId, mediaKind };
		},
	};
}

/** Whether some case operation of `doc` saves a write only where the worker changed it. */
function savesOnlyChangedAnswers(doc: BlueprintDoc): boolean {
	return Object.values(doc.forms).some((form) =>
		(form.caseOperations ?? []).some((operation) =>
			(operation.writes ?? []).some((write) => write.onlyIfChanged === true),
		),
	);
}

/**
 * The reader's input over `served`, as a read back of `doc` is made: `doc`'s
 * own UUIDs come back through `matchingResolver` over its identities under
 * `identity`, and everything else the reader is told is `doc`'s own.
 */
export async function readBackInput(
	doc: BlueprintDoc,
	served: ServedExport,
	options: {
		readonly lookup?: LookupFixtureDataSnapshot;
		readonly identity?: WireIdentity;
	} = {},
): Promise<ReaderInput> {
	const levels = levelsAsPublished(doc);
	return inputFor(served.body, {
		appId: doc.appId,
		target: { origin: NOVA_ORIGIN, domain: NOVA_DOMAIN },
		resolver: matchingResolver(
			doc.appId,
			externalIdentityMap(doc, options.identity ?? DERIVED_WIRE_IDENTITY),
		),
		knownCaseTypes: knownCaseTypesOf(doc),
		knownLanguageCodes: knownLanguageCodesOf(doc),
		// A publish of a document that saves an answer only where the worker
		// changed it reaches a project space that applies "save only if
		// changed", which a bring-in's probe of that project space reads.
		...(savesOnlyChangedAnswers(doc) && { saveOnlyEditedApplied: true }),
		caseListActionsApplied: true,
		recordDialect: recordDialectRoundTrip,
		lookup: lookupCatalog(options.lookup),
		organization: { levelCodes: levels.map((level) => level.code), levels },
		media: mediaIndex(served.assetOfPath),
		appStrings: readingAppStrings(lookupContextOf(options.lookup)),
	});
}
