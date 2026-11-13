/**
 * The words of every finding, held to the manifest both ways: every pair of
 * subject and standing (or subject and cause) an entry gives has its
 * sentence, and every sentence is read by some entry, so no finding reaches a
 * person without words and no words sit unread. Every circumstance block
 * fills every placeholder, and every string keeps the voice rules a machine
 * can hold.
 */

import { describe, expect, it } from "vitest";
import { loadManifest } from "@/lib/commcare/surface/__tests__/loadManifest";
import { fixCauseOf, standingOf } from "@/lib/commcare/surface/standing";
import {
	ACCOUNT_CHECK_AGAIN_LINE,
	alreadyInNovaNext,
	CIRCUMSTANCE_COPY,
	type CircumstanceContext,
	circumstanceBlock,
	FINDING_COPY,
	FINDING_LABELS,
	FINDING_NEXT_STEPS,
	FIX_CAUSE_CLAUSES,
	FIX_IN_HQ_SENTENCES,
	FIX_IN_HQ_STEMS,
	findingLine,
	fixInHqSentence,
	placeLine,
	SUBJECT_LABELS,
} from "../hqFindingCopy";
import {
	CIRCUMSTANCE_STANDINGS,
	type CircumstanceFinding,
	circumstanceFinding,
	type FixCause,
	type HqAppClaimDetail,
	type HqPlace,
	type ManifestFinding,
	READ_CIRCUMSTANCES,
	type ReadCircumstance,
	SUBJECTS,
	type Subject,
} from "../hqFindings";

// ---------------------------------------------------------------------------
// The pairs the manifest gives
// ---------------------------------------------------------------------------

const manifest = loadManifest();

/** `subject|standing` for every not-yet or never entry. */
const sentencePairs = new Set<string>();
/** `subject|cause` for every fix-in-hq entry. */
const fixPairs = new Set<string>();
/** The causes each subject's fix-in-hq entries give. */
const causesBySubject = new Map<Subject, Set<FixCause>>();

for (const entry of manifest.inventory) {
	if (entry.disposition !== "HELD-NEW" && entry.disposition !== "REFUSED")
		continue;
	const standing = standingOf(entry);
	if (standing === "fix-in-hq") {
		const cause = fixCauseOf(entry);
		if (cause === null) throw new Error(`${entry.id} has no fix cause`);
		fixPairs.add(`${entry.subject}|${cause}`);
		const causes = causesBySubject.get(entry.subject) ?? new Set<FixCause>();
		causes.add(cause);
		causesBySubject.set(entry.subject, causes);
	} else {
		sentencePairs.add(`${entry.subject}|${standing}`);
	}
}

function pairOf(key: string): [Subject, string] {
	const [subject, other] = key.split("|");
	return [subject as Subject, other];
}

// ---------------------------------------------------------------------------
// Fixtures for the circumstance blocks
// ---------------------------------------------------------------------------

const formatDate = (iso: string) => `the day ${iso.slice(0, 10)}`;
const withApp: CircumstanceContext = {
	server: "India",
	space: "kenya-visits",
	app: "Household visits",
	formatDate,
};
const withoutApp: CircumstanceContext = { ...withApp, app: null };
const questionPlace: HqPlace = {
	kind: "question",
	menu: 0,
	form: 1,
	menuName: "Households",
	formName: "Visit",
	path: "visit_details/visit_time",
};

const claims: readonly HqAppClaimDetail[] = [
	{ kind: "open", appId: "app-1", appName: "Household visits" },
	{
		kind: "elsewhere",
		at: "2026-10-01T09:00:00.000Z",
		contact: { role: "person", names: ["Amina Odhiambo"] },
	},
	{
		kind: "elsewhere",
		at: "2026-10-01T09:00:00.000Z",
		contact: { role: "owners", names: ["Amina", "Ben", "Chao"] },
	},
];

function rowName(code: ReadCircumstance): string | undefined {
	const row: { readonly standing: string; readonly name?: string } =
		CIRCUMSTANCE_STANDINGS[code];
	return row.name;
}

/** A finding for each code, its name set where the row holds one. */
function findingFor(code: ReadCircumstance): CircumstanceFinding {
	const detail =
		rowName(code) === undefined ? {} : { name: "Regions of Kenya" };
	return circumstanceFinding(code, { kind: "app" }, detail as never);
}

function blocks(): { title: string; body: string; next: string }[] {
	return READ_CIRCUMSTANCES.flatMap((code) =>
		[withApp, withoutApp].map((context) =>
			circumstanceBlock(findingFor(code), context),
		),
	);
}

