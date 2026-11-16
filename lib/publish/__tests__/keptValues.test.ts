/**
 * The kept list's words: a label for every label id and no two alike, a
 * sentence for every refresh answer, and the voice rules a machine can hold
 * over every string the file holds and over the title and message of each
 * kept advisory a `.ccz` carries.
 */

import { describe, expect, it } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { exportAdvisories } from "../exportAdvisories";
import {
	KEPT_FOLLOWS_LINE,
	KEPT_LABEL_IDS,
	KEPT_LABELS,
	KEPT_REFRESH_NOT_REACHED,
	type KeptRefreshKind,
	keptChanged,
	keptLead,
	keptRefreshSentence,
} from "../keptValues";

const KINDS: readonly KeptRefreshKind[] = [
	"refreshed",
	"changed-in-hq",
	"superseded",
	"no-baseline",
	"app-gone",
	"unreadable",
	"too-large",
	"browser-only",
	"key-not-accepted",
	"no-permission",
	"unavailable",
];

const CONTEXT = { date: "10 November", space: "acme-health" };

const refreshSentences = KINDS.flatMap((kind) =>
	[true, false].map((changed) =>
		keptRefreshSentence({ kind, changed }, CONTEXT),
	),
);
const leads = [keptLead(CONTEXT.date, true), keptLead(CONTEXT.date, false)];
const labels = KEPT_LABEL_IDS.map((id) => KEPT_LABELS[id]);
/** Every kept advisory a `.ccz` can carry, each fact holding. */
const keptAdvisories = exportAdvisories(
	buildDoc({ appName: "Kept values" }),
	"known",
	{
		uiTextFallsBack: true,
		androidLogos: true,
		practiceWorker: true,
		languageNames: true,
	},
);

describe("the labels", () => {
	it("words every label id, and no two alike", () => {
		expect(Object.keys(KEPT_LABELS).sort()).toEqual([...KEPT_LABEL_IDS].sort());
		expect(new Set(labels).size).toBe(labels.length);
	});
});

describe("the sentences", () => {
	it("answers every refresh outcome, with every placeholder filled", () => {
		for (const sentence of [...refreshSentences, ...leads]) {
			expect(sentence, sentence).not.toContain("{");
			expect(sentence, sentence).not.toContain("}");
		}
	});

	it("names the date and the project space where an answer speaks of them", () => {
		const sentence = (kind: KeptRefreshKind) =>
			keptRefreshSentence({ kind, changed: false }, CONTEXT);
		for (const kind of [
			"changed-in-hq",
			"unreadable",
			"too-large",
			"browser-only",
			"key-not-accepted",
			"no-permission",
		] as const) {
			expect(sentence(kind)).toContain(CONTEXT.date);
		}
		for (const kind of ["app-gone", "browser-only", "no-permission"] as const) {
			expect(sentence(kind)).toContain(CONTEXT.space);
		}
		for (const lead of leads) expect(lead).toContain(CONTEXT.date);
	});

	it("says whether a refresh changed anything kept", () => {
		expect(
			keptRefreshSentence({ kind: "refreshed", changed: true }, CONTEXT),
		).toBe("Updated. This is what CommCare HQ holds now.");
		expect(
			keptRefreshSentence({ kind: "refreshed", changed: false }, CONTEXT),
		).toBe("Nothing has changed. This is still what CommCare HQ holds.");
	});

	it("names no publish where a newer read landed during the refresh, since another refresh is one", () => {
		const sentence = keptRefreshSentence(
			{ kind: "superseded", changed: false },
			CONTEXT,
		);
		expect(sentence).toBe(
			"A publish or another read of CommCare HQ landed here while Nova was reading, so this is the latest Nova has.",
		);
	});

	it("words an app too large and a page meant for a browser as answers that stay, never as a passing fault", () => {
		const unavailable = keptRefreshSentence(
			{ kind: "unavailable", changed: false },
			CONTEXT,
		);
		for (const kind of ["too-large", "browser-only"] as const) {
			const sentence = keptRefreshSentence({ kind, changed: false }, CONTEXT);
			expect(sentence).not.toBe(unavailable);
			expect(sentence).not.toMatch(/in a moment/);
		}
	});
});

describe("keptChanged", () => {
	const kept = {
		labels: ["fuzzy-search", "sign-in-duration"] as const,
		valuesDigest: "a".repeat(64),
	};

	it("finds nothing changed for the same labels over the same values", () => {
		expect(keptChanged(kept, { ...kept, labels: [...kept.labels] })).toBe(
			false,
		);
		expect(keptChanged(null, null)).toBe(false);
	});

	it("finds a value that moved under a label listed on both sides", () => {
		expect(keptChanged(kept, { ...kept, valuesDigest: "b".repeat(64) })).toBe(
			true,
		);
	});

	it("finds a label added, taken away or moved, and a list on one side only", () => {
		expect(keptChanged(kept, { ...kept, labels: ["fuzzy-search"] })).toBe(true);
		expect(
			keptChanged(kept, {
				...kept,
				labels: ["sign-in-duration", "fuzzy-search"],
			}),
		).toBe(true);
		expect(keptChanged(kept, null)).toBe(true);
		expect(keptChanged(null, kept)).toBe(true);
	});
});

describe("the voice of every string", () => {
	const leadWithLabels = keptLead(CONTEXT.date, true);
	/** Whole sentences: each ends with a full stop. */
	const sentences = [
		...refreshSentences,
		keptLead(CONTEXT.date, false),
		KEPT_FOLLOWS_LINE,
		KEPT_REFRESH_NOT_REACHED,
		...keptAdvisories.map((advisory) => advisory.message),
	];
	/** Labels and advisory titles: no closing punctuation. */
	const titles = [
		...labels,
		...keptAdvisories.map((advisory) => advisory.title),
	];
	const everything = [...sentences, leadWithLabels, ...titles];

	it("reads every kept advisory", () => {
		expect(keptAdvisories.map((advisory) => advisory.id)).toEqual([
			"kept_ui_text_falls_back",
			"kept_android_logos_absent",
			"kept_practice_worker_absent",
			"kept_language_names_differ",
		]);
	});

	it("uses no em dash, no ellipsis and never the word import", () => {
		for (const text of everything) {
			expect(text, text).not.toContain("—");
			expect(text, text).not.toContain("…");
			expect(text, text).not.toContain("...");
			expect(text, text).not.toMatch(/\bimport\b/i);
		}
	});

	it("opens every string in sentence case", () => {
		for (const text of everything) expect(text, text).toMatch(/^\p{Lu}/u);
	});

	it("ends every sentence with a full stop, the lead above a list with its colon, and no label or title with either", () => {
		for (const text of sentences) expect(text.endsWith("."), text).toBe(true);
		expect(leadWithLabels.endsWith(":")).toBe(true);
		for (const text of titles) {
			expect(text.endsWith("."), text).toBe(false);
			expect(text.endsWith(":"), text).toBe(false);
		}
	});
});
