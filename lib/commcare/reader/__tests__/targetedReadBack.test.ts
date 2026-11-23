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
 * values, the media of each slot and each text in each language); the whole
 * document equals it too, every expression slot masked to whether it holds
 * one, every media asset written as its path, and none of what no export
 * carries and the reader is never told (the app's id, personas, worker types,
 * automations), the platform declaration being among the reading's choices;
 * and every expression slot holds the canonical tree of what the document
 * stored, as `readBackCorpus.ts::judgeReadBack` judges it.
 *
 * Plausible failures: a shape one of Nova's documents writes that no reader
 * stage claims (an `unrecognized` finding on Nova's own export), a HELD-NEW
 * or REFUSED entry a reader stage raises for a shape Nova writes, a slot the
 * emitter writes that the reader reads as something else, a slot or a fact
 * the reading adds where the document holds none or drops where it holds
 * one, and a reader defect raised over Nova's own bytes. The test names every document that
 * does not read back, with its first finding or difference.
 */
import { isDeepStrictEqual } from "node:util";
import { expect, it } from "vitest";
import { recordDialectRoundTrip } from "@/lib/agent/authoring/recordRoundTrip";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import type {
	BlueprintDoc,
	Field,
	LanguageTag,
	Media,
	MediaKind,
	Uuid,
} from "@/lib/domain";
import {
	effectiveAppLocalization,
	makeTranslationUnitId,
} from "@/lib/domain/localization";
import { projectProseTemplate } from "@/lib/domain/prose";
import { rewriteExpressionSlotValues } from "@/lib/domain/referenceSlots";
import { filledProse } from "@/lib/domain/translationFill";
import { snapshotTranslationUnits } from "@/lib/domain/translationUnits";
import type { CorpusDocument } from "@/proof/corpus/documents";
import { expandDoc } from "../../expander";
import { lookupWireNaming } from "../../lookup/naming";
import { DERIVED_WIRE_IDENTITY } from "../../wireIdentity";
import { READER_CANONICAL_CHOICES } from "../assemble";
import {
	judgeReadBack,
	readBody,
} from "../expressions/__tests__/readBackCorpus";
import { matchingResolver } from "../identity";
import { externalIdentityMap } from "../identityMap";
import { knownCaseTypesOf, readHqApp } from "../index";
import { whereText } from "../place";
import type {
	ReaderInput,
	ReaderLookupCatalog,
	ReaderMediaResolution,
} from "../types";
import { levelsAsPublished } from "../worldEntities";
import { inputFor } from "./novaExport";
import {
	hydrated,
	publishExpansion,
	publishedCorpus,
	publishRefuses,
} from "./publishedDocuments";
import { retainedSourceBody } from "./readerInput";

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

/** What stands in an expression slot of the whole-document comparison: the
 *  slot holds an expression, which `judgeReadBack` judges tree by tree. */
const EXPRESSION_PRESENT = "<expression>";

/**
 * The whole document as the comparison reads it: the persisted shape as JSON,
 * every expression slot of a field, a form or a menu masked to its presence,
 * every media asset written as the path the export gives it, and none of what
 * no export carries and the reader is never told (the app's id, its personas,
 * worker types and automations with their orders) nor the platform
 * declaration, which a reading proposes among choices.
 */
function wholeDocument(
	doc: BlueprintDoc,
	pathOfAsset: ReadonlyMap<string, string>,
): Record<string, unknown> {
	const plain = JSON.parse(JSON.stringify(toPersistableDoc(doc))) as Record<
		string,
		unknown
	>;
	for (const key of [
		"appId",
		"personas",
		"personaOrder",
		"userTypes",
		"userTypeOrder",
		"automations",
		"automationOrder",
	])
		delete plain[key];
	delete (plain.appSettings as { runsOnlyOn?: unknown } | undefined)
		?.runsOnlyOn;
	const readable = plain as unknown as Pick<
		BlueprintDoc,
		"fields" | "forms" | "modules"
	>;
	const owners = [
		["field", Object.keys(readable.fields)],
		["form", Object.keys(readable.forms)],
		["module", Object.keys(readable.modules)],
	] as const;
	for (const [entity, uuids] of owners)
		for (const uuid of uuids)
			rewriteExpressionSlotValues(
				readable,
				{ entity, uuid: uuid as Uuid },
				(value) => (value === undefined ? value : EXPRESSION_PRESENT),
			);
	const asPaths = (value: unknown): unknown => {
		if (typeof value === "string") return pathOfAsset.get(value) ?? value;
		if (Array.isArray(value)) return value.map(asPaths);
		if (value !== null && typeof value === "object")
			return Object.fromEntries(
				Object.entries(value).map(([key, inner]) => [key, asPaths(inner)]),
			);
		return value;
	};
	return asPaths(plain) as Record<string, unknown>;
}

/** Every place two values differ, each as a path and both sides. */
function everyDifference(
	want: unknown,
	got: unknown,
	at = "",
	out: string[] = [],
): string[] {
	if (isDeepStrictEqual(want, got)) return out;
	if (
		want !== null &&
		got !== null &&
		typeof want === "object" &&
		typeof got === "object" &&
		Array.isArray(want) === Array.isArray(got) &&
		(!Array.isArray(want) || want.length === (got as unknown[]).length)
	) {
		const keys = new Set([
			...Object.keys(want as object),
			...Object.keys(got as object),
		]);
		for (const key of keys)
			everyDifference(
				(want as Record<string, unknown>)[key],
				(got as Record<string, unknown>)[key],
				`${at}/${key}`,
				out,
			);
		return out;
	}
	out.push(
		`${at}: want ${JSON.stringify(want)?.slice(0, 200)}, got ${JSON.stringify(got)?.slice(0, 200)}`,
	);
	return out;
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
						attribute: (name) =>
							table.attributes?.find((member) => member.wireName === name)?.id,
						property: (columnId, name) =>
							table.columns
								.find((column) => column.id === columnId)
								?.properties?.find((member) => member.wireName === name)?.id,
					};
		},
		definitions: new Map(definitions.map((table) => [table.id, table])),
	};
}