// ---------------------------------------------------------------------------
// Completeness
// ---------------------------------------------------------------------------

describe("the sentences of not-yet and never findings", () => {
	it("has a sentence for every pair of subject and standing an entry gives", () => {
		const missing = [...sentencePairs].filter((key) => {
			const [subject, standing] = pairOf(key);
			return (
				FINDING_COPY[subject][standing as "not-yet" | "never"] === undefined
			);
		});
		expect(missing).toEqual([]);
	});

	it("holds no sentence whose pair no entry gives", () => {
		const unread = SUBJECTS.flatMap((subject) =>
			Object.keys(FINDING_COPY[subject]).map(
				(standing) => `${subject}|${standing}`,
			),
		).filter((key) => !sentencePairs.has(key));
		expect(unread).toEqual([]);
	});
});

describe("the sentences of fix-in-hq findings", () => {
	it("answers for every pair of subject and cause an entry gives", () => {
		for (const key of fixPairs) {
			const [subject, cause] = pairOf(key);
			expect(
				() => fixInHqSentence(subject, cause as FixCause),
				key,
			).not.toThrow();
		}
	});

	it("reads a whole sentence, or a stem, one space and the cause's clause", () => {
		for (const key of fixPairs) {
			const [subject, cause] = pairOf(key) as [Subject, FixCause];
			const sentence = fixInHqSentence(subject, cause);
			const whole = FIX_IN_HQ_SENTENCES[subject]?.[cause];
			if (whole !== undefined) {
				expect(sentence).toBe(whole);
			} else {
				expect(cause).not.toBe("below-floor");
				if (cause === "below-floor") continue;
				expect(sentence).toBe(
					`${FIX_IN_HQ_STEMS[subject]} ${FIX_CAUSE_CLAUSES[cause]}`,
				);
			}
		}
	});

	it("holds no stem whose subject no fix-in-hq entry gives", () => {
		const unread = Object.keys(FIX_IN_HQ_STEMS).filter(
			(subject) => !causesBySubject.has(subject as Subject),
		);
		expect(unread).toEqual([]);
	});

	it("holds no whole sentence whose pair no entry gives", () => {
		const unread = Object.entries(FIX_IN_HQ_SENTENCES).flatMap(
			([subject, byCause]) =>
				Object.keys(byCause ?? {})
					.map((cause) => `${subject}|${cause}`)
					.filter((key) => !fixPairs.has(key)),
		);
		expect(unread).toEqual([]);
	});

	it("holds no stem that every cause of its subject's entries reads past", () => {
		const unreadStems = Object.keys(FIX_IN_HQ_STEMS).filter((subject) => {
			const causes = causesBySubject.get(subject as Subject) ?? new Set();
			return [...causes].every(
				(cause) =>
					FIX_IN_HQ_SENTENCES[subject as Subject]?.[cause] !== undefined,
			);
		});
		expect(unreadStems).toEqual([]);
	});

	it("ends every stem in its verb and opens every clause the same way", () => {
		for (const stem of Object.values(FIX_IN_HQ_STEMS))
			expect(stem, stem).toMatch(/ (is|are)$/);
		for (const clause of Object.values(FIX_CAUSE_CLAUSES)) {
			expect(clause.startsWith("set up in a way"), clause).toBe(true);
			expect(clause.endsWith("."), clause).toBe(true);
		}
	});

	it("refuses a pair with no sentence, naming where the sentence goes", () => {
		expect(() => fixInHqSentence("hand-written-content", "hq-refuses")).toThrow(
			/hand-written-content.*hq-refuses.*hqFindingCopy\.ts/,
		);
	});
});

describe("the subject labels", () => {
	it("gives no two subjects one label", () => {
		const labels = Object.values(SUBJECT_LABELS);
		expect(new Set(labels).size).toBe(labels.length);
	});
});

// ---------------------------------------------------------------------------
// Circumstances
// ---------------------------------------------------------------------------

describe("alreadyInNovaNext", () => {
	it("answers for an unknown holder and for each kind of holder, every placeholder filled", () => {
		expect(alreadyInNovaNext(undefined, formatDate)).toBe(
			"You can check again in a moment to see where it is.",
		);
		expect(alreadyInNovaNext(claims[0], formatDate)).toBe(
			"It's Household visits, in a Project you're part of. You can open it from your apps.",
		);
		expect(alreadyInNovaNext(claims[1], formatDate)).toBe(
			"Amina Odhiambo has had it in Nova since the day 2026-10-01. You can ask Amina Odhiambo to invite you, or to stop publishing to it from Nova so you can bring it in yourself.",
		);
		expect(alreadyInNovaNext(claims[2], formatDate)).toBe(
			"It has been in Nova since the day 2026-10-01. Amina, Ben and Chao can invite you, or stop publishing to it from Nova so you can bring it in yourself.",
		);
		for (const claim of [undefined, ...claims])
			expect(alreadyInNovaNext(claim, formatDate)).not.toContain("{");
	});
});

