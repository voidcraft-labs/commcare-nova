/**
 * The form fixed point: every form of the compiler's fuzz documents, written
 * by the production emitter and read back by the reader, gives back the
 * fields the document held.
 *
 * Contract: for each fuzz document, its export (the HQ source the expander
 * writes, on CommCare HQ's own shell, with a media index that answers each
 * path the emitter wrote with the asset it names) reads with no finding, and
 * each form's fields compare equal to the document's once the reader's
 * canonical choices are applied to it: path, kind and order, repeat mode and
 * the query placement every export reads, `fieldList`, sections, the Phone
 * Number keypad, the plain flags, the choices and their values, the media of
 * each slot, and each text in each language as a worker reads it.
 *
 * Plausible failures: a slot the emitter writes that the reader does not
 * read; one of Nova's generated nodes read as a question; a row of the kind
 * table that names the wrong kind; a canonical choice applied where the two
 * documents of its pair print different sources.
 */

import fc from "fast-check";
import { expect, it } from "vitest";
import { manifestFor } from "@/lib/commcare/__tests__/compilerEvidence";
import { blueprintDocArbitrary } from "@/lib/commcare/__tests__/xformDocArbitrary";
import type {
	BlueprintDoc,
	Field,
	LanguageTag,
	Media,
	MediaKind,
	Uuid,
} from "@/lib/domain";
import { formStructure } from "@/lib/domain/expression/formStructure";
import {
	effectiveAppLocalization,
	makeTranslationUnitId,
} from "@/lib/domain/localization";
import { projectProseTemplate } from "@/lib/domain/prose";
import { effectiveQueryRepeatPlacement } from "@/lib/domain/queryRepeatPlacement";
import { filledProse } from "@/lib/domain/translationFill";
import { snapshotTranslationUnits } from "@/lib/domain/translationUnits";
import { expandDoc } from "../../../expander";
import { inputFor } from "../../__tests__/novaExport";
import { retainedSourceBody } from "../../__tests__/readerInput";
import { READER_CANONICAL_CHOICES } from "../../assemble";
import { readHqApp } from "../../index";
import type { ReaderMediaResolution } from "../../types";

const JR_FILE = "jr://file/";
const TEXT_SLOTS = ["label", "hint", "help", "validate_msg"] as const;
const MEDIA_SLOTS = ["label_media", "help_media"] as const;

/** What one field is to a person and a runtime, with identities read as paths. */
interface FieldFacts {
	readonly path: string;
	readonly kind: Field["kind"];
	readonly repeatMode?: string;
	readonly placement?: string;
	readonly fieldList?: boolean;
	readonly keypad?: string;
	readonly plainLabel?: boolean;
	readonly plainHelp?: boolean;
	readonly media: Readonly<Record<string, Readonly<Record<string, string>>>>;
	readonly texts: Readonly<Record<string, Readonly<Record<string, string>>>>;
	readonly choices?: readonly {
		readonly value: string;
		readonly plainLabel?: boolean;
		readonly media: Readonly<Record<string, string>>;
		readonly texts: Readonly<Record<string, string>>;
	}[];
}

