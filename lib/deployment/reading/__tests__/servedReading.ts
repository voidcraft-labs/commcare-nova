/**
 * A reading of a source CommCare HQ could hold, built from a Nova document:
 * its export on HQ's own app shell, each form's XML open to a test's edit as
 * a person or HQ's form builder would change it, read by the production
 * reader as a first reading. No CommCare HQ has summarized such a source, so
 * its menus stand as ones HQ could not summarize, which the summary check
 * skips; a test that needs HQ's own summary reads `navigation-base`'s
 * retained answers instead.
 */

import type { Element } from "domhandler";
import { isTag } from "domhandler";
import type { HqAlignedModule } from "@/lib/commcare/hq/appReading";
import type { HqAppSource } from "@/lib/commcare/hq/appSource";
import type {
	AssetManifest,
	ResolvedMediaAsset,
} from "@/lib/commcare/multimedia/assetWirePath";
import type { ReaderInput } from "@/lib/commcare/reader";
import { exportedBody } from "@/lib/commcare/reader/__tests__/novaExport";
import { sourceFromBody } from "@/lib/commcare/reader/__tests__/readerInput";
import { serializeXml } from "@/lib/commcare/serializeXml";
import { parseXml } from "@/lib/commcare/xmlParse";
import type { MediaAssetRecord } from "@/lib/db/mediaAssets";
import type { BlueprintDoc } from "@/lib/domain";
import { walkAssetRefs } from "@/lib/domain/mediaRefs";
import type { MediaAssetId, MediaFormatValue } from "@/lib/domain/multimedia";
import type { AdoptedMediaFile } from "../../adoption";
import { readingEmission } from "../emission";
import { DOMAIN, HOST, readClean, readingInput } from "./acceptanceInput";

/** The first element under `root`, in document order, that `matches`. */
export function findElement(
	root: { readonly children: readonly unknown[] },
	matches: (element: Element) => boolean,
): Element | undefined {
	for (const child of root.children) {
		if (!isTag(child as Element)) continue;
		const element = child as Element;
		if (matches(element)) return element;
		const found = findElement(element, matches);
		if (found !== undefined) return found;
	}
	return undefined;
}

/** `xml` with `edit` applied to its parsed tree, serialized by Nova's own XML writer. */
export function editXml(
	xml: string,
	edit: (root: ReturnType<typeof parseXml>) => void,
): string {
	const root = parseXml(xml);
	edit(root);
	return serializeXml(root);
}

/** The body's controls, groups and repeats, by element name. */
const BODY_CONTROLS = new Set([
	"input",
	"select1",
	"select",
	"upload",
	"trigger",
	"secret",
	"group",
	"repeat",
]);

/** The body control, group or repeat whose `ref` or `nodeset` is `path`. */
export function controlAt(path: string) {
	return (element: Element): boolean =>
		BODY_CONTROLS.has(element.name) &&
		(element.attribs.ref === path || element.attribs.nodeset === path);
}

/** Each menu as one HQ could not summarize. */
export function unsummarized(source: HqAppSource): readonly HqAlignedModule[] {
	return source.modules.map((menu) => ({
		kind: "not-summarized",
		uniqueId: menu.uniqueId,
		docType: menu.docType,
		shape: { opens: "other", length: 0 },
	}));
}

/** HQ's source of `doc`'s export, each form's XML through `xml` where given. */
export async function servedSource(
	doc: BlueprintDoc,
	xml?: (xml: string) => string,
): Promise<HqAppSource> {
	return sourceFromBody(
		exportedBody(doc, {
			...(xml !== undefined && { xml }),
			expand: { attachmentTarget: { origin: HOST, domain: DOMAIN } },
		}),
	);
}

/** A first reading of `source`, read clean, with Nova's emission of its document. */
export function servedReading(
	source: HqAppSource,
	overrides: Partial<ReaderInput> = {},
	files: readonly AdoptedMediaFile[] = [],
) {
	const reader = readingInput(source, unsummarized(source), overrides);
	const outcome = readClean(reader);
	const emission = readingEmission({
		doc: outcome.draft.doc,
		source,
		draft: outcome.draft,
		reader,
		lookupDefinitions: [],
		files,
	});
	return { reader, outcome, emission };
}

/** One media file a source holds: its path, the asset id a reading names it by, its content. */
export interface ServedFile {
	readonly path: string;
	readonly assetId: MediaAssetId;
	readonly contentHash: string;
	readonly mediaFormat: MediaFormatValue;
	readonly mimeType: MediaAssetRecord["mimeType"];
}

/**
 * HQ's source of `doc`'s export with each image a slot references at the
 * path `files` gives its asset, and a reading of it whose media index
 * answers each path with the asset id `files` names there, with the held
 * files and the rows export readiness reads of them.
 */
export async function servedMediaReading(
	doc: BlueprintDoc,
	files: readonly ServedFile[],
	options: { readonly reading: (path: string) => MediaAssetId } = {
		reading: (path) => {
			const file = files.find((one) => one.path === path);
			if (file === undefined) throw new Error(`No file at ${path}.`);
			return file.assetId;
		},
	},
) {
	const assets = new Map<string, ResolvedMediaAsset>();
	for (const ref of walkAssetRefs(doc)) {
		const file = files.find((one) => one.assetId === ref.assetId);
		if (file === undefined) throw new Error(`No file for ${ref.assetId}.`);
		assets.set(ref.assetId, {
			assetId: ref.assetId,
			kind: ref.slotKind,
			wirePath: file.path.slice("jr://file/".length),
			mimeType: file.mimeType,
			contentHash: file.contentHash,
			extension: ".png",
		});
	}
	const source = await sourceFromBody(
		exportedBody(doc, {
			expand: {
				attachmentTarget: { origin: HOST, domain: DOMAIN },
				assets: assets as AssetManifest,
			},
		}),
	);
	const media: ReaderInput["media"] = {
		resolve: (path) =>
			files.some((one) => one.path === path)
				? { kind: "asset", assetId: options.reading(path), mediaKind: "image" }
				: { kind: "no-entry" },
	};
	const held = files.map((file) => ({
		hqPath: file.path,
		assetId: options.reading(file.path),
		contentHash: file.contentHash,
		extension: ".png",
	}));
	const read = servedReading(source, { media }, held);
	const rows = new Map<string, MediaAssetRecord>(
		files.map((file): [string, MediaAssetRecord] => {
			const id = options.reading(file.path);
			return [
				id,
				{
					id,
					project_id: "",
					owner: "",
					contentHash: file.contentHash,
					mimeType: file.mimeType,
					extension: ".png",
					sizeBytes: 64,
					mediaFormat: file.mediaFormat,
					kind: "image",
					gcsObjectKey: "",
					originalFilename: file.path,
					status: "ready",
					created_at: new Date(0),
				},
			];
		}),
	);
	return { ...read, media: { files: held, rows } };
}
