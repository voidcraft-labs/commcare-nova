/**
 * What an export says about itself when it succeeded but is not the whole
 * story.
 *
 * An advisory is NOT a refusal. `lib/export/boundaryValidation.ts` owns the
 * refusals, and its two mode-dependent findings both stop the export; the
 * facts here do not, because nothing about the app is wrong. The download
 * simply carries less than the same app published to a project space would,
 * and the person who asked for it deserves to know that before they hand the
 * file to somebody.
 *
 * This module is free of CommCare wire vocabulary on purpose: browser UI,
 * MCP responses, and the HTTP export boundary all read the same serializable
 * shape without letting a client reach into `lib/commcare` (which they are
 * not allowed to do anyway).
 */

import { type BlueprintDoc, isCaptureField } from "@/lib/domain";

export const EXPORT_ADVISORY_HEADER = "X-Nova-Export-Advisories";

export type ExportAdvisoryId = "attachment_links_without_target";

/**
 * Whether Nova could name the CommCare HQ project space an attachment link
 * resolves against.
 *
 * The three states mirror `lib/deployment/attachmentTarget.ts`'s resolution
 * without importing it: a caller passes its `kind` straight through. They are
 * named here rather than reduced to a boolean because "nowhere yet" and "more
 * than one place" leave a person with different next steps.
 */
export type AttachmentTargetState = "known" | "none" | "ambiguous";

/** One thing the export is telling the person who asked for it. */
export interface ExportAdvisory {
	readonly id: ExportAdvisoryId;
	readonly title: string;
	readonly message: string;
}

/**
 * The case properties a capture would fill with a link to its file.
 *
 * Read off the flat field map rather than walked per form: the advisory is
 * about the whole exported app, and every field in it lives here.
 */
function attachmentLinkProperties(doc: BlueprintDoc): readonly string[] {
	const properties = new Set<string>();
	for (const field of Object.values(doc.fields)) {
		if (!isCaptureField(field)) continue;
		if (field.caseWrite?.mode !== "url") continue;
		properties.add(field.caseWrite.property);
	}
	return [...properties].sort();
}

function nameList(names: readonly string[]): string {
	if (names.length < 2) return names[0] ?? "";
	if (names.length === 2) return `${names[0]} and ${names[1]}`;
	return `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
}

/**
 * Everything a downloaded `.ccz` or HQ-import file should say about itself.
 *
 * A publish never calls this: an upload IS the act of putting the app on a
 * project space, so its target is the one being published to and is never
 * missing. Only a file that leaves without one has anything to report.
 */
export function exportAdvisories(
	doc: BlueprintDoc,
	attachmentTarget: AttachmentTargetState,
): readonly ExportAdvisory[] {
	if (attachmentTarget === "known") return [];
	const properties = attachmentLinkProperties(doc);
	if (properties.length === 0) return [];

	const one = properties.length === 1;
	const subject = one
		? `The case property ${properties[0]} holds a link to an attached file`
		: `The case properties ${nameList(properties)} each hold a link to an attached file`;
	const them = one ? "it" : "them";
	const reason =
		attachmentTarget === "none"
			? `This app has not reached a CommCare project space yet, so there is no address to build from. Publishing the app and downloading again fills ${them} in.`
			: `More than one CommCare project space holds this app, so Nova cannot tell which one a link should point at. Publishing to the project space you want fills ${them} in there.`;

	return [
		{
			id: "attachment_links_without_target",
			title: "Attachment links are empty in this file",
			message: `${subject}, and the link's address comes from the project space the app is published to. ${reason}`,
		},
	];
}

/** Header-safe encoding for binary HTTP export responses. */
export function encodeExportAdvisories(
	advisories: readonly ExportAdvisory[],
): string {
	return encodeURIComponent(JSON.stringify(advisories));
}

/**
 * Decode an export header.
 *
 * Invalid or missing metadata reads as "nothing to say" rather than as a
 * failure: the bytes already arrived, and no advisory is worth turning a
 * successful download into an error.
 */
export function decodeExportAdvisories(
	value: string | null,
): readonly ExportAdvisory[] {
	if (!value) return [];
	try {
		const parsed: unknown = JSON.parse(decodeURIComponent(value));
		return Array.isArray(parsed) && parsed.every(isExportAdvisory)
			? parsed
			: [];
	} catch {
		return [];
	}
}

const EXPORT_ADVISORY_IDS = new Set<string>([
	"attachment_links_without_target",
]);

function isExportAdvisory(value: unknown): value is ExportAdvisory {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		typeof (value as Record<string, unknown>).id === "string" &&
		EXPORT_ADVISORY_IDS.has((value as Record<string, unknown>).id as string) &&
		typeof (value as Record<string, unknown>).title === "string" &&
		typeof (value as Record<string, unknown>).message === "string"
	);
}
