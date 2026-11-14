/**
 * Every document the proof lane publishes reads back to itself.
 *
 * Contract: each targeted proof document (`proof/targeted/index.ts`, the
 * documents CommCare's own readers are run over) and each producer document
 * of the corpus (`proof/corpus/producers.ts`), expanded by the production
 * emitter as a publish expands it (the table names its Project data gives,
 * the media its assets give, the project space's attachment target), served
 * on CommCare HQ's own shell and read whole by `readHqApp`, reads to a
 * document with no finding and no reader defect; each form's fields equal
 * the document's after the reader's canonical choices (path, kind, repeat
 * mode, `fieldList`, the keypad, the plain flags, the choices and their
 * values, the media of each slot and each text in each language); and every
 * expression slot holds the canonical tree of what the document stored,
 * as `readBackCorpus.ts::judgeReadBack` judges it.
 *
 * Plausible failures: a shape one of Nova's documents writes that no reader
 * stage claims (an `unrecognized` finding on Nova's own export), a HELD-NEW
 * or REFUSED entry a reader stage raises for a shape Nova writes, a slot the
 * emitter writes that the reader reads as something else, and a reader
 * defect raised over Nova's own bytes. The test names every document that
 * does not read back, with its first finding or difference.
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
	type Field,
	type LanguageTag,
	type Media,
	type MediaKind,
	type Uuid,
} from "@/lib/domain";
import {
	effectiveAppLocalization,
	makeTranslationUnitId,
} from "@/lib/domain/localization";
import { projectProseTemplate } from "@/lib/domain/prose";
import { filledProse } from "@/lib/domain/translationFill";
import { snapshotTranslationUnits } from "@/lib/domain/translationUnits";
import type { CorpusDocument } from "@/proof/corpus/documents";
import { publishFindings } from "@/proof/corpus/editBatches";
import { producerDocuments } from "@/proof/corpus/producers";
import { targetedDocuments } from "@/proof/targeted/index";
import { expandDoc } from "../../expander";
import type { HqLocationType } from "../../hq/locations";
import { lookupWireNaming } from "../../lookup/naming";
import { DERIVED_WIRE_IDENTITY } from "../../wireIdentity";
import { READER_CANONICAL_CHOICES } from "../assemble";
import {
	judgeReadBack,
	readBody,
} from "../expressions/__tests__/readBackCorpus";
import { matchingResolver } from "../identity";
import { externalIdentityMap } from "../identityMap";
import { readHqApp } from "../index";
import { whereText } from "../place";
import type {
	ReaderInput,
	ReaderLookupCatalog,
	ReaderMediaResolution,
} from "../types";
import { inputFor } from "./novaExport";
import { retainedSourceBody } from "./readerInput";

const ORIGIN = "https://india.commcarehq.org";
const DOMAIN = "clinic";
const JR_FILE = "jr://file/";
const TEXT_SLOTS = ["label", "hint", "help", "validate_msg"] as const;
const MEDIA_SLOTS = ["label_media", "help_media"] as const;
const MEDIA_KIND_OF_EXTENSION: Readonly<Record<string, MediaKind>> = {
	".png": "image",
	".wav": "audio",
	".mp4": "video",
};

/** The document as the reader returns its pair's member. */
function canonical(doc: BlueprintDoc): BlueprintDoc {
	return READER_CANONICAL_CHOICES.reduce(
		(current, choice) => choice.apply(current),
		doc,
	);
}

/** A unit's text in each language as a worker reads it, blank texts left out. */
function textsOf(
	doc: BlueprintDoc,
	unitId: ReturnType<typeof makeTranslationUnitId>,
): Record<string, string> {
	const unit = snapshotTranslationUnits(doc).get(unitId);
	if (unit === undefined) return {};
	const out: Record<string, string> = {};
	const { languageOrder } = effectiveAppLocalization(doc.localization);
	for (const language of languageOrder as readonly LanguageTag[]) {
		const text = projectProseTemplate(
			filledProse(doc, unit, language),
			doc,
		).text;
		if (text !== "") out[language] = text;
	}
	return out;
}

/** Each kind's file, by the path the export writes for its asset: two assets
 *  of one file print one path, and the reader reads the path. */
function mediaOf(
	media: Media | undefined,
	pathOf: (assetId: string) => string,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const kind of ["image", "audio", "video"] as const) {
		const asset = media?.[kind];
		if (asset !== undefined) out[kind] = pathOf(asset);
	}
	return out;
}

/** Every form's fields in data-tree order, in the document's menu and form order. */
function fieldFacts(
	doc: BlueprintDoc,
	pathOf: (assetId: string) => string,
): unknown[] {
	const out: unknown[] = [];
	const walk = (parent: Uuid, prefix: string) => {
		for (const uuid of doc.fieldOrder[parent] ?? []) {
			const field = doc.fields[uuid] as Field;
			const record = field as Record<string, unknown>;
			const path = `${prefix}/${field.id}`;
			const texts: Record<string, Record<string, string>> = {};
			for (const slot of TEXT_SLOTS) {
				const text = textsOf(doc, makeTranslationUnitId("field", uuid, slot));
				if (Object.keys(text).length > 0) texts[slot] = text;
			}
			const media: Record<string, Record<string, string>> = {};
			for (const slot of MEDIA_SLOTS) {
				const files = mediaOf(record[slot] as Media | undefined, pathOf);
				if (Object.keys(files).length > 0) media[slot] = files;
			}
			out.push({
				path,
				kind: field.kind,
				repeatMode: record.repeat_mode,
				fieldList: record.fieldList === true,
				keypad: record.keypad,
				plainLabel: record.plainLabel === true,
				plainHelp: record.plainHelp === true,
				media,
				texts,
				choices:
					"optionsSource" in field && field.optionsSource.kind === "inline"
						? field.optionsSource.options.map((option) => ({
								value: option.value,
								plainLabel: option.plainLabel === true,
								media: mediaOf(option.media, pathOf),
								texts: textsOf(
									doc,
									makeTranslationUnitId("field", uuid, "option", option.uuid),
								),
							}))
						: undefined,
			});
			walk(uuid, path);
		}
	};
	for (const moduleUuid of doc.moduleOrder)
		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			out.push(`form ${formUuid}`);
			walk(formUuid, "");
		}
	return out;
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
		const keys = new Set([
			...Object.keys(want as object),
			...Object.keys(got as object),
		]);
		for (const key of keys) {
			const inner = firstDifference(
				(want as Record<string, unknown>)[key],
				(got as Record<string, unknown>)[key],
				`${at}/${key}`,
			);
			if (inner !== "") return inner;
		}
	}
	return `${at}: want ${JSON.stringify(want)?.slice(0, 300)}, got ${JSON.stringify(got)?.slice(0, 300)}`;
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

