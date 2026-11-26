/**
 * Contract: every menu's case list and search settings, in each targeted and producer document the
 * proof lane publishes, read back to the document's own after the reader's canonical choices:
 * columns, their kinds, headers, visibility, order rules, tile cells and both orders, the list's
 * tile and selection, every Search field's settings, and the search's own settings object. The
 * expression slots are held to their canonical trees by `targetedReadBack.test.ts`, so here each
 * is only present or absent; an image map names a file by the path the export writes for it.
 *
 * The failures it catches, each a different document with no finding: a settings object read
 * where the document holds none beside its Search fields; a lookup Search field's sort column read
 * where the field orders by its label column; the rule an unsorted list writes read as an authored
 * rule; a tile column shown nowhere read with the header the document gave it; a column of a menu
 * that lists no cases read off the detail.
 */
import { isDeepStrictEqual } from "node:util";
import { expect, it } from "vitest";
import { recordDialectRoundTrip } from "@/lib/agent/authoring/recordRoundTrip";
import { manifestFor } from "@/lib/commcare/__tests__/compilerEvidence";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { ensureReferenceIndex } from "@/lib/doc/referenceIndex";
import {
	type BlueprintDoc,
	blueprintDocSchema,
	levelDescendantCases,
	levelOwnsCases,
} from "@/lib/domain";
import type { CorpusDocument } from "@/proof/corpus/documents";
import { publishFindings } from "@/proof/corpus/editBatches";
import { producerDocuments } from "@/proof/corpus/producers";
import { targetedDocuments } from "@/proof/targeted/index";
import { expandDoc } from "../../../expander";
import { lookupWireNaming } from "../../../lookup/naming";
import { DERIVED_WIRE_IDENTITY } from "../../../wireIdentity";
import { inputFor } from "../../__tests__/novaExport";
import { retainedSourceBody } from "../../__tests__/readerInput";
import { READER_CANONICAL_CHOICES } from "../../assemble";
import { matchingResolver } from "../../identity";
import { externalIdentityMap } from "../../identityMap";
import { knownCaseTypesOf, readHqApp } from "../../index";
import type { ReaderLookupCatalog, ReaderMediaResolution } from "../../types";

const JR_FILE = "jr://file/";
const MEDIA_KIND: Readonly<Record<string, "image" | "audio" | "video">> = {
	".png": "image",
	".wav": "audio",
	".mp4": "video",
};
/** The keys of a list or a search whose object value is an expression slot. */
const EXPRESSION_KEYS = new Set([
	"filter",
	"searchCondition",
	"expression",
	"predicate",
	"default",
	"when",
	"rule",
	"value",
	"excludedOwnerIds",
	"searchButtonDisplayCondition",
]);

function canonical(doc: BlueprintDoc): BlueprintDoc {
	return READER_CANONICAL_CHOICES.reduce(
		(current, choice) => choice.apply(current),
		doc,
	);
}

/** `value` with each expression slot reduced to its presence and each asset to its file. */
function comparable(
	value: unknown,
	pathOf: (assetId: string) => string,
): unknown {
	if (Array.isArray(value)) return value.map((one) => comparable(one, pathOf));
	if (value === null || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value).map(([key, one]) => [
			key,
			EXPRESSION_KEYS.has(key) && one !== null && typeof one === "object"
				? "<expression>"
				: key === "assetId" && typeof one === "string"
					? pathOf(one)
					: comparable(one, pathOf),
		]),
	);
}

/** Each menu's list and search, in menu order. */
function menus(doc: BlueprintDoc, pathOf: (assetId: string) => string) {
	return doc.moduleOrder.map((uuid) => {
		const mod = doc.modules[uuid];
		return comparable(
			{ list: mod?.caseListConfig, search: mod?.caseSearchConfig },
			pathOf,
		);
	});
}

/** The first place two values differ, as a path and both sides. */
function firstDifference(want: unknown, got: unknown, at = ""): string {
	if (isDeepStrictEqual(want, got)) return "";
	if (
		want !== null &&
		got !== null &&
		typeof want === "object" &&
		typeof got === "object"
	) {
		const keys = new Set([...Object.keys(want), ...Object.keys(got)]);
		for (const key of keys) {
			const inner = firstDifference(
				(want as Record<string, unknown>)[key],
				(got as Record<string, unknown>)[key],
				`${at}/${key}`,
			);
			if (inner !== "") return inner;
		}
	}
	return `${at}: want ${JSON.stringify(want)?.slice(0, 200)}, got ${JSON.stringify(got)?.slice(0, 200)}`;
}