/** Whether some case operation of the document saves a write only when the
 *  worker changed its answer. */
function savesOnlyChangedAnswers(doc: BlueprintDoc): boolean {
	return Object.values(doc.forms).some((form) =>
		(form.caseOperations ?? []).some((operation) =>
			(operation.writes ?? []).some((write) => write.onlyIfChanged === true),
		),
	);
}

/** Why one document does not read back, or nothing where it does. */
async function readBack(
	document: CorpusDocument,
	doc: BlueprintDoc,
): Promise<string | null> {
	const { options, manifest, naming } = publishExpansion(document, doc);
	const assetOfPath = new Map<string, string>();
	const pathOfAsset = new Map<string, string>();
	for (const [assetId, asset] of manifest) {
		const path = `${JR_FILE}${asset.wirePath}`;
		pathOfAsset.set(assetId, path);
		if (!assetOfPath.has(path)) assetOfPath.set(path, assetId);
	}
	const pathOf = (assetId: string) => pathOfAsset.get(assetId) ?? assetId;
	const emitted = expandDoc(doc, options);
	// HQ's import replaces every top-level key the body carries
	// (`models/applications.py::_merge_source_into_app`).
	const body = {
		...retainedSourceBody("shell/app-source"),
		...(JSON.parse(JSON.stringify(emitted)) as Record<string, unknown>),
	};
	const catalog = lookupCatalog(document);
	// The project space holds the document's own levels, as a publish sets
	// them up, and a re-read mints what the document does not hold under the
	// app's own id.
	const levels = levelsAsPublished(doc);
	const overrides: Partial<ReaderInput> = {
		resolver: matchingResolver(
			doc.appId,
			externalIdentityMap(doc, DERIVED_WIRE_IDENTITY),
		),
		knownCaseTypes: knownCaseTypesOf(doc),
		// A publish of a document that saves an answer only where the worker
		// changed it reaches a project space that applies "save only if
		// changed", which a bring-in's probe of that project space reads.
		...(savesOnlyChangedAnswers(doc) && { saveOnlyEditedApplied: true }),
		recordDialect: recordDialectRoundTrip,
		// The project space a document's minimum configuration publishes to
		// holds no HIERARCHICAL_LOCATION_FIXTURE, so HQ's build gives a
		// suite's `locations` instance the flat fixture
		// (`suite_xml/post_process/instances.py::location_fixture_instances`),
		// which a reading of that project space observes.
		sourceProjectFactories: { locations: "flat" },
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
	const whole = everyDifference(
		wholeDocument(want, pathOfAsset),
		wholeDocument(outcome.draft.doc, pathOfAsset),
	);
	if (whole.length > 0)
		return `${whole.length} place(s) of the document differ: ${whole.slice(0, 6).join("; ")}`;
	const { declaration } = outcome.draft;
	const runsOnlyOn = doc.appSettings.runsOnlyOn;
	if (
		declaration.kind !== "choices" ||
		!declaration.choices.some((choice) => choice.runsOnlyOn === runsOnlyOn)
	)
		return `the reading offers no declaration for ${runsOnlyOn ?? "both platforms"}`;
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
	const failures: string[] = [];
	let read = 0;
	for (const document of publishedCorpus()) {
		let why: string | null;
		try {
			const doc = hydrated(document);
			// A document Nova's publish refuses never reaches CommCare HQ.
			if (publishRefuses(document, doc)) continue;
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
