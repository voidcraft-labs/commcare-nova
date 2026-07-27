// lib/domain/captureFormats.ts
//
// What a worker may attach to a capture question, and where those bytes
// live while the form is being filled in.
//
// These are Nova constraints whose SIZE comes from CommCare — the same
// shape as `multimedia.ts`'s audio restriction, whose citation lives
// beside it rather than behind the `lib/commcare` emission boundary. The
// staged-upload lane is not emitting wire, so it must not import that
// boundary; the facts it needs are recorded here instead.
//
// The authority for the accepted sets is
// `commcare-hq/corehq/ex-submodules/couchforms/const.py::VALID_ATTACHMENT_FILE_EXTENSION_MAP`,
// keyed by the browser `accept` string each capture kind uses. HQ publishes
// that map to the browser as `valid_multimedia_extensions_map`
// (`cloudcare/views.py`) and `entries.js::FileEntry` enforces it at pick
// time. It is effectively the ONLY gate: HQ's receiver check
// (`getters.py::_valid_attachment_file`) is disjunctive and its MIME arm
// accepts `application/octet-stream`, which is exactly Formplayer's own
// default when it cannot sniff a type — so the accept list is what
// actually decides, and Nova enforcing the same set is Nova matching the
// device rather than Nova being strict.

import type { PersistableDoc } from "./blueprint";
import { type CaptureFieldKind, isCaptureFieldKind } from "./fields";

/**
 * The largest capture a worker may attach, in bytes.
 *
 * Decimal 4,000,000 — the literal in
 * `entries.js::FileEntry.prototype.onAnswerChange` (`size > 4000000`),
 * which is the only cap a worker normally meets. Formplayer's own
 * `MediaValidator::MAX_BYTES_PER_ATTACHMENT` is `4 * 1048576 - 1024` =
 * 4,193,280, so quoting 4 MB is honest and the extra 193 KB is never
 * promised. Nova deliberately does NOT surface Formplayer's oversize
 * message, which advertises "3 MB" while enforcing ~4 MB.
 */
export const MAX_CAPTURE_BYTES = 4_000_000;

/** CommCare's submitted multipart cap. Repeated capture questions count too. */
export const MAX_SUBMITTED_CAPTURE_COUNT = 50;

/**
 * A form entry may temporarily own more rows than it can submit because
 * replace/clear cleanup is asynchronous. The bounded headroom prevents a
 * request loop from turning one entry key into unbounded metadata.
 */
export const MAX_CAPTURE_ROWS_PER_ENTRY = 100;

/** Actor-scoped upload initiations admitted per fixed database minute. */
export const MAX_CAPTURE_ATTEMPTS_PER_MINUTE = 120;

/** Hard metadata bound across durable and in-flight capture rows. */
export const MAX_PROJECT_CAPTURE_ROWS = 100_000;

/** Fifty maximum-sized captures: the form-wide submitted byte ceiling. */
export const MAX_SUBMITTED_CAPTURE_BYTES =
	MAX_SUBMITTED_CAPTURE_COUNT * MAX_CAPTURE_BYTES;

/**
 * Durable captured-data allowance per Project. Unlike authoring media, capture
 * bytes are submission evidence and are not deduplicated.
 */
export const MAX_PROJECT_CAPTURE_BYTES = 10_000_000_000;

/** Match a concrete repeat-indexed engine path to its committed template. */
export function captureInstancePathMatchesTemplate(
	actual: string,
	template: string,
): boolean {
	const actualParts = actual.split("/");
	const templateParts = template.split("/");
	if (actualParts.length !== templateParts.length) return false;
	for (let index = 0; index < templateParts.length; index++) {
		const expected = templateParts[index] ?? "";
		const received = actualParts[index] ?? "";
		if (expected.endsWith("[0]")) {
			const base = expected.slice(0, -3);
			if (!received.startsWith(`${base}[`) || !received.endsWith("]")) {
				return false;
			}
			const repeatIndex = received.slice(base.length + 1, -1);
			if (!/^(0|[1-9]\d*)$/.test(repeatIndex)) return false;
		} else if (received !== expected) {
			return false;
		}
	}
	return true;
}