/** The project space's tables, by tag, for a reading. */
function lookupCatalog(document: CorpusDocument): ReaderLookupCatalog {
	const definitions = document.lookup?.definitions ?? [];
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

/** Why one document's lists do not read back, or nothing where they do. */
async function listsReadBack(
	document: CorpusDocument,
	doc: BlueprintDoc,
): Promise<string | null> {
	const manifest = manifestFor(doc);
	const assetOfPath = new Map<string, string>();
	const pathOfAsset = new Map<string, string>();
	for (const [assetId, asset] of manifest) {
		const path = `${JR_FILE}${asset.wirePath}`;
		pathOfAsset.set(assetId, path);
		if (!assetOfPath.has(path)) assetOfPath.set(path, assetId);
	}
	const pathOf = (assetId: string) => pathOfAsset.get(assetId) ?? assetId;
	const naming =
		document.lookup === undefined
			? undefined
			: lookupWireNaming(document.lookup.definitions);
	const emitted = expandDoc(doc, {
		attachmentTarget: { origin: "https://india.commcarehq.org", domain: "x" },
		...(manifest.size > 0 && { assets: manifest }),
		...(naming !== undefined && { lookupNaming: naming }),
	});
	const body = {
		...retainedSourceBody("shell/app-source"),
		...(JSON.parse(JSON.stringify(emitted)) as Record<string, unknown>),
	};
	const levelsById = doc.organizationLevels ?? {};
	const levels = Object.values(levelsById).map((level) => ({
		id: level.uuid,
		name: level.name,
		code: level.code,
		parentCode:
			level.parentLevelUuid === undefined
				? null
				: (levelsById[level.parentLevelUuid]?.code ?? null),
		administrative: false,
		sharesCases: levelOwnsCases(level),
		viewDescendants: levelDescendantCases(level).kind !== "none",
	}));
	const outcome = readHqApp(
		await inputFor(body, {
			// A re-read mints what the document does not hold under the app's own id.
			resolver: matchingResolver(
				doc.appId,
				externalIdentityMap(doc, DERIVED_WIRE_IDENTITY),
			),
			knownCaseTypes: knownCaseTypesOf(doc),
			recordDialect: recordDialectRoundTrip,
			lookup: lookupCatalog(document),
			organization: { levelCodes: levels.map((level) => level.code), levels },
			media: {
				resolve: (path): ReaderMediaResolution => {
					const assetId = assetOfPath.get(path);
					if (assetId === undefined) return { kind: "no-entry" };
					const mediaKind = MEDIA_KIND[path.slice(path.lastIndexOf("."))];
					return mediaKind === undefined
						? { kind: "unreadable" }
						: { kind: "asset", assetId, mediaKind };
				},
			},
		}),
	);
	// A reading with a finding or a defect is `targetedReadBack.test.ts`'s to name.
	if (outcome.kind !== "read" || outcome.defects.length > 0) return null;
	const difference = firstDifference(
		menus(canonical(doc), pathOf),
		menus(outcome.draft.doc, pathOf),
	);
	return difference === "" ? null : `lists differ at ${difference}`;
}

it("reads back every menu's list and search in each document the proof lane publishes", {
	// About two hundred documents, each expanded and read once.
	timeout: 300_000,
}, async () => {
	const failures: string[] = [];
	let read = 0;
	for (const document of [...targetedDocuments(), ...producerDocuments()]) {
		const doc = hydratePersistedBlueprint(
			blueprintDocSchema.parse(document.doc),
		);
		ensureReferenceIndex(doc);
		// A document Nova's publish refuses never reaches CommCare HQ.
		if (publishFindings(doc, document.lookup).length > 0) continue;
		read++;
		const why = await listsReadBack(document, doc);
		if (why !== null) failures.push(`${document.id}: ${why}`);
	}
	expect(read).toBeGreaterThan(100);
	expect(failures).toEqual([]);
});
