/**
 * Nova's emission of a document a reading of CommCare HQ's app gave, under
 * the source's own menu and form ids, `xmlns`, keyed case id prefixes,
 * project space, table names and media paths, and that emission wrapped as a
 * source the reader takes. Re-reading it is the fixed point a reading is held
 * to: Nova's bytes for the document read back to the document.
 *
 * The emission is `expandDoc`'s output and never passes through the overlay
 * of a publish's target: the re-read sees what Nova writes, not what a merge
 * would leave. It is built from the draft alone, so the same options are
 * given here as the reader's own comparisons are given
 * (`lib/commcare/reader/projectionInputs.ts`).
 */

import type { HqApplication } from "@/lib/commcare";
import {
	type ExpandOptions,
	expandDoc,
	expandDocSteps,
} from "@/lib/commcare/expander";
import type { HqAlignedModule } from "@/lib/commcare/hq/appReading";
import type {
	HqAppSource,
	HqAppSourceModule,
} from "@/lib/commcare/hq/appSource";
import { readBuildProfiles } from "@/lib/commcare/hq/buildProfiles";
import { parseHqJsonText } from "@/lib/commcare/hq/jsonText";
import { expectedXmlnsOf } from "@/lib/commcare/hq/sharedFormSource";
import { lookupWireNaming } from "@/lib/commcare/lookup/naming";
import type {
	AssetManifest,
	ResolvedMediaAsset,
} from "@/lib/commcare/multimedia/assetWirePath";
import type {
	ReadDraft,
	ReaderInput,
	ReadMediaReference,
} from "@/lib/commcare/reader";
import {
	targetWireIdentity,
	type WireIdentityOverride,
} from "@/lib/commcare/wireIdentity";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { NO_ENTRIES, recordFromEntries } from "@/lib/domain/records";
import type { LookupTableDefinition } from "@/lib/lookup/types";
import type { AdoptedMediaFile } from "../adoption";

const JR_FILE = "jr://file/";

/** What `expandDoc` reads of an asset is its path, so a file's type is not told apart. */
const UNREAD_MIME_TYPE = "application/octet-stream";

/** `jr://file/` taken off a path, as a wire path is written. */
function withoutJrFile(path: string): string {
	return path.startsWith(JR_FILE) ? path.slice(JR_FILE.length) : path;
}

/**
 * One resolved asset per asset id the references name, at the path the source
 * spells for it (the first in code-unit order of the paths its references
 * spell, `jr://file/` taken off), with the held file's own content hash and
 * extension and the reference's kind. Every asset a reference names is in
 * the map, since media emission throws for one it lacks.
 */
export function emissionAssets(
	references: readonly ReadMediaReference[],
	files: readonly AdoptedMediaFile[],
): AssetManifest {
	const fileOf = new Map<string, AdoptedMediaFile>(
		files.map((file) => [file.assetId, file]),
	);
	const kept = new Map<string, ReadMediaReference>();
	for (const reference of references) {
		const held = kept.get(reference.assetId);
		if (
			held === undefined ||
			withoutJrFile(reference.path) < withoutJrFile(held.path)
		)
			kept.set(reference.assetId, reference);
	}
	const assets = new Map<string, ResolvedMediaAsset>();
	for (const [assetId, reference] of kept) {
		const file = fileOf.get(assetId);
		if (file === undefined)
			throw new Error(
				"Nova tried to print a reading with its media and found no held file for an asset one of its references names. Every media reference of a reading resolves to a file the reading holds; the references and the files handed to acceptance are not from one read.",
			);
		assets.set(assetId, {
			assetId: file.assetId,
			wirePath: withoutJrFile(reference.path),
			kind: reference.mediaKind,
			mimeType: UNREAD_MIME_TYPE,
			contentHash: file.contentHash,
			extension: file.extension,
		});
	}
	return assets as AssetManifest;
}

/** What a reading's emission is made from. */
export interface ReadingEmissionInput {
	/** The document to print: the reading's, or the one a choice's split makes of it. */
	readonly doc: BlueprintDoc;
	readonly source: HqAppSource;
	readonly draft: ReadDraft;
	readonly reader: Pick<ReaderInput, "target">;
	/** The bound tables' definitions, under the reading's ids. */
	readonly lookupDefinitions: readonly LookupTableDefinition[];
	/** The held files. */
	readonly files: readonly AdoptedMediaFile[];
}