/** Each slot kind's file, as the media index or the emitter's manifest names it. */
function mediaPaths(
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

/** The fields of one form in data-tree order. */
function formFacts(
	doc: BlueprintDoc,
	formUuid: Uuid,
	pathOf: (assetId: string) => string,
): FieldFacts[] {
	const structure = formStructure(doc, formUuid);
	const out: FieldFacts[] = [];
	const walk = (parent: Uuid, prefix: string) => {
		for (const uuid of doc.fieldOrder[parent] ?? []) {
			const field = doc.fields[uuid] as Field;
			const path = `${prefix}/${field.id}`;
			const record = field as Record<string, unknown>;
			const texts: Record<string, Record<string, string>> = {};
			for (const slot of TEXT_SLOTS) {
				const text = textsOf(doc, makeTranslationUnitId("field", uuid, slot));
				if (Object.keys(text).length > 0) texts[slot] = text;
			}
			const media: Record<string, Record<string, string>> = {};
			for (const slot of MEDIA_SLOTS) {
				const files = mediaPaths(record[slot] as Media | undefined, pathOf);
				if (Object.keys(files).length > 0) media[slot] = files;
			}
			const repeatMode = record.repeat_mode as string | undefined;
			out.push({
				path,
				kind: field.kind,
				...(repeatMode === undefined ? {} : { repeatMode }),
				...(repeatMode === "query_bound" && structure !== undefined
					? { placement: effectiveQueryRepeatPlacement(structure, uuid) }
					: {}),
				...(record.fieldList === true ? { fieldList: true } : {}),
				...(record.keypad === undefined
					? {}
					: { keypad: String(record.keypad) }),
				...(record.plainLabel === true ? { plainLabel: true } : {}),
				...(record.plainHelp === true ? { plainHelp: true } : {}),
				media,
				texts,
				...("optionsSource" in field && field.optionsSource.kind === "inline"
					? {
							choices: field.optionsSource.options.map((option) => ({
								value: option.value,
								...(option.plainLabel === true ? { plainLabel: true } : {}),
								media: mediaPaths(option.media, pathOf),
								texts: textsOf(
									doc,
									makeTranslationUnitId("field", uuid, "option", option.uuid),
								),
							})),
						}
					: {}),
			});
			walk(uuid, path);
		}
	};
	walk(formUuid, "");
	return out;
}

/** Every form's fields, in the document's menu and form order. */
function documentFacts(
	doc: BlueprintDoc,
	pathOf: (assetId: string) => string,
): FieldFacts[][] {
	return doc.moduleOrder.flatMap((moduleUuid) =>
		(doc.formOrder[moduleUuid] ?? []).map((formUuid) =>
			formFacts(doc, formUuid, pathOf),
		),
	);
}

/** The document as the reader returns its pair's member. */
function canonical(doc: BlueprintDoc): BlueprintDoc {
	return READER_CANONICAL_CHOICES.reduce(
		(current, choice) => choice.apply(current),
		doc,
	);
}

const MEDIA_KIND_OF_EXTENSION: Readonly<Record<string, MediaKind>> = {
	".png": "image",
	".wav": "audio",
	".mp4": "video",
};

it("reads back every form of the fuzz documents to its fields", {
	// Each run is one expansion, one served source and one whole reading; the
	// corpus took under 20s locally. Keep all runs and a scheduling margin.
	timeout: 60_000,
}, async () => {
	let forms = 0;
	await fc.assert(
		fc.asyncProperty(blueprintDocArbitrary, async (doc) => {
			const manifest = manifestFor(doc);
			const assetOfPath = new Map<string, string>();
			const pathOfAsset = new Map<string, string>();
			for (const [assetId, asset] of manifest) {
				const path = `${JR_FILE}${asset.wirePath}`;
				pathOfAsset.set(assetId, path);
				if (!assetOfPath.has(path)) assetOfPath.set(path, assetId);
			}
			// HQ's import replaces every top-level key the body carries
			// (`models/applications.py::_merge_source_into_app`), so the
			// languages and their strings are the export's own.
			const body = {
				...retainedSourceBody("shell/app-source"),
				...(JSON.parse(
					JSON.stringify(expandDoc(doc, { assets: manifest })),
				) as Record<string, unknown>),
			};
			const input = await inputFor(body, {
				media: {
					resolve: (path): ReaderMediaResolution => {
						const assetId = assetOfPath.get(path);
						if (assetId === undefined) return { kind: "no-entry" };
						const extension = path.slice(path.lastIndexOf("."));
						const mediaKind = MEDIA_KIND_OF_EXTENSION[extension];
						return mediaKind === undefined
							? { kind: "unreadable" }
							: { kind: "asset", assetId, mediaKind };
					},
				},
			});
			const outcome = readHqApp(input);
			if (outcome.kind !== "read")
				throw new Error(
					`The export read to an account: ${JSON.stringify(
						outcome.findings.map((finding) => [
							finding.code,
							finding.place,
							finding.detail.name,
						]),
					)}`,
				);
			const pathOf = (assetId: string) => pathOfAsset.get(assetId) ?? assetId;
			const read = documentFacts(outcome.draft.doc, (assetId) => {
				const path = [...assetOfPath].find(([, id]) => id === assetId)?.[0];
				return path ?? assetId;
			});
			const expected = documentFacts(canonical(doc), pathOf);
			expect(read).toEqual(expected);
			forms += expected.length;
		}),
		{ seed: 20261113, numRuns: 60 },
	);
	expect(forms).toBeGreaterThan(60);
});
