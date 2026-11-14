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

import { type BlueprintDoc, caseWriteValueField } from "@/lib/domain";

export const EXPORT_ADVISORY_HEADER = "X-Nova-Export-Advisories";

export type ExportAdvisoryId =
	| "attachment_links_without_target"
	| "kept_ui_text_falls_back"
	| "kept_android_logos_absent"
	| "kept_practice_worker_absent"
	| "kept_language_names_differ";

/** The advisories that say what a `.ccz` cannot follow of a kept value. */
export type KeptExportAdvisoryId = Extract<ExportAdvisoryId, `kept_${string}`>;

/**
 * Whether Nova could name the CommCare HQ project space an attachment link
 * resolves against.
 *
 * A download's caller reads the state off the project space it resolved
 * (`lib/deployment/downloadTarget.ts::downloadAttachmentState`). The three
 * are named here rather than reduced to a boolean because "nowhere yet" and
 * "more than one place" leave a person with different next steps.
 */
export type AttachmentTargetState = "known" | "none" | "ambiguous";

/** What a `.ccz` cannot follow of what its project space holds. Plain booleans: no wire vocabulary. */
export interface KeptAdvisoryFacts {
	readonly uiTextFallsBack: boolean;
	readonly androidLogos: boolean;
	readonly practiceWorker: boolean;
	/** Some language name in the archive is Nova's where CommCare HQ holds none. */
	readonly languageNames: boolean;
}

/**
 * What a person reads for each kept advisory, in the order a download lists
 * them. Each is said only where its fact holds: the archive was made for a
 * project space that keeps something it cannot carry.
 */
const KEPT_ADVISORIES: readonly {
	readonly id: KeptExportAdvisoryId;
	readonly when: keyof KeptAdvisoryFacts;
	readonly title: string;
	readonly message: string;
}[] = [
	{
		id: "kept_ui_text_falls_back",
		when: "uiTextFallsBack",
		title: "Some of CommCare's own wording differs in this file",
		message:
			"This project space rewords some of CommCare's own screens. This CCZ carries each rewording it holds. Where a language has none, an app installed from CommCare HQ shows CommCare HQ's translation and this file shows the phone's built-in wording.",
	},
	{
		id: "kept_android_logos_absent",
		when: "androidLogos",
		title: "This file has no Android logos",
		message:
			"This project space's app has its own logos for the Android home, sign-in or practice screen. They live in CommCare HQ, so this CCZ shows CommCare's own. An app installed from CommCare HQ shows yours.",
	},
	{
		id: "kept_practice_worker_absent",
		when: "practiceWorker",
		title: "Practice mode uses CommCare's sample worker in this file",
		message:
			"This project space's app has a practice mobile worker. That worker's data lives in CommCare HQ, so practice mode in this CCZ opens CommCare's own sample worker.",
	},
	{
		id: "kept_language_names_differ",
		when: "languageNames",
		title: "Some language names may differ in this file",
		message:
			"CommCare HQ names a language itself where this app gives none, and this CCZ uses Nova's name for it. The language picker may show a different spelling than an app installed from CommCare HQ.",
	},
];

/** One thing the export is telling the person who asked for it. */
export interface ExportAdvisory {
	readonly id: ExportAdvisoryId;
	readonly title: string;
	readonly message: string;
}

/**
 * The case properties a capture would fill with a link to its file: every
 * case operation's write whose value is the `capture-link` of a capture.
 *
 * Read off every form's operations rather than per module: the advisory is
 * about the whole exported app, wherever the link lands.
 */
function attachmentLinkProperties(doc: BlueprintDoc): readonly string[] {
	const properties = new Set<string>();
	for (const form of Object.values(doc.forms)) {
		for (const operation of form.caseOperations ?? []) {
			for (const write of operation.writes ?? []) {
				if (caseWriteValueField(write.value)?.link === true) {
					properties.add(write.property);
				}
			}
		}
	}
	return [...properties].sort();
}

function nameList(names: readonly string[]): string {
	if (names.length < 2) return names[0] ?? "";
	if (names.length === 2) return `${names[0]} and ${names[1]}`;
	return `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
}

/**
 * Everything a downloaded `.ccz` or HQ-import file should say about itself:
 * the attachment links it leaves empty first, then what a `.ccz` cannot
 * follow of the values its project space keeps (`kept`, null for a file
 * made for no project space read, the HQ import file among them).
 *
 * A publish never calls this: an upload IS the act of putting the app on a
 * project space, so its target is the one being published to and is never
 * missing, and what that project space keeps stays there. Only a file that
 * leaves has anything to report.
 */
export function exportAdvisories(
	doc: BlueprintDoc,
	attachmentTarget: AttachmentTargetState,
	kept: KeptAdvisoryFacts | null,
): readonly ExportAdvisory[] {
	return [
		...attachmentAdvisories(doc, attachmentTarget),
		...(kept === null
			? []
			: KEPT_ADVISORIES.filter((advisory) => kept[advisory.when]).map(
					({ id, title, message }) => ({ id, title, message }),
				)),
	];
}

/** The attachment links a file made without one known project space leaves empty. */
function attachmentAdvisories(
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
	...KEPT_ADVISORIES.map((advisory) => advisory.id),
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
