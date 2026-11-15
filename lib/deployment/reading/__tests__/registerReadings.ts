/**
 * Readings the first-publish register's tests are held over: CommCare HQ's
 * retained sources of an app that read whole, and a reading of a document's
 * own export as CommCare HQ serves it. Every reading goes through the
 * production reader (`readHqApp`) over the source Nova's own reader of HQ's
 * source view gives.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
	retainedBodyJson,
	retainedGroupRead,
} from "@/__tests__/helpers/retainedHqReads";
import { recordDialectRoundTrip } from "@/lib/agent/authoring/recordRoundTrip";
import { manifestFor } from "@/lib/commcare/__tests__/compilerEvidence";
import type { HqAppSource } from "@/lib/commcare/hq/appSource";
import { exportedBody } from "@/lib/commcare/reader/__tests__/novaExport";
import {
	readerInput,
	sourceFromBody,
} from "@/lib/commcare/reader/__tests__/readerInput";
import { knownCaseTypesOf, readHqApp } from "@/lib/commcare/reader/index";
import type {
	ReadDraft,
	ReaderInput,
	ReaderMediaResolution,
} from "@/lib/commcare/reader/types";
import { DERIVED_WIRE_IDENTITY } from "@/lib/commcare/wireIdentity";
import type { AttachmentUrlTarget } from "@/lib/commcare/xform/captureUrlNode";
import type { BlueprintDoc, MediaKind, Uuid } from "@/lib/domain";

/** One whole reading: the source it read, the input it took and its draft. */
export interface RegisterReading {
	readonly name: string;
	readonly source: HqAppSource;
	readonly input: ReaderInput;
	readonly draft: ReadDraft;
}

/** Every retained app source under `proof/hq-reads/`, by the name `retainedGroupRead` takes. */
function retainedAppSources(): string[] {
	const root = join(process.cwd(), "proof/hq-reads");
	const names: string[] = [];
	for (const group of readdirSync(root, { withFileTypes: true })) {
		if (!group.isDirectory()) continue;
		for (const file of readdirSync(join(root, group.name)))
			if (file.startsWith("app-source") && file.endsWith(".json"))
				names.push(`${group.name}/${file.slice(0, -".json".length)}`);
	}
	return names.sort();
}

/** A whole reading of `source`, or what kept it out: its findings, or a reader defect. */
export function readWhole(
	name: string,
	source: HqAppSource,
	overrides: Partial<ReaderInput> = {},
): RegisterReading | { readonly name: string; readonly codes: string[] } {
	const input: ReaderInput = {
		...readerInput(source),
		recordDialect: recordDialectRoundTrip,
		...overrides,
	};
	const outcome = readHqApp(input);
	if (outcome.defects.length > 0)
		return {
			name,
			codes: outcome.defects.map((defect) => `defect ${defect.name}`),
		};
	if (outcome.kind !== "read")
		return {
			name,
			codes: outcome.findings.map(
				(finding) => `${finding.code} ${finding.detail.name ?? ""}`,
			),
		};
	return { name, source, input, draft: outcome.draft };
}

let retained: Promise<readonly RegisterReading[]> | undefined;

/**
 * CommCare HQ's retained sources of an app that read whole: Nova's exports
 * as HQ's import and its pages stored them, and the app HQ's own pages made.
 * A source that reads to an account holds content Nova does not hold yet,
 * which the reader's own tests name.
 */
export function retainedReadings(): Promise<readonly RegisterReading[]> {
	retained ??= (async () => {
		const readings: RegisterReading[] = [];
		for (const name of retainedAppSources()) {
			const reading = readWhole(
				name,
				await sourceFromBody(retainedBodyJson(retainedGroupRead(name))),
			);
			if ("draft" in reading) readings.push(reading);
		}
		return readings;
	})();
	return retained;
}

/** The project space every reading here is made for (`readerInput`'s target). */
export function readingTarget(reading: {
	readonly input: ReaderInput;
}): AttachmentUrlTarget {
	return reading.input.target;
}

/** The forms of a reading's `ReadFacts.forms`, in its order, each found by its `xmlns`. */
export function readingForms(draft: ReadDraft): { readonly uuid: Uuid }[] {
	return draft.facts.forms.map((form) => {
		const found = draft.identities.forms.find(
			(one) => one.xmlns === form.xmlns,
		);
		if (found === undefined)
			throw new Error(
				`The reading lists a form ${form.xmlns} its identities do not hold.`,
			);
		return { uuid: found.uuid };
	});
}

/** The forms of `doc` in the order a reading of its export lists them, each by its derived `xmlns`. */
export function exportForms(
	doc: BlueprintDoc,
	draft: ReadDraft,
): { readonly uuid: Uuid }[] {
	return draft.facts.forms.map((read) => {
		const form = Object.values(doc.forms).find(
			(one) => DERIVED_WIRE_IDENTITY.formXmlns(one) === read.xmlns,
		);
		if (form === undefined)
			throw new Error(
				`A reading of the export lists a form ${read.xmlns} the document does not hold.`,
			);
		return { uuid: form.uuid };
	});
}

const MEDIA_KIND_OF_EXTENSION: Readonly<Record<string, MediaKind>> = {
	".png": "image",
	".wav": "audio",
	".mp4": "video",
};

/**
 * A whole reading of `doc`'s export as CommCare HQ serves it, written for
 * `target` with the media its assets give, and read with a media index that
 * answers each path the export wrote with the asset it names.
 */
export async function readExport(
	doc: BlueprintDoc,
	target: AttachmentUrlTarget,
	overrides: Partial<ReaderInput> = {},
): Promise<RegisterReading> {
	const manifest = manifestFor(doc);
	const assetOfPath = new Map<string, string>();
	for (const [assetId, asset] of manifest) {
		const path = `jr://file/${asset.wirePath}`;
		if (!assetOfPath.has(path)) assetOfPath.set(path, assetId);
	}
	const source = await sourceFromBody(
		exportedBody(doc, {
			expand: {
				attachmentTarget: target,
				...(manifest.size > 0 && { assets: manifest }),
			},
		}),
	);
	const reading = readWhole(doc.appId, source, {
		knownCaseTypes: knownCaseTypesOf(doc),
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
		...overrides,
	});
	if (!("draft" in reading))
		throw new Error(
			`The export of ${doc.appId} read to an account: ${reading.codes.join(", ")}`,
		);
	return reading;
}