/** Nova's emission of a read document under the source's own ids, names and paths. */
export function readingEmission(input: ReadingEmissionInput): HqApplication {
	return expandDoc(input.doc, readingEmissionOptions(input));
}

/** `readingEmission` a part at a time (`expander.ts::expandDocSteps`). */
export function* readingEmissionSteps(
	input: ReadingEmissionInput,
): Generator<void, HqApplication, void> {
	return yield* expandDocSteps(input.doc, readingEmissionOptions(input));
}

/**
 * The options `readingEmission` prints with: the source's own menu ids, and
 * each form's `xmlns` with the id this read of the source gave it, which
 * every reference inside the source names it by; the project space the
 * source was read from; each bound table under the names CommCare HQ holds,
 * none where the reading bound none; each asset at the path the source
 * spells (`emissionAssets`); each keyed create under the id prefix its cases
 * stand under in the source; each case list column under the word its source
 * keeps its property under (`ReadMenuAndFormIdentities.columnFieldWords`); and
 * no runtime target, the neutral template the HQ JSON path always prints.
 */
export function readingEmissionOptions(
	input: ReadingEmissionInput,
): ExpandOptions {
	const { identities, facts } = input.draft;
	const overrides: WireIdentityOverride[] = identities.modules.map(
		(module) => ({
			entityKind: "module",
			novaEntityUuid: module.uuid,
			uniqueId: module.uniqueId,
			xmlns: null,
		}),
	);
	const sourceById = new Map(
		input.source.modules.flatMap((menu) =>
			menu.forms.map((form) => [form.readUniqueId, form] as const),
		),
	);
	for (const form of identities.forms) {
		const read = sourceById.get(form.readUniqueId);
		if (read === undefined)
			throw new Error(
				"Nova tried to print a reading under its source's own form ids and found no entry with the id from that read. Every form of a reading comes from a form of the source; the draft and the source handed to acceptance are not from one read.",
			);
		overrides.push({
			entityKind: "form",
			novaEntityUuid: form.uuid,
			uniqueId: read.readUniqueId,
			xmlns: read.xmlns,
		});
	}
	return {
		identity: targetWireIdentity(
			overrides,
			identities.columnFieldWords,
			identities.projectSearches,
			identities.installationProfiles,
		),
		attachmentTarget: {
			origin: input.reader.target.origin,
			domain: input.reader.target.domain,
		},
		...(input.lookupDefinitions.length > 0 && {
			lookupNaming: lookupWireNaming(input.lookupDefinitions),
		}),
		assets: emissionAssets(facts.mediaReferences, input.files),
		keyedCaseIdPrefixes: new Map<Uuid, string>(
			identities.keyedCreates.map((create) => [
				create.operationUuid,
				create.prefix,
			]),
		),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A string member, or null where the emission wrote none. */
function text(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

/** Each emission served once: the fixed point's re-read and identity agreement both read the
 *  served JSON of one emission, and neither writes to it. */
const servedEmissions = new WeakMap<HqApplication, Record<string, unknown>>();

/** The emission as the JSON CommCare HQ's source view serves. One object per emission, which
 *  no caller writes to. */
export function servedEmission(
	emission: HqApplication,
): Record<string, unknown> {
	const known = servedEmissions.get(emission);
	if (known !== undefined) return known;
	const body = parseHqJsonText(JSON.stringify(emission)) as Record<
		string,
		unknown
	>;
	servedEmissions.set(emission, body);
	return body;
}

const served = servedEmission;

/** Each menu of a served emission, with its forms as a source read gives them. */
function servedModules(
	body: Readonly<Record<string, unknown>>,
): HqAppSourceModule[] {
	const attachments = isRecord(body._attachments)
		? body._attachments
		: NO_ENTRIES;
	const modules = Array.isArray(body.modules) ? body.modules : [];
	return modules.filter(isRecord).map((module) => ({
		uniqueId: text(module.unique_id),
		docType: text(module.doc_type) ?? "",
		caseType: text(module.case_type),
		forms: (Array.isArray(module.forms) ? module.forms : [])
			.filter(isRecord)
			.map((form) => {
				const readUniqueId = text(form.unique_id) ?? "";
				const attachment = attachments[`${readUniqueId}.xml`];
				return {
					docType: text(form.doc_type) ?? "",
					xmlns: text(form.xmlns),
					readUniqueId,
					shadowParentReadId: text(form.shadow_parent_form_id),
					attachment: typeof attachment === "string" ? attachment : null,
				};
			}),
	}));
}

/**
 * The emission as the source a reader takes. Its `raw` is the emission as
 * served, `_attachments` included (the reader reads each form's source from
 * it), with the three keys Nova's body never carries and CommCare HQ keeps
 * through every update set to the source's own: `build_spec`, which the
 * version floor reads, `multimedia_map`, which the media reader walks, and
 * `logo_refs`, where the Web Apps logo is read. Every other key Nova's body
 * leaves out reads at its default, as no use.
 */
export function sourceFromEmission(
	emission: HqApplication,
	source: HqAppSource,
): HqAppSource {
	return sourceFromServed(served(emission), source);
}

/**
 * `sourceFromEmission` and `alignedFromEmission` of one emission, served
 * once: each reads the served JSON and writes none of it.
 */
export function readerSourceOfEmission(
	emission: HqApplication,
	source: HqAppSource,
	aligned: readonly HqAlignedModule[] = [],
): {
	readonly source: HqAppSource;
	readonly modules: readonly HqAlignedModule[];
} {
	const body = served(emission);
	const read = sourceFromServed(body, source);
	return { source: read, modules: alignedFromSource(read.modules, aligned) };
}

function sourceFromServed(
	body: Record<string, unknown>,
	source: HqAppSource,
): HqAppSource {
	const raw = recordFromEntries(Object.entries(body));
	for (const key of ["build_spec", "multimedia_map", "logo_refs"] as const) {
		const value = source.raw[key];
		if (value === undefined) delete raw[key];
		else raw[key] = value;
	}
	const modules = servedModules(body);
	return {
		docType: "Application",
		buildSpecVersion: source.buildSpecVersion,
		cloudcareEnabled: body.cloudcare_enabled === true,
		logoRefs: source.logoRefs,
		profile: (isRecord(body.profile)
			? body.profile
			: NO_ENTRIES) as HqAppSource["profile"],
		langs: Array.isArray(body.langs)
			? body.langs.filter((lang): lang is string => typeof lang === "string")
			: [],
		translations: (isRecord(body.translations)
			? body.translations
			: NO_ENTRIES) as HqAppSource["translations"],
		addOns: (isRecord(body.add_ons) ? body.add_ons : NO_ENTRIES) as Record<
			string,
			boolean
		>,
		modules,
		raw,
		name: text(body.name),
		lastModified: null,
		multimediaMap: source.multimediaMap,
		buildProfiles:
			readBuildProfiles(
				raw.build_profiles ?? NO_ENTRIES,
				new Set(Array.isArray(body.langs) ? body.langs : []),
				modules.length,
			) ?? [],
	};
}

/**
 * The emission's menus aligned with themselves: each form under its own
 * `unique_id`, with no question summary, since no CommCare HQ has summarized
 * the emission and the reader reads nothing of one.
 */
export function alignedFromEmission(
	emission: HqApplication,
): readonly HqAlignedModule[] {
	return alignedFromSource(servedModules(served(emission)), []);
}

function alignedFromSource(
	modules: readonly HqAppSourceModule[],
	original: readonly HqAlignedModule[],
): readonly HqAlignedModule[] {
	const realIds = new Map(
		original.flatMap((menu) =>
			menu.kind === "aligned"
				? menu.forms.map(
						(entry) => [entry.source.readUniqueId, entry.uniqueId] as const,
					)
				: [],
		),
	);
	const xmlnsFor = expectedXmlnsOf({ modules });
	return modules.map((module) => ({
		kind: "aligned",
		uniqueId: module.uniqueId,
		docType: module.docType,
		forms: module.forms.map((form) => ({
			uniqueId: realIds.get(form.readUniqueId) ?? form.readUniqueId,
			xmlns: xmlnsFor(form),
			source: form,
			questions: [],
		})),
	}));
}
