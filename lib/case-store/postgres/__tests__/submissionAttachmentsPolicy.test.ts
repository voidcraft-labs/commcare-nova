import { describe, expect, it } from "vitest";
import { captureRowMatchesCommittedDescriptor } from "../submissionAttachments";

describe("capture submission metadata policy", () => {
	const confirmedImage = {
		originalFilename: "visit.jpg",
		extension: ".jpg",
		contentType: "image/jpeg",
	};

	it("accepts confirmed bytes only while the committed capture kind still accepts them", () => {
		expect(
			captureRowMatchesCommittedDescriptor(confirmedImage, {
				captureKind: "image",
				acceptedFormats: [
					{ extension: ".jpg", contentType: "image/jpeg" },
					{ extension: ".png", contentType: "image/png" },
				],
			}),
		).toBe(true);

		// Regression: the file confirmed while this was an image question.
		// A peer then converted the same stable field UUID to audio before
		// submit. UUID/path still match, but the committed kind must refuse
		// the stale image bytes.
		expect(
			captureRowMatchesCommittedDescriptor(confirmedImage, {
				captureKind: "audio",
				acceptedFormats: [
					{ extension: ".mp3", contentType: "audio/mpeg" },
					{ extension: ".wav", contentType: "audio/wav" },
				],
			}),
		).toBe(false);
	});

	it("rejects a row whose immutable content type disagrees with the committed extension", () => {
		expect(
			captureRowMatchesCommittedDescriptor(
				{ ...confirmedImage, contentType: "application/octet-stream" },
				{
					captureKind: "image",
					acceptedFormats: [{ extension: ".jpg", contentType: "image/jpeg" }],
				},
			),
		).toBe(false);
	});
});