describe("circumstanceBlock", () => {
	it("fills every placeholder of every code, with an app's name and without one", () => {
		for (const code of READ_CIRCUMSTANCES)
			for (const context of [withApp, withoutApp]) {
				const block = circumstanceBlock(findingFor(code), context);
				for (const text of [block.title, block.body, block.next])
					expect(text, `${code}: ${text}`).not.toContain("{");
			}
	});

	it("reads an unknown app as this app, capitalized where it opens a sentence", () => {
		expect(
			circumstanceBlock(findingFor("cannot-read-organization"), withoutApp)
				.body,
		).toMatch(/^This app reads places, and reading them from kenya-visits /);
		expect(
			circumstanceBlock(findingFor("app-gone"), withoutApp).body,
		).toContain("Nova asked kenya-visits for this app, and");
		expect(circumstanceBlock(findingFor("app-gone"), withApp).body).toContain(
			"Nova asked kenya-visits for Household visits, and",
		);
	});

	it("fills the server and the name", () => {
		expect(circumstanceBlock(findingFor("not-connected"), withApp).title).toBe(
			"Nova isn't connected to CommCare HQ on India yet",
		);
		expect(
			circumstanceBlock(findingFor("table-cell-unrepresentable"), withApp).body,
		).toBe(
			"The lookup table Regions of Kenya in kenya-visits holds a character CommCare can't carry in a value.",
		);
	});

	it("gives already-in-nova the next step for who holds the app", () => {
		for (const claim of [undefined, ...claims]) {
			const finding = circumstanceFinding(
				"already-in-nova",
				{ kind: "app" },
				claim === undefined ? {} : { claim },
			);
			expect(circumstanceBlock(finding, withApp).next).toBe(
				alreadyInNovaNext(claim, formatDate),
			);
		}
	});

	it("names the date and time question whose split is refused", () => {
		const name = "“Date and time questions”, which Web Apps can't run";
		const refused = circumstanceFinding(
			"no-platform-runs-everything",
			questionPlace,
			{ name, reason: "split-refused" },
		);
		expect(circumstanceBlock(refused, withApp)).toEqual({
			title: "No one platform runs this whole app",
			body: "This uses “Date and time questions”, which Web Apps can't run. Part of this app runs only in Web Apps and part only on Android, so workers on either would meet something that doesn't work.",
			next: "You can change how the date and time question visit_time reads its own answer in CommCare HQ, then check again.",
		});
		const plain = circumstanceFinding(
			"no-platform-runs-everything",
			questionPlace,
			{ name },
		);
		expect(circumstanceBlock(plain, withApp).next).toBe(
			CIRCUMSTANCE_COPY["no-platform-runs-everything"].next,
		);
	});

	it("holds {name} in a template exactly where the code's row puts the name in the body", () => {
		for (const code of READ_CIRCUMSTANCES) {
			const copy = CIRCUMSTANCE_COPY[code];
			const holdsName = [copy.title, copy.body, copy.next].some((text) =>
				text.includes("{name}"),
			);
			expect(holdsName, code).toBe(rowName(code) === "body");
		}
	});
});

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

describe("findingLine", () => {
	const manifestFinding: ManifestFinding = {
		code: "questions/an-appearance",
		standing: "not-yet",
		place: questionPlace,
		subject: "question-appearance",
		detail: { name: "quick" },
	};

	it("reads a manifest finding's sentence and names it", () => {
		expect(findingLine(manifestFinding)).toEqual({
			sentence: FINDING_COPY["question-appearance"]["not-yet"],
			named: "quick",
		});
		expect(findingLine({ ...manifestFinding, detail: {} }).named).toBeNull();
		expect(
			findingLine({
				...manifestFinding,
				standing: "fix-in-hq",
				cause: "breaks-when-run",
				subject: "repeats",
			}).sentence,
		).toBe(fixInHqSentence("repeats", "breaks-when-run"));
	});

	it("names a circumstance only where its row puts the name on its own line", () => {
		for (const code of READ_CIRCUMSTANCES) {
			const row = rowName(code);
			if (CIRCUMSTANCE_STANDINGS[code].standing === "stop") continue;
			const line = findingLine(findingFor(code));
			expect(line.sentence).toBe(CIRCUMSTANCE_COPY[code].title);
			expect(line.named, code).toBe(row === "line" ? "Regions of Kenya" : null);
		}
	});

	it("refuses a stop, which no account holds", () => {
		expect(() => findingLine(findingFor("not-connected"))).toThrow(
			/not-connected.*circumstanceBlock/,
		);
	});
});

