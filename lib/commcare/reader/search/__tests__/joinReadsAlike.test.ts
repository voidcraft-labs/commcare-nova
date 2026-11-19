/**
 * Contract: the reader joins a conjunct of a search's own filter to the list filter of a menu whose
 * forms read the search (kind F) only where every case HQ's search returns for it is one the
 * device's list filter keeps (`joinReadsAlike`). HQ tests a property's text as stored and the device
 * the same text trimmed at both ends (Core's `TreeElementParser`), so admitted are: a custom text
 * property of the searched case compared by `=` with a string literal no trim changes, tested
 * blank, matched by `starts-with` with such a literal, or compared by `=` with the worker's own
 * information Core holds trimmed (the worker's record, the session's user name and id), the case's
 * type compared with a type either way and under `not`, `and`, `or`, `match-all` and `match-none` of
 * those, `not` of `!=`, and an `if` over the worker's own information whose branches are admitted.
 * Not admitted: a custom property by `!=` or under `not` of `=`, `is-blank` or `starts-with` (each
 * true in HQ of a stored text the device trims to make it false), a literal with a code unit up to
 * U+0020 at an end, the session's user data (untrimmed), and every other shape the audit read
 * (another standard property, a property through a related case, a number or a date, `today()`, a
 * typed property, a match of several values, a distance, a choice made over a session value that
 * moves between the search and its list).
 *
 * The failure it catches: a join that changes the list a worker sees, which the reader would record
 * as a change no worker meets (`search-filter-joined-to-list`, `touchesWorkers: false`).
 */
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import type { Expression } from "@/lib/domain";
import {
	ancestorPath,
	and,
	dateLiteral,
	eq,
	exists,
	gt,
	ifExpr,
	isBlank,
	literal,
	match,
	matchAll,
	matchNone,
	multiSelectAny,
	neq,
	not,
	or,
	prop,
	relationStep,
	sessionContext,
	sessionUser,
	subcasePath,
	term,
	today,
	within,
} from "@/lib/domain/expression/builders";
import { plainColumn } from "@/lib/domain/modules";
import { proseText } from "@/lib/domain/prose";
import { patients, uuid } from "../../caseList/__tests__/fixtures";
import { joinReadsAlike } from "../joinReadsAlike";

/** One menu of patients whose catalog holds `notes` and `phone` with no type and `dob` as a date. */
const doc = produce(
	patients([plainColumn(uuid(1), "case_name", "Name")]),
	(draft) => {
		draft.caseTypes = [
			{
				name: "patient",
				properties: [
					{ name: "notes", label: proseText("notes") },
					{ name: "phone", label: proseText("phone"), data_type: "text" },
					{ name: "dob", label: proseText("dob"), data_type: "date" },
				],
			},
		];
	},
);
const notes = prop("patient", "notes");
const caseRowType = term({ kind: "case-row-type" });
const patientType = term({ kind: "case-type", caseType: "patient" });
/** `if(<session value> = 'demo', match-none(), notes = 'north')`, the list a session value chooses. */
const chosenBy = (field: "username" | "userid" | "drift" | "applanguage") =>
	ifExpr(
		eq(sessionContext(field), literal("demo")),
		matchNone(),
		eq(notes, literal("north")),
	);
/** The worker's record's `field`, which the device's case database holds trimmed. */
const workerRecord = (field: string) =>
	({ kind: "session-user", field, source: "worker-record" }) as const;
const alike = (conjunct: Expression) =>
	joinReadsAlike(conjunct, doc, "patient");

describe("a conjunct the reader may join to the list filter", () => {
	it.each<[string, Expression]>([
		["a text property equal to a literal", eq(notes, literal("north"))],
		["the literal on the left", eq(literal("north"), notes)],
		["a text property equal to blank", eq(notes, literal(""))],
		["a text property tested blank", isBlank(notes)],
		[
			"a text property starting with a literal",
			match(notes, "nor", "starts-with"),
		],
		[
			"a text property equal to the worker's record",
			eq(notes, { kind: "term", term: workerRecord("district") }),
		],
		[
			"a conjunction",
			and(eq(notes, literal("a")), isBlank(prop("patient", "phone"))),
		],
		["a disjunction", or(eq(notes, literal("a")), eq(notes, literal("b")))],
		["every case", matchAll()],
		["no case", matchNone()],
		["a negation of an inequality", not(neq(notes, literal("north")))],
		[
			"a negation of a conjunction of inequalities",
			not(and(neq(notes, literal("a")), neq(notes, literal("b")))),
		],
		[
			"a double negation",
			{
				kind: "not",
				clause: { kind: "not", clause: match(notes, "nor", "starts-with") },
			},
		],
		["the case's type equal to a type", eq(caseRowType, patientType)],
		[
			"the case's type unequal to a literal",
			neq(literal("visit"), caseRowType),
		],
		[
			"a negation of a test of the case's type",
			not(eq(caseRowType, patientType)),
		],
		[
			"a text property equal to the worker's user name",
			eq(notes, sessionContext("username")),
		],
		["a list chosen by the worker's user name", chosenBy("username")],
		["a list chosen by the worker's id", chosenBy("userid")],
	])("admits %s", (_, conjunct) => {
		expect(alike(conjunct)).toBe(true);
	});
});

