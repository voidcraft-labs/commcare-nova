/**
 * The per-form attachment cap.
 *
 * Formplayer counts attachments at SUBMIT time over the session's media
 * directory — `FormSubmissionHelper::getMultiPartFormBody` lists the
 * directory and throws when `files.length > maxAttachmentsPerForm`
 * (`formplayer.form.submit.max_attachments=50`) — and the whole
 * submission aborts. A worker has no way to shed a file, so a form whose
 * fixed capture questions alone exceed the cap is a dead end once it is
 * fully answered.
 *
 * The check bounds exactly what it can: non-repeating capture fields.
 * Captures inside a repeat produce one attachment per iteration and the
 * worker chooses the iteration count, so nothing at authoring time
 * bounds them — and this rule deliberately does not pretend otherwise.
 */

import { describe, expect, it } from "vitest";
import type { FieldSpec } from "@/lib/__tests__/docHelpers";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { MAX_FORM_ATTACHMENTS } from "@/lib/commcare/constants";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { proseText } from "@/lib/domain/prose";
import { runValidation } from "../runner";

function captures(count: number, prefix = "shot"): FieldSpec[] {
	return Array.from({ length: count }, (_, i) =>
		f({ kind: "image", id: `${prefix}_${i}`, label: `Photo ${i}` }),
	);
}

function docWithFields(fields: FieldSpec[]) {
	return buildDoc({
		appName: "Captures",
		modules: [{ name: "M", forms: [{ name: "F", type: "survey", fields }] }],
	});
}

function attachmentFindings(fields: FieldSpec[]) {
	return runValidation(
		docWithFields(fields),
		LOOKUP_CONTEXT_UNAVAILABLE,
	).filter((e) => e.code === "FORM_TOO_MANY_ATTACHMENTS");
}

describe("FORM_TOO_MANY_ATTACHMENTS", () => {
	it("accepts a form sitting exactly on the cap", () => {
		expect(attachmentFindings(captures(MAX_FORM_ATTACHMENTS))).toEqual([]);
	});

	it("rejects one capture past the cap, and names the count", () => {
		const findings = attachmentFindings(captures(MAX_FORM_ATTACHMENTS + 1));
		expect(findings).toHaveLength(1);
		expect(findings[0]?.details?.captureCount).toBe(
			String(MAX_FORM_ATTACHMENTS + 1),
		);
		expect(findings[0]?.message).toContain(String(MAX_FORM_ATTACHMENTS));
	});

	it("counts every capture kind, not just images", () => {
		const mixed: FieldSpec[] = [
			...captures(MAX_FORM_ATTACHMENTS - 3),
			f({ kind: "audio", id: "a", label: proseText("Audio") }),
			f({ kind: "video", id: "v", label: proseText("Video") }),
			f({ kind: "signature", id: "s", label: proseText("Signature") }),
			f({ kind: "file", id: "d", label: proseText("Document") }),
		];
		expect(attachmentFindings(mixed)).toHaveLength(1);
	});

	it("counts captures nested in a plain group", () => {
		const nested: FieldSpec[] = [
			...captures(MAX_FORM_ATTACHMENTS),
			f({
				kind: "group",
				id: "extra",
				label: proseText("Extra"),
				children: [
					f({ kind: "image", id: "one_more", label: proseText("One more") }),
				],
			}),
		];
		expect(attachmentFindings(nested)).toHaveLength(1);
	});

	it("does NOT count captures inside a repeat", () => {
		// Not leniency — honesty. A repeat's real attachment count is a
		// runtime quantity, so counting its template once would report a
		// bound the check cannot actually enforce.
		const inRepeat: FieldSpec[] = [
			...captures(MAX_FORM_ATTACHMENTS),
			f({
				kind: "repeat",
				id: "visits",
				label: proseText("Visits"),
				repeat_mode: "user_controlled",
				children: [
					f({ kind: "image", id: "visit_photo", label: proseText("Photo") }),
				],
			}),
		];
		expect(attachmentFindings(inRepeat)).toEqual([]);
	});

	it("ignores non-capture fields", () => {
		const noisy: FieldSpec[] = [
			...captures(MAX_FORM_ATTACHMENTS),
			...Array.from({ length: 20 }, (_, i) =>
				f({ kind: "text", id: `note_${i}`, label: `Note ${i}` }),
			),
			f({ kind: "barcode", id: "code", label: proseText("Code") }),
		];
		expect(attachmentFindings(noisy)).toEqual([]);
	});
});
