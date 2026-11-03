import { describe, expect, it } from "vitest";
import type { Platform } from "@/lib/domain/platforms";
import { formatTextGesture, formatTextOffLine } from "../formatText";

const BOTH: readonly Platform[] = ["web-apps", "android"];
const WEB_APPS: readonly Platform[] = ["web-apps"];
const ANDROID: readonly Platform[] = ["android"];

describe("the line under a text with Format text off", () => {
	it("says a label shows as typed on every declaration", () => {
		for (const platforms of [BOTH, WEB_APPS, ANDROID]) {
			expect(formatTextOffLine("label", platforms)).toBe(
				"Workers see this text as you typed it, without formatting.",
			);
		}
	});

	it("says only Android shows a choice as typed", () => {
		expect(formatTextOffLine("choice", BOTH)).toBe(
			"On Android, workers see this choice as you typed it. Web Apps formats every choice.",
		);
		expect(formatTextOffLine("choice", ANDROID)).toBe(
			"Workers see this choice as you typed it, without formatting.",
		);
		expect(formatTextOffLine("choice", WEB_APPS)).toBe(
			"Web Apps formats every choice, so workers see its formatting either way.",
		);
	});
});

describe("what pressing Format text does", () => {
	const never = () => {
		throw new Error("formatting was read when the gesture did not need it");
	};

	it("turns formatting back on at once, without reading the text", () => {
		expect(
			formatTextGesture({
				plain: true,
				isSource: true,
				holdsFormatting: never,
			}),
		).toEqual({ kind: "write", plainLabel: null });
	});

	it("turns a text with no formatting off at once", () => {
		expect(
			formatTextGesture({
				plain: false,
				isSource: true,
				holdsFormatting: () => false,
			}),
		).toEqual({ kind: "write", plainLabel: true });
	});

	it("asks first when the text uses formatting", () => {
		expect(
			formatTextGesture({
				plain: false,
				isSource: true,
				holdsFormatting: () => true,
			}),
		).toEqual({ kind: "confirm" });
	});

	it("changes nothing under a worker language other than the source", () => {
		for (const plain of [true, false]) {
			expect(
				formatTextGesture({ plain, isSource: false, holdsFormatting: never }),
			).toEqual({ kind: "none" });
		}
	});
});