/**
 * Resolve a capture's authored engine path and containing form from one
 * committed document. Repeat containers carry `[0]` as the template marker.
 */
export function committedCapturePath(
	doc: PersistableDoc,
	fieldUuid: string,
): { formUuid: string; instancePathTemplate: string } | undefined {
	const walk = (
		parentUuid: string,
		prefix: string,
		formUuid: string,
	): { formUuid: string; instancePathTemplate: string } | undefined => {
		for (const childUuid of doc.fieldOrder[parentUuid] ?? []) {
			const field = doc.fields[childUuid];
			if (field === undefined) continue;
			const path = `${prefix}/${field.id}`;
			if (childUuid === fieldUuid && isCaptureFieldKind(field.kind)) {
				return { formUuid, instancePathTemplate: path };
			}
			if (doc.fieldOrder[childUuid] !== undefined) {
				const childPrefix = field.kind === "repeat" ? `${path}[0]` : path;
				const found = walk(childUuid, childPrefix, formUuid);
				if (found !== undefined) return found;
			}
		}
		return undefined;
	};
	for (const formUuid of Object.keys(doc.forms)) {
		const found = walk(formUuid, "/data", formUuid);
		if (found !== undefined) return found;
	}
	return undefined;
}

/**
 * Accepted file extensions per capture kind, lowercase and dot-led.
 *
 * Each list is the `VALID_ATTACHMENT_FILE_EXTENSION_MAP` entry for that
 * kind's browser `accept` string:
 *
 *   - `image`     → `image/*`
 *   - `signature` → `image/*,.pdf` (`entries.js::SignatureEntry.accept`).
 *     A signature is normally drawn rather than picked, so the pdf arm is
 *     unreachable through the pad — it is listed because the entry does
 *     accept it and a faithful lane must not reject what the device takes.
 *   - `audio`     → `audio/*`
 *   - `video`     → `video/*`
 *   - `file`      → `application/*,text/*` (`entries.js::DocumentEntry`,
 *     whose own `accept` attribute is the narrower
 *     `.pdf,.xlsx,.docx,.html,.txt,.rtf,.msg` — the same set)
 *
 * Total over `CaptureFieldKind`, so a new capture kind fails `tsc` until
 * it declares what it accepts.
 */
export const CAPTURE_EXTENSIONS_BY_KIND: Record<
	CaptureFieldKind,
	readonly string[]
> = {
	image: [".jpg", ".jpeg", ".png"],
	signature: [".jpg", ".jpeg", ".png", ".pdf"],
	audio: [".3ga", ".mp3", ".wav", ".amr", ".qcp", ".ogg"],
	video: [
		".3gpp",
		".3gp",
		".3gp2",
		".3g2",
		".mp4",
		".mpg4",
		".mpeg4",
		".m4v",
		".mpg",
		".mpeg",
	],
	file: [".docx", ".msg", ".pdf", ".xlsx", ".html", ".rtf", ".txt"],
};

/**
 * The lowercased dot-led extension a capture kind will accept for
 * `filename`, or `undefined` when the kind rejects it.
 *
 * Derives the extension by last dot, matching
 * `entries.js::FileEntry.prototype.onAnswerChange`'s `lastIndexOf(".")`
 * rather than Formplayer's `MediaValidator`, whose test is a suffix match
 * over the WHOLE filename (so `reportmp3` passes there). The browser's
 * behavior is the one a worker actually meets.
 */
export function captureExtensionFor(
	kind: CaptureFieldKind,
	filename: string,
): string | undefined {
	const dot = filename.lastIndexOf(".");
	if (dot === -1) return undefined;
	const ext = filename.slice(dot).toLowerCase();
	return CAPTURE_EXTENSIONS_BY_KIND[kind].includes(ext) ? ext : undefined;
}