describe("placeLine", () => {
	it("words every kind of place", () => {
		const lines = (
			[
				[{ kind: "app" }, "The app"],
				[{ kind: "app-settings" }, "App settings"],
				[{ kind: "languages" }, "Languages"],
				[{ kind: "menu", menu: 0, name: "Households" }, "The menu Households"],
				[
					{ kind: "case-list", menu: 0, name: "Households" },
					"The case list of Households",
				],
				[
					{ kind: "case-detail", menu: 0, name: "Households" },
					"The case details of Households",
				],
				[
					{ kind: "search", menu: 0, name: "Households" },
					"The search of Households",
				],
				[
					{
						kind: "form",
						menu: 0,
						form: 0,
						menuName: "Households",
						name: "Registration",
					},
					"Registration, in the menu Households",
				],
				[questionPlace, "The question visit_details/visit_time, in Visit"],
				[{ kind: "lookup-table", tag: "regions" }, "The lookup table regions"],
				[
					{ kind: "media", path: "jr://file/a.png" },
					"The file jr://file/a.png",
				],
				[{ kind: "organization" }, "The organization"],
			] as const satisfies readonly (readonly [HqPlace, string])[]
		).map(([place, expected]) => [placeLine(place), expected]);
		for (const [got, expected] of lines) expect(got).toBe(expected);
	});
});

// ---------------------------------------------------------------------------
// Voice
// ---------------------------------------------------------------------------

describe("the voice of every string", () => {
	const fixSentences = [...fixPairs].map((key) => {
		const [subject, cause] = pairOf(key);
		return fixInHqSentence(subject, cause as FixCause);
	});
	const composed = Object.entries(FIX_IN_HQ_STEMS).flatMap(([, stem]) =>
		Object.values(FIX_CAUSE_CLAUSES).map((clause) => `${stem} ${clause}`),
	);
	const allBlocks = blocks();
	const splitRefused = circumstanceBlock(
		circumstanceFinding("no-platform-runs-everything", questionPlace, {
			name: "“Date and time questions”, which Web Apps can't run",
			reason: "split-refused",
		}),
		withApp,
	).next;
	const nextForClaims = [undefined, ...claims].map((claim) =>
		alreadyInNovaNext(claim, formatDate),
	);

	/** Whole sentences, bodies and next steps: each ends with a full stop. */
	const sentences = [
		...Object.values(FINDING_NEXT_STEPS),
		...SUBJECTS.flatMap((subject) => Object.values(FINDING_COPY[subject])),
		...Object.values(FIX_IN_HQ_SENTENCES).flatMap((byCause) =>
			Object.values(byCause ?? {}),
		),
		...fixSentences,
		...composed,
		...allBlocks.flatMap((block) => [block.body, block.next]),
		splitRefused,
		...nextForClaims,
		ACCOUNT_CHECK_AGAIN_LINE,
	];
	/** Labels, titles and stems: none ends with a full stop. */
	const headings = [
		...Object.values(FINDING_LABELS),
		...Object.values(SUBJECT_LABELS),
		...allBlocks.map((block) => block.title),
		...Object.values(FIX_IN_HQ_STEMS),
	];
	const clauses = Object.values(FIX_CAUSE_CLAUSES);
	const everything = [...sentences, ...headings, ...clauses];

	it("uses no em dash, no ellipsis and never the word import", () => {
		for (const text of everything) {
			expect(text, text).not.toContain("—");
			expect(text, text).not.toContain("…");
			expect(text, text).not.toContain("...");
			expect(text, text).not.toMatch(/\bimport\b/i);
		}
	});

	it("opens every string but a clause in sentence case", () => {
		for (const text of [...sentences, ...headings])
			expect(text, text).toMatch(/^\p{Lu}/u);
	});

	it("ends every sentence with a full stop, and no label, title or stem with one", () => {
		for (const text of sentences) expect(text.endsWith("."), text).toBe(true);
		for (const text of headings) expect(text.endsWith("."), text).toBe(false);
	});
});
