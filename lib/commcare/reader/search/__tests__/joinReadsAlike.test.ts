/**
 * Contract: the reader joins a conjunct of a search's own filter to the list filter of a menu whose
 * forms read the search (kind F) only where every case HQ's search returns for it is one the
 * device's list filter keeps (`joinReadsAlike`): a custom text property of the searched case
 * compared with a string literal by `=` or `!=` (a literal the exact field indexes), tested blank,
 * matched by `starts-with`, or compared by `=` with the worker's own information, and `and`, `or`,
 * `match-all` and `match-none` of those. Every other shape the audit read (a negation, a standard
 * property, a property through a related case, a number or a date, `today()`, a typed property, a
 * match of several values, a distance) is not admitted.
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
	sessionUser,
	subcasePath,
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
const alike = (conjunct: Expression) =>
	joinReadsAlike(conjunct, doc, "patient");

describe("a conjunct the reader may join to the list filter", () => {
	it.each<[string, Expression]>([
		["a text property equal to a literal", eq(notes, literal("north"))],
		["the literal on the left", eq(literal("north"), notes)],
		["a text property equal to blank", eq(notes, literal(""))],
		["a text property unequal to a literal", neq(notes, literal("north"))],
		["a text property tested blank", isBlank(notes)],
		[
			"a text property starting with a literal",
			match(notes, "nor", "starts-with"),
		],
		[
			"a text property equal to the worker's own information",
			eq(notes, sessionUser("district")),
		],
		[
			"a conjunction",
			and(eq(notes, literal("a")), neq(prop("patient", "phone"), literal("b"))),
		],
		["a disjunction", or(eq(notes, literal("a")), eq(notes, literal("b")))],
		["every case", matchAll()],
		["no case", matchNone()],
	])("admits %s", (_, conjunct) => {
		expect(alike(conjunct)).toBe(true);
	});
});

describe("a conjunct the device's list reads otherwise than HQ's search", () => {
	const household = ancestorPath(relationStep("parent", "household"));
	it.each<[string, Expression]>([
		["a negation", not(eq(notes, literal("north")))],
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
		[
			"a text property unequal to a literal the exact field does not index",
			neq(notes, literal("x".repeat(8192))),
		],
		["a match of several values", multiSelectAny(notes, literal("a"))],
		["a fuzzy match", match(notes, "nrth", "fuzzy")],
		[
			"a distance",
			within(prop("patient", "home"), literal("1 2"), 5, "kilometers"),
		],
		[
			"a conjunction with one shape not admitted",
			and(eq(notes, literal("a")), not(eq(notes, literal("b")))),
		],
		[
			"a property of another menu's type",
			eq(prop("visit", "notes"), literal("a")),
		],
	])("does not admit %s", (_, conjunct) => {
		expect(alike(conjunct)).toBe(false);
	});

	it("admits the longest literal the exact field indexes, and no longer one", () => {
		expect(alike(neq(notes, literal("x".repeat(8191))))).toBe(true);
		expect(alike(neq(notes, literal("x".repeat(8192))))).toBe(false);
	});
});
