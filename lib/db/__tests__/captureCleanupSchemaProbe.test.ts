import { describe, expect, it } from "vitest";
import {
	assertCaptureCleanupSchema,
	CAPTURE_CLEANUP_EXPECTED_COLUMNS,
} from "../captureCleanupSchemaProbe";

describe("capture cleanup schema probe", () => {
	it("accepts the one exact post-cutover column contract", () => {
		expect(() =>
			assertCaptureCleanupSchema(CAPTURE_CLEANUP_EXPECTED_COLUMNS),
		).not.toThrow();
	});

	it("rejects a legacy text field identity", () => {
		const legacy = CAPTURE_CLEANUP_EXPECTED_COLUMNS.map((column) =>
			column.name === "field_uuid" ? { ...column, type: "text" } : column,
		);
		expect(() => assertCaptureCleanupSchema(legacy)).toThrow(
			"Capture-cleanup schema drifted",
		);
	});

	it("rejects added, removed, reordered, or nullable columns", () => {
		expect(() =>
			assertCaptureCleanupSchema(CAPTURE_CLEANUP_EXPECTED_COLUMNS.slice(1)),
		).toThrow("Capture-cleanup schema drifted");
		expect(() =>
			assertCaptureCleanupSchema([
				...CAPTURE_CLEANUP_EXPECTED_COLUMNS,
				{ name: "legacy_field_path", type: "text", notNull: false },
			]),
		).toThrow("Capture-cleanup schema drifted");
		expect(() =>
			assertCaptureCleanupSchema(
				CAPTURE_CLEANUP_EXPECTED_COLUMNS.map((column) =>
					column.name === "attachment_id"
						? { ...column, notNull: false }
						: column,
				),
			),
		).toThrow("Capture-cleanup schema drifted");
	});
});