/**
 * The browser `accept` attribute value for a capture kind's file input —
 * the extension list, which is what the OS picker filters on.
 *
 * Note what this is NOT: a promise of a camera. Web Apps binds `accept`
 * and nothing else on its file input — no `capture` attribute anywhere in
 * cloudcare — so every kind but signature opens the ordinary file picker.
 * A phone's picker may offer its camera as one option, but that is the
 * phone's menu and cannot be requested from here.
 */
export function captureAcceptAttribute(kind: CaptureFieldKind): string {
	return CAPTURE_EXTENSIONS_BY_KIND[kind].join(",");
}

/**
 * Content type to bind a staged capture's signed upload URL to.
 *
 * Deliberately extension-derived and deliberately incomplete: the
 * fallback is `application/octet-stream`, which is exactly what
 * `FormSubmissionHelper::createFilePart` sends when
 * `FileUtils::getContentType` cannot sniff a type, and what HQ's receiver
 * accepts as "the default mimetype set by CommCare". So an unmapped
 * extension is a normal outcome, not a gap to close — the extension
 * allowlist is the gate, and the content type is only a transport label.
 */
export function captureContentType(extension: string): string {
	return CAPTURE_CONTENT_TYPES[extension] ?? "application/octet-stream";
}

const CAPTURE_CONTENT_TYPES: Readonly<Record<string, string>> = {
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".ogg": "audio/ogg",
	".mp4": "video/mp4",
	".mpeg": "video/mpeg",
	".mpg": "video/mpeg",
	".m4v": "video/x-m4v",
	".pdf": "application/pdf",
	".txt": "text/plain",
	".html": "text/html",
	".rtf": "application/rtf",
	".docx":
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/**
 * The answer a capture question holds: the stored attachment's name.
 *
 * `<attachmentId><extension>` where the extension is dot-led, giving the
 * `<uuid>.<ext>` shape `MediaHandler.kt::saveFile` produces on the real
 * runtime. The name is SERVER-MINTED and derived from nothing about the
 * question — not the field id, not the node path, not the repeat index —
 * because CommCare's is not either, and a name derived from the field
 * would collide across repeat instances exactly where CommCare's does
 * not.
 *
 * Nova cannot produce CommCare's trailing-dot edge (`<uuid>.` when the
 * uploaded filename had no extension at all), because a capture with no
 * recognized extension is rejected before an id is minted. A consumer of
 * a capture answer must still not assume the value splits on a dot into
 * uuid plus real extension — a submission that went through Formplayer
 * can carry that shape.
 */
export function captureAttachmentName(
	attachmentId: string,
	extension: string,
): string {
	return `${attachmentId}${extension}`;
}

/**
 * Top-level prefix every STAGED capture object lives under, before its
 * form is submitted.
 *
 * Top-level for the same reason `PENDING_OBJECT_PREFIX` is: GCS lifecycle
 * prefix matching anchors at the object-name start, so one bucket rule
 * can reap abandoned staged captures only if the Project segment comes
 * AFTER the prefix. Submission promotes a kept capture out of this prefix
 * (`captureObjectKeyFor`) so the reaper can never eat one.
 */
export const STAGED_CAPTURE_PREFIX = "captures-staged/";

/** Key a capture's bytes occupy while its form is still being filled in. */
export function stagedCaptureObjectKeyFor(
	projectId: string,
	attachmentId: string,
	extension: string,
): string {
	return `${STAGED_CAPTURE_PREFIX}${projectId}/${attachmentId}${extension}`;
}

/**
 * Key a capture's bytes occupy once its form has been submitted.
 *
 * Under the per-Project namespace the media library also uses, so a
 * whole-tenant walk (a Project move, an eventual Project deletion) finds
 * captures by the same prefix it already walks for assets. NOT
 * content-addressed, unlike a library asset: two workers who attach
 * identical bytes have made two distinct observations with independent
 * lifecycles, and deduplicating them would let one submission's cleanup
 * destroy another's evidence.
 */
export function captureObjectKeyFor(
	projectId: string,
	attachmentId: string,
	extension: string,
): string {
	return `projects/${projectId}/captures/${attachmentId}${extension}`;
}