/** The project space's levels: the document's own, as HQ holds them. */
function levelsOf(doc: BlueprintDoc): HqLocationType[] {
	const levels = doc.organizationLevels ?? {};
	return Object.values(levels).map((level) => ({
		id: level.uuid,
		name: level.name,
		code: level.code,
		parentCode:
			level.parentLevelUuid === undefined
				? null
				: (levels[level.parentLevelUuid]?.code ?? null),
		administrative: false,
		sharesCases: false,
		viewDescendants: false,
	}));
}

/** The stored document as Nova's load boundary hydrates it. */
function hydrated(document: CorpusDocument): BlueprintDoc {
	const doc = hydratePersistedBlueprint(blueprintDocSchema.parse(document.doc));
	ensureReferenceIndex(doc);
	return doc;
}

/** Why one document does not read back, or nothing where it does. */
async function readBack(
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
		attachmentTarget: { origin: ORIGIN, domain: DOMAIN },
		...(manifest.size > 0 && { assets: manifest }),
		...(naming !== undefined && { lookupNaming: naming }),
	});
	// HQ's import replaces every top-level key the body carries
	// (`models/applications.py::_merge_source_into_app`).
	const body = {
		...retainedSourceBody("shell/app-source"),
		...(JSON.parse(JSON.stringify(emitted)) as Record<string, unknown>),
	};
	const catalog = lookupCatalog(document);
	const levels = levelsOf(doc);
	const overrides: Partial<ReaderInput> = {
		resolver: matchingResolver(
			"app-1",
			externalIdentityMap(doc, DERIVED_WIRE_IDENTITY),
		),
		recordDialect: recordDialectRoundTrip,
		lookup: catalog,
		organization: { levelCodes: levels.map((level) => level.code), levels },
		media: {
			resolve: (path): ReaderMediaResolution => {
				const assetId = assetOfPath.get(path);
				if (assetId === undefined) return { kind: "no-entry" };
				const mediaKind =
					MEDIA_KIND_OF_EXTENSION[path.slice(path.lastIndexOf("."))];
				return mediaKind === undefined
					? { kind: "unreadable" }
					: { kind: "asset", assetId, mediaKind };
			},
		},
	};
	const outcome = readHqApp(await inputFor(body, overrides));
	if (outcome.defects.length > 0)
		return `reader defect: ${JSON.stringify(outcome.defects[0])}`;
	if (outcome.kind !== "read") {
		const first = outcome.findings[0];
		return `${outcome.findings.length} finding(s), first ${first?.code} at ${
			first === undefined ? "" : whereText(first.place)
		} (${first?.detail.name ?? ""}${
			first?.detail.reason === undefined ? "" : `, ${first.detail.reason}`
		}); all: ${[...new Set(outcome.findings.map((finding) => finding.code))].join(", ")}`;
	}
	const want = canonical(doc);
	const fields = firstDifference(
		fieldFacts(want, pathOf),
		fieldFacts(outcome.draft.doc, pathOf),
	);
	if (fields !== "") return `fields differ at ${fields}`;
	const reading = await readBody(body, doc, recordDialectRoundTrip, {
		naming: naming ?? lookupWireNaming([]),
		catalog,
	});
	const differing = judgeReadBack(want, reading).filter(
		({ verdict }) => verdict.kind === "differs",
	);
	const [slot] = differing;
	if (slot !== undefined && slot.verdict.kind === "differs")
		return `${differing.length} expression slot(s) differ, first ${slot.stored.ref.entity}.${slot.stored.ref.slot} (${slot.verdict.text ?? "not registered"}): ${firstDifference(slot.verdict.want, slot.verdict.got)}`;
	return null;
}

it("reads back every targeted and producer document the proof lane publishes", {
	// About two hundred documents, each expanded once and read twice;
	// generous for a shared runner.
	timeout: 300_000,
}, async () => {
	const documents = [...targetedDocuments(), ...producerDocuments()];
	const failures: string[] = [];
	let read = 0;
	for (const document of documents) {
		let why: string | null;
		try {
			const doc = hydrated(document);
			// A document Nova's publish refuses never reaches CommCare HQ.
			if (publishFindings(doc, document.lookup).length > 0) continue;
			read++;
			why = await readBack(document, doc);
		} catch (error) {
			why = `threw: ${error instanceof Error ? error.message.slice(0, 400) : String(error)}`;
		}
		if (why !== null) failures.push(`${document.id}: ${why}`);
	}
	expect(read).toBeGreaterThan(100);
	expect(failures).toEqual([]);
});
