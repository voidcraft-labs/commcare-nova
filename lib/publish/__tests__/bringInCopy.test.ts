/**
 * The words of bringing an app in, held to `design/readme.md`'s rules for
 * copy over the whole file: no em dash, no ellipsis, no button label ending in
 * a period, and every string of two or more sentences ending in one. No
 * string's own words are pinned. The plausible failure is a later string that
 * breaks a rule of the voice; a sentence with a value is checked as each of
 * its forms reads.
 */
import { describe, expect, it } from "vitest";
import * as copy from "../bringInCopy";

type Copy = typeof copy;
type FunctionName = {
	[K in keyof Copy]: Copy[K] extends (...args: never[]) => unknown ? K : never;
}[keyof Copy];

const SHARED = { name: "Household visits", personal: false } as const;
const OWN = { name: "Amara's space", personal: true } as const;

/** Every form each function's sentence takes. A new function fails to compile until it has a row. */
const CALLS: { readonly [K in FunctionName]: () => readonly unknown[] } = {
	openAppAction: () => [copy.openAppAction("Household visits")],
	pickerProjectLine: () => [
		copy.pickerProjectLine(SHARED),
		copy.pickerProjectLine(OWN),
	],
	pickerOneSpaceLine: () => [copy.pickerOneSpaceLine("demo-space", "US")],
	pickerAppsLoadingLine: () => [copy.pickerAppsLoadingLine("demo-space")],
	pickerNoAppsLine: () => [copy.pickerNoAppsLine("demo-space")],
	pickerNoMatchLine: () => [copy.pickerNoMatchLine("demo-space")],
	pickerListFailedLine: () => [copy.pickerListFailedLine("demo-space")],
	readingStatusLine: () => [
		copy.readingStatusLine("Household visits"),
		copy.readingStatusLine(null),
	],
	stopNothingChangedLine: () => [
		copy.stopNothingChangedLine("read"),
		copy.stopNothingChangedLine("create"),
	],
	accountHeadingLine: () => [
		copy.accountHeadingLine("yet", "Household visits"),
		copy.accountHeadingLine("yet", null),
		copy.accountHeadingLine("this-time", "Household visits"),
		copy.accountHeadingLine("this-time", null),
	],
	accountLead: () => [
		copy.accountLead("yet", "read"),
		copy.accountLead("yet", "create"),
		copy.accountLead("this-time", "read"),
		copy.accountLead("this-time", "create"),
	],
	accountCountPart: () =>
		(["not-yet", "never", "fix-in-hq"] as const).flatMap((standing) => [
			copy.accountCountPart(standing, 1),
			copy.accountCountPart(standing, 3),
		]),
	foldedRunLine: () => [copy.foldedRunLine(24)],
	accountTextFirstLine: () => [
		copy.accountTextFirstLine(
			copy.accountHeadingLine("yet", "Household visits"),
			"demo-space",
			"15 November 2026",
		),
	],
	reviewHeading: () => [
		copy.reviewHeading("Household visits"),
		copy.reviewHeading(null),
	],
	reviewCountsLine: () => [
		copy.reviewCountsLine({ menus: 1, forms: 1, questions: 1, languages: 1 }),
		copy.reviewCountsLine({ menus: 4, forms: 9, questions: 120, languages: 2 }),
	],
	reviewCaseTypesLine: () => [
		copy.reviewCaseTypesLine(["household", "household_member"]),
	],
	reviewProjectLine: () => [
		copy.reviewProjectLine(SHARED),
		copy.reviewProjectLine(OWN),
	],
	reviewTablesProjectLine: () => [
		copy.reviewTablesProjectLine("Household visits"),
	],
	splitDatetimeLine: () => [
		copy.splitDatetimeLine(1),
		copy.splitDatetimeLine(3),
	],
	platformOutBlock: () =>
		(["web-apps", "android"] as const).flatMap((platform) => [
			copy.platformOutBlock({
				platform,
				features: ["datetime-question"],
				media: false,
			}),
			copy.platformOutBlock({ platform, features: [], media: true }),
			copy.platformOutBlock({
				platform,
				features: ["datetime-question", "list-first"],
				media: true,
			}),
		]),
	reviewAfterPublishLine: () => [copy.reviewAfterPublishLine("demo-space")],
	broughtInToastBody: () => [
		copy.broughtInToastBody("Household visits", "demo-space"),
	],
	broughtInFromLine: () => [
		copy.broughtInFromLine("demo-space", "15 November 2026", "Amara Okafor"),
	],
	notPublishedYetLine: () => [copy.notPublishedYetLine("15 November 2026")],
	stoppedPublishingLine: () => [copy.stoppedPublishingLine("demo-space")],
	broughtInToolMessage: () => [
		copy.broughtInToolMessage("Household visits", "demo-space"),
	],
};

/** Every string a value holds, leaving out a platform block's feature labels, which are the platform table's. */
function stringsOf(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.flatMap(stringsOf);
	if (value !== null && typeof value === "object") {
		return Object.entries(value).flatMap(([key, inner]) =>
			key === "features" ? [] : stringsOf(inner),
		);
	}
	return [];
}

function everyString(): string[] {
	const strings: string[] = [];
	for (const [name, value] of Object.entries(copy)) {
		if (typeof value === "function") {
			strings.push(...stringsOf(CALLS[name as FunctionName]()));
		} else {
			strings.push(...stringsOf(value));
		}
	}
	return strings;
}

/** A sentence ends inside the string where a full stop, question or exclamation mark is followed by more text. */
function sentenceCount(text: string): number {
	return (text.match(/[.!?](?=\s+\S)/g)?.length ?? 0) + 1;
}

describe("bringInCopy", () => {
	it("gives every function of the file its forms", () => {
		const functions = Object.entries(copy)
			.filter(([, value]) => typeof value === "function")
			.map(([name]) => name)
			.sort();
		expect(Object.keys(CALLS).sort()).toEqual(functions);
	});

	it("holds no em dash", () => {
		for (const text of everyString()) expect(text).not.toContain("—");
	});

	it("holds no ellipsis", () => {
		for (const text of everyString()) {
			expect(text).not.toContain("…");
			expect(text).not.toContain("...");
		}
	});

	it("ends no label of a button in a period", () => {
		const labels = [
			...Object.values(copy.BRING_IN_ACTIONS),
			copy.openAppAction("Household visits"),
		];
		for (const label of labels) {
			expect(label.trim()).toBe(label);
			expect(label.endsWith(".")).toBe(false);
		}
	});

	it("ends every string of two or more sentences in one", () => {
		const several = everyString().filter((text) => sentenceCount(text) >= 2);
		expect(several.length).toBeGreaterThan(0);
		for (const text of several) expect(text).toMatch(/[.!?]$/);
	});
});
