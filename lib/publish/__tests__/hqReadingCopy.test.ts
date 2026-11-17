import { describe, expect, it } from "vitest";
import type { CreateAnswer } from "@/lib/deployment";
import {
	READING_MAX_LISTED_FINDINGS,
	READING_REFUSAL_STATUS,
	READING_REFUSALS,
	READING_STAGES,
	type ReadingAnswer,
} from "@/lib/deployment/reading/types";
import {
	CREATE_ANSWER_LEADS,
	moreFindingsLine,
	READING_FAILED_COPY,
	READING_REFUSAL_COPY,
	READING_STAGE_LABELS,
	UNVERIFIED_LANDING_BODY,
	UNVERIFIED_LANDING_TITLE,
} from "../hqReadingCopy";

const COUNT = { done: 3, total: 12 };

function stageLabels(): string[] {
	return READING_STAGES.flatMap((stage) => {
		const label = READING_STAGE_LABELS[stage];
		return typeof label === "string" ? [label] : [label(null), label(COUNT)];
	});
}

function leads(): string[] {
	return [
		...Object.values(CREATE_ANSWER_LEADS.changed),
		CREATE_ANSWER_LEADS["read-again"],
		CREATE_ANSWER_LEADS["check-failed"],
		CREATE_ANSWER_LEADS.held,
		CREATE_ANSWER_LEADS.choicesDropped,
	];
}

function everySentence(): string[] {
	return [
		...Object.values(READING_REFUSAL_COPY),
		...leads(),
		...stageLabels(),
		moreFindingsLine(1),
		moreFindingsLine(500),
		UNVERIFIED_LANDING_TITLE,
		UNVERIFIED_LANDING_BODY,
		...Object.values(READING_FAILED_COPY).flatMap((form) => [
			form.title,
			form.body("Household survey"),
			form.body(null),
		]),
	];
}

describe("the refusals", () => {
	it("give every refusal a sentence and a status", () => {
		expect(Object.keys(READING_REFUSAL_COPY).sort()).toEqual(
			[...READING_REFUSALS].sort(),
		);
		expect(Object.keys(READING_REFUSAL_STATUS).sort()).toEqual(
			[...READING_REFUSALS].sort(),
		);
		for (const refusal of READING_REFUSALS) {
			expect(READING_REFUSAL_COPY[refusal].length, refusal).toBeGreaterThan(0);
			expect([200, 400, 403], refusal).toContain(
				READING_REFUSAL_STATUS[refusal],
			);
		}
	});
});

describe("the stages", () => {
	it("give every stage a label, and the two media stages one with a count and one with none", () => {
		for (const stage of READING_STAGES) {
			const label = READING_STAGE_LABELS[stage];
			if (stage === "checking-media" || stage === "bringing-in-media") {
				expect(typeof label, stage).toBe("function");
			} else {
				expect(typeof label, stage).toBe("string");
			}
		}
		expect(READING_STAGE_LABELS["checking-media"](null)).toBe(
			"Checking pictures and sounds",
		);
		expect(READING_STAGE_LABELS["checking-media"](COUNT)).toBe(
			"Checking pictures and sounds, 3 of 12",
		);
		expect(
			READING_STAGE_LABELS["bringing-in-media"]({ done: 1200, total: 1500 }),
		).toBe("Bringing in pictures and sounds, 1,200 of 1,500");
		expect(READING_STAGE_LABELS["bringing-in-media"](null)).toBe(
			"Bringing in pictures and sounds",
		);
	});
});

describe("the leads", () => {
	it("give every kind of create answer that is not created or refused a lead, and changed one for each thing now can hold", () => {
		const kinds: readonly Exclude<
			CreateAnswer["kind"],
			"created" | "refused"
		>[] = ["changed", "read-again", "check-failed", "held"];
		for (const kind of kinds)
			expect(CREATE_ANSWER_LEADS[kind], kind).toBeDefined();
		const nowKinds: readonly ReadingAnswer["kind"][] = [
			"review",
			"account",
			"stop",
		];
		for (const now of nowKinds) {
			expect(CREATE_ANSWER_LEADS.changed[now].length, now).toBeGreaterThan(0);
		}
		expect(
			CREATE_ANSWER_LEADS.changed["already-in-nova"].length,
		).toBeGreaterThan(0);
	});

	it("say what stays in the Project's files wherever an answer can follow a publish", () => {
		for (const lead of [
			CREATE_ANSWER_LEADS["read-again"],
			CREATE_ANSWER_LEADS["check-failed"],
			CREATE_ANSWER_LEADS.changed["already-in-nova"],
		]) {
			expect(lead).toContain("stay in its files");
		}
	});

	it("never say Nova chose again for a dropped answer, which a lookup table's choice left unanswered makes false", () => {
		// A dropped table answer leaves the table with no answer at all, which the
		// person has to give before a create; only a dropped declaration falls back.
		expect(CREATE_ANSWER_LEADS.choicesDropped).not.toMatch(/\bNova chose\b/);
		expect(CREATE_ANSWER_LEADS.choicesDropped).toContain(
			"back to how the review offers them",
		);
	});

	it("never say nothing was created, which is false after a publish", () => {
		for (const sentence of [
			...leads(),
			...Object.values(READING_REFUSAL_COPY),
		]) {
			expect(sentence).not.toContain("Nothing was created");
		}
	});
});

describe("the account and the failures", () => {
	it("say how many more findings there are, and the listed limit as the answer holds it", () => {
		const limit = new Intl.NumberFormat("en-US").format(
			READING_MAX_LISTED_FINDINGS,
		);
		expect(moreFindingsLine(500)).toBe(
			`Nova found 500 more things to list and counted every one. This list shows the first ${limit}.`,
		);
		expect(moreFindingsLine(12500)).toContain("12,500 more things");
		expect(moreFindingsLine(1)).toContain(`the first ${limit}.`);
	});

	it("answer both failures with a name and with none", () => {
		for (const form of Object.values(READING_FAILED_COPY)) {
			expect(form.body("Household survey")).toContain("Household survey");
			expect(form.body(null)).toContain("this app");
			expect(form.body("  ")).toContain("this app");
		}
	});
});

describe("every sentence", () => {
	it("holds no em dash and no label ends with an ellipsis", () => {
		for (const sentence of everySentence()) {
			expect(sentence, sentence).not.toContain("—");
			expect(sentence, sentence).not.toMatch(/(\.\.\.|…)$/);
		}
	});

	it("never says the code's word for the app a person is bringing in", () => {
		for (const sentence of everySentence()) {
			for (const word of [
				"this reading",
				"that reading",
				"a reading",
				"Nova's reading",
			]) {
				expect(sentence.toLowerCase(), sentence).not.toContain(
					word.toLowerCase(),
				);
			}
		}
	});
});