describe("a conjunct the device's list reads otherwise than HQ's search", () => {
	const household = ancestorPath(relationStep("parent", "household"));
	it.each<[string, Expression]>([
		["a negation of starts-with", not(match(notes, "nor", "starts-with"))],
		// HQ keeps a stored `'north '` for each of these, and the device reads it trimmed, `'north'`.
		["a text property unequal to a literal", neq(notes, literal("north"))],
		["a text property unequal to blank", neq(notes, literal(""))],
		["a negation of an equality", not(eq(notes, literal("north")))],
		// HQ keeps a stored `' '`, which the device reads as blank.
		["a negation of a blank test", not(isBlank(notes))],
		[
			"a negation of a disjunction",
			not(or(eq(notes, literal("a")), isBlank(notes))),
		],
		[
			"a conjunction holding an inequality",
			and(eq(notes, literal("a")), neq(prop("patient", "phone"), literal("b"))),
		],
		// HQ matches a stored text with the space, which the device reads without it.
		["an equality with a literal ending in a space", eq(notes, literal("x "))],
		[
			"an equality with a literal starting with a space",
			eq(notes, literal(" x")),
		],
		[
			"an equality with a literal ending in a line break",
			eq(notes, literal("x\n")),
		],
		[
			"a starts-with of a literal starting with a space",
			match(notes, " a", "starts-with"),
		],
		[
			"a starts-with of a literal ending in a space",
			match(notes, "a ", "starts-with"),
		],
		// The session's user data is the restore's text, which Core does not trim.
		[
			"a text property equal to the session's user data",
			eq(notes, sessionUser("district")),
		],
		[
			"a negation of an equality with the worker's information",
			not(eq(notes, { kind: "term", term: workerRecord("district") })),
		],
		["a list chosen by the clock's drift", chosenBy("drift")],
		["a list chosen by the app's language", chosenBy("applanguage")],
		[
			"a text property equal to the app's language",
			eq(notes, sessionContext("applanguage")),
		],
		[
			"a choice whose branch is not admitted",
			ifExpr(
				eq(sessionContext("username"), literal("demo")),
				matchNone(),
				not(match(notes, "nor", "starts-with")),
			),
		],
		["a standard property", eq(prop("patient", "case_name"), literal("Ana"))],
		[
			"a related case's property",
			eq(prop("patient", "region", household), literal("x")),
		],
		[
			"the presence of a related case",
			exists(household, eq(prop("household", "region"), literal("x"))),
		],
		["the presence of a child case", exists(subcasePath("parent", "visit"))],
		["an ordering of a number", gt(notes, literal(3))],
		["a number equal to a text property", eq(notes, literal(3))],
		[
			"a date property equal to a date",
			eq(prop("patient", "dob"), dateLiteral("2026-01-15")),
		],
		[
			"a date property equal to text",
			eq(prop("patient", "dob"), literal("2026-01-15")),
		],
		["today", eq(notes, today())],
		["a match of several values", multiSelectAny(notes, literal("a"))],
		["a fuzzy match", match(notes, "nrth", "fuzzy")],
		[
			"a distance",
			within(prop("patient", "home"), literal("1 2"), 5, "kilometers"),
		],
		[
			"a conjunction with one shape not admitted",
			and(eq(notes, literal("a")), gt(notes, literal(3))),
		],
		[
			"a property of another menu's type",
			eq(prop("visit", "notes"), literal("a")),
		],
	])("does not admit %s", (_, conjunct) => {
		expect(alike(conjunct)).toBe(false);
	});

	it("admits a literal whose ends no trim changes, and none whose ends one does", () => {
		expect(alike(eq(notes, literal("north\u0021")))).toBe(true);
		expect(alike(eq(notes, literal("north\u0020")))).toBe(false);
		expect(alike(eq(notes, literal("\u0000north")))).toBe(false);
		// U+00A0 is no code unit Java's `String.trim()` removes.
		expect(alike(eq(notes, literal("north\u00a0")))).toBe(true);
	});
});
