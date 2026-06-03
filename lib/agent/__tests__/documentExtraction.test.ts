// lib/agent/__tests__/documentExtraction.test.ts
//
// Unit tests for the extraction CORE: the `extractDocument` dispatch (PDF →
// native file block; text/docx/xlsx → markdown body → text condense) and the
// pure converters. Driven against a stubbed `AttachmentCondenser` so we assert
// the routing + the exact model input WITHOUT a network call. The xlsx path
// round-trips through the real SheetJS encoder so we verify the actual library
// contract, not a hand-rolled mock of its output shape.

import { describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";
import {
	type AttachmentCondenser,
	type CondenseResult,
	extractDocument,
} from "@/lib/agent/documentExtraction";

/* mammoth pulls in bluebird, which creates a module-level promise at import
 * time the async-leak detector flags. We exercise the docx path with a mocked
 * mammoth so the real module (and bluebird) never loads. */
vi.mock("mammoth", () => ({
	default: {
		convertToMarkdown: vi.fn(async () => ({ value: "# Doc heading\n\nbody" })),
	},
}));

/** A condenser that records the single call it received and returns a fixed
 *  result, so each test asserts which branch fired and with what input. The
 *  mocks are typed to the interface's methods so `mock.calls` carries the opts
 *  (and reads cleanly under `noUncheckedIndexedAccess`). */
function recordingCondenser(
	result: CondenseResult = { text: "EXTRACT", truncated: false },
) {
	const plainText = vi.fn<AttachmentCondenser["generatePlainText"]>(
		async () => result,
	);
	const fromContent = vi.fn<AttachmentCondenser["extractFromContent"]>(
		async () => result,
	);
	const condenser: AttachmentCondenser = {
		generatePlainText: plainText,
		extractFromContent: fromContent,
	};
	return { condenser, plainText, fromContent };
}

/** The `prompt` of the first `generatePlainText` call, or a clear failure. */
function plainTextPrompt(
	plainText: ReturnType<typeof recordingCondenser>["plainText"],
): string {
	const call = plainText.mock.calls.at(0);
	if (!call) throw new Error("generatePlainText was not called");
	return call[0].prompt;
}

describe("extractDocument", () => {
	it("routes a text document through generatePlainText with the filename + body", async () => {
		const { condenser, plainText, fromContent } = recordingCondenser();
		const result = await extractDocument({
			bytes: Buffer.from("danger signs: bleeding, fever", "utf-8"),
			mimeType: "text/markdown",
			kind: "text",
			filename: "notes.md",
			condenser,
		});
		expect(result).toEqual({ text: "EXTRACT", truncated: false });
		expect(fromContent).not.toHaveBeenCalled();
		expect(plainText).toHaveBeenCalledWith(
			expect.objectContaining({
				prompt: expect.stringContaining("Filename: notes.md"),
			}),
		);
		expect(plainText).toHaveBeenCalledWith(
			expect.objectContaining({
				prompt: expect.stringContaining("danger signs: bleeding, fever"),
			}),
		);
	});

	it("converts an xlsx document to a markdown table before condensing", async () => {
		const ws = XLSX.utils.aoa_to_sheet([
			["field", "type"],
			["mother_name", "text"],
		]);
		const wb = XLSX.utils.book_new();
		XLSX.utils.book_append_sheet(wb, ws, "Dictionary");
		const bytes = XLSX.write(wb, {
			type: "buffer",
			bookType: "xlsx",
		}) as Buffer;

		const { condenser, plainText } = recordingCondenser();
		await extractDocument({
			bytes,
			mimeType:
				"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			kind: "xlsx",
			filename: "dict.xlsx",
			condenser,
		});
		const prompt = plainTextPrompt(plainText);
		expect(prompt).toContain("Dictionary");
		expect(prompt).toContain("| field | type |");
		expect(prompt).toContain("| mother_name | text |");
	});

	it("converts a docx document via mammoth before condensing", async () => {
		const { condenser, plainText } = recordingCondenser();
		await extractDocument({
			bytes: Buffer.from("PK-docx-bytes"),
			mimeType:
				"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			kind: "docx",
			filename: "sow.docx",
			condenser,
		});
		const prompt = plainTextPrompt(plainText);
		expect(prompt).toContain("Filename: sow.docx");
		expect(prompt).toContain("# Doc heading");
	});

	it("routes a PDF through extractFromContent as a native data-URL file block", async () => {
		const bytes = Buffer.from("%PDF-1.7 fake", "utf-8");
		const { condenser, plainText, fromContent } = recordingCondenser();
		await extractDocument({
			bytes,
			mimeType: "application/pdf",
			kind: "pdf",
			filename: "form.pdf",
			condenser,
		});
		expect(plainText).not.toHaveBeenCalled();
		expect(fromContent).toHaveBeenCalledWith(
			expect.objectContaining({
				file: {
					mediaType: "application/pdf",
					data: `data:application/pdf;base64,${bytes.toString("base64")}`,
				},
			}),
		);
	});

	it("propagates the truncated flag from the condenser", async () => {
		const { condenser } = recordingCondenser({
			text: "PARTIAL",
			truncated: true,
		});
		const result = await extractDocument({
			bytes: Buffer.from("x"),
			mimeType: "text/plain",
			kind: "text",
			filename: "big.txt",
			condenser,
		});
		expect(result.truncated).toBe(true);
	});
});
