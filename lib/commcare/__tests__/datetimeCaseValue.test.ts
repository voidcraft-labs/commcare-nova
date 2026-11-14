// A date and time written to a case is the text CommCare HQ stores, each
// leaf printed by what a device holds. These read the wire tree by
// structure; what Core then stores in every device zone is the lane's
// `StoredInstantRuntimeTest`, and Preview's evaluation of the same text is
// `lib/preview/xpath/__tests__/storedInstant.test.ts`.

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { questionDatetimeCaseValue } from "@/lib/commcare/xform/datetimeCaseValue";
import { FormPath } from "@/lib/commcare/xform/formPath";
import {
	coalesce,
	dateCoerce,
	datetimeCoerce,
	datetimeLiteral,
	eq,
	formatDate,
	ifExpr,
	literal,
	now,
	prop,
	switchCase,
	switchExpr,
	term,
} from "@/lib/domain/expression/builders";
import type { ExpressionContext } from "@/lib/domain/expression/context";
import type { Expression } from "@/lib/domain/expression/types";
import { instantFixture } from "../xpath/wire/__tests__/instantFixture";
import { w } from "../xpath/wire/builders";
import {
	deviceInstantText,
	storedInstantOfText,
	storedInstantValue,
	typedInstantText,
} from "../xpath/wire/instant";
import type { WireExpr } from "../xpath/wire/tree";

const fx = instantFixture({
	dt: "typed",
	copy: "text",
	d: "date",
	day: "date-text",
	lost: "clock-lost",
	open: "unknown",
	n: "int",
});
const read = (id: string) => fx.lowerForm(fx.field(id));

/** The form's context where its entry carries the inline search's query, so
 * it reads what the search found (`results:inline`). */
const searched: ExpressionContext = {
	...fx.form,
	supplies: {
		...fx.form.supplies,
		searchResults: { module: testUuid("instant-module") },
	},
};
/** One search result's `date_opened`, read as one value: text holding the
 * UTC day. */
const resultOpened: Expression = {
	kind: "project",
	of: {
		kind: "cases",
		source: "search-results",
		where: [eq(prop("visit", "case_id"), literal("a"))],
	},
	value: prop("visit", "date_opened"),
};
/** The form's own case's `date_opened` from `casedb`, a `Date` at the
 * device's midnight. */
const caseOpened = term({
	kind: "form-case",
	caseType: "visit",
	property: "date_opened",
});

describe("datetimeCaseValue", () => {
	it("writes a typed moment as CommCare HQ's text of it, never in the device's offset", () => {
		expect(fx.storeForm(fx.field("dt"))).toEqual(
			storedInstantValue(read("dt")),
		);
		const stored = fx.storeForm(fx.field("dt"));
		// The device-offset spelling Nova wrote before is no part of it.
		expect(stored).not.toEqual(
			w.call("if", [
				w.eq(read("dt"), w.str("")),
				w.str(""),
				typedInstantText(read("dt")),
			]),
		);
	});

	it("writes stored text as itself, so a copy is exact and nothing is parsed", () => {
		expect(fx.storeForm(fx.field("copy"))).toEqual(read("copy"));
		expect(fx.storeForm(fx.field("open"))).toEqual(read("open"));
		expect(fx.storeForm(term(literal("")))).toEqual(w.str(""));
	});

	it("folds a literal to its stored text", () => {
		expect(
			fx.storeForm(term(datetimeLiteral("2026-01-02T12:30:00+03:00"))),
		).toEqual(w.str("2026-01-02T09:30:00.000000Z"));
	});

	it("writes a coerced date at its UTC midnight in HQ's spelling, under a blank guard", () => {
		const day = read("day");
		expect(fx.storeForm(datetimeCoerce(fx.field("day")))).toEqual(
			w.call("if", [
				w.eq(day, w.str("")),
				w.str(""),
				w.call("concat", [day, w.str("T00:00:00.000000Z")]),
			]),
		);
		const d = read("d");
		expect(fx.storeForm(datetimeCoerce(fx.field("d")))).toEqual(
			w.call("if", [
				w.eq(d, w.str("")),
				w.str(""),
				w.call("concat", [
					w.call("format-date", [
						w.call("coalesce", [d, w.str("")]),
						w.str("%Y-%m-%d"),
					]),
					w.str("T00:00:00.000000Z"),
				]),
			]),
		);
	});

	it("prints each branch of an if or a coalesce by its own leaf", () => {
		const choice = eq(fx.field("copy"), term(literal("")));
		const chosen = fx.storeForm(
			ifExpr(choice, fx.field("dt"), fx.field("copy")),
		);
		expect(chosen).toMatchObject({ k: "call", fn: "if" });
		if (chosen.k !== "call") throw new Error("Expected the if.");
		expect(chosen.args[1]).toEqual(storedInstantValue(read("dt")));
		expect(chosen.args[2]).toEqual(read("copy"));
		expect(fx.storeForm(coalesce(fx.field("copy"), fx.field("dt")))).toEqual(
			w.call("coalesce", [read("copy"), storedInstantValue(read("dt"))]),
		);
	});

	it("prints each branch of a switch by its own leaf, the fallback last", () => {
		const chosen = fx.storeForm(
			switchExpr(
				fx.field("n"),
				[switchCase(literal(1), fx.field("dt"))],
				fx.field("copy"),
			),
		);
		expect(chosen).toMatchObject({ k: "call", fn: "if" });
		if (chosen.k !== "call") throw new Error("Expected the if.");
		expect(chosen.args[1]).toEqual(storedInstantValue(read("dt")));
		expect(chosen.args[2]).toEqual(read("copy"));
	});

	it("writes a casedb system date, a Date at the device's midnight, as the text of that moment", () => {
		expect(fx.storeForm(caseOpened)).toEqual(
			storedInstantValue(fx.lowerForm(caseOpened)),
		);
	});

	it("writes a search result's date_opened, text holding the UTC day, at that day's UTC midnight", () => {
		const opened = fx.lowerForm(resultOpened, "xform", searched);
		const written = fx.storeForm(resultOpened, undefined, searched);
		expect(written).toEqual(
			w.call("if", [
				w.eq(opened, w.str("")),
				w.str(""),
				w.call("concat", [opened, w.str("T00:00:00.000000Z")]),
			]),
		);
		// Read as a device's local midnight, the day would move by its offset.
		expect(written).not.toEqual(storedInstantValue(opened));
		// The two system dates keep apart as branches of one value.
		const both = fx.storeForm(
			coalesce(resultOpened, caseOpened),
			undefined,
			searched,
		);
		expect(both).toEqual(
			w.call("coalesce", [
				written,
				storedInstantValue(fx.lowerForm(caseOpened, "xform", searched)),
			]),
		);
	});

	it("reads a leaf holding now() from the node the caller names, once", () => {
		const node = w.form(["nova_operations", "nova_instant_visit_1"]);
		const asked: Expression[] = [];
		const value = fx.storeForm(
			ifExpr(eq(fx.field("copy"), term(literal(""))), now(), fx.field("copy")),
			(leaf) => {
				asked.push(leaf);
				return leaf.kind === "now" ? node : undefined;
			},
		);
		expect(asked).toEqual([now()]);
		if (value.k !== "call") throw new Error("Expected the if.");
		expect(value.args[1]).toEqual(
			w.call("if", [
				w.eq(node, w.str("")),
				w.str(""),
				storedInstantOfText(node),
			]),
		);
		// With no node, the clock is read where it is printed.
		expect(fx.storeForm(now())).toEqual(storedInstantValue(w.call("now", [])));
	});

	it("refuses a value whose clock may be lost, which the checker refuses first", () => {
		expect(() => fx.storeForm(fx.field("lost"))).toThrow(/clock may be lost/);
	});

	it("writes a question's sibling by what its question holds, read as a field", () => {
		const path = FormPath.root().child("visit_time");
		// A date-and-time question holds a typed moment.
		expect(
			questionDatetimeCaseValue(testUuid("instant-dt"), path, fx.form),
		).toEqual(storedInstantValue(path.toWire()));
		// A Hidden Value whose calculate copies a case's stored text holds that
		// text, and its sibling copies it as it is: Core's parse of it would
		// keep the written UTC date and move only the clock.
		expect(
			questionDatetimeCaseValue(testUuid("instant-copy"), path, fx.form),
		).toEqual(path.toWire());
	});
});

/** How many times `node` is referenced in `tree`, shared references counted. */
function references(tree: WireExpr, node: WireExpr): number {
	let count = 0;
	const visit = (value: unknown): void => {
		if (value === node) {
			count += 1;
			return;
		}
		if (typeof value !== "object" || value === null) return;
		for (const child of Array.isArray(value) ? value : Object.values(value))
			visit(child);
	};
	visit(tree);
	return count;
}

describe("a date and time Core parses on a device", () => {
	it("reads stored text in the device's own date and clock before format-date and date() parse it", () => {
		const copy = read("copy");
		expect(fx.lowerForm(formatDate(fx.field("copy"), "%Y-%m-%d"))).toEqual(
			w.call("format-date", [deviceInstantText(copy), w.str("%Y-%m-%d")]),
		);
		expect(fx.lowerForm(dateCoerce(fx.field("copy")))).toEqual(
			w.call("date", [deviceInstantText(copy)]),
		);
	});

	it("leaves a typed moment, a date and a value whose clock is lost as they are", () => {
		expect(fx.lowerForm(formatDate(fx.field("dt"), "%H"))).toEqual(
			w.call("format-date", [read("dt"), w.str("%H")]),
		);
		expect(fx.lowerForm(dateCoerce(fx.field("day")))).toEqual(
			w.call("date", [read("day")]),
		);
		expect(fx.lowerForm(dateCoerce(fx.field("lost")))).toEqual(
			w.call("date", [read("lost")]),
		);
	});
});

describe("storedInstantOfText", () => {
	it("prints its instant text 56 times, each sub-term built once", () => {
		const t = typedInstantText(w.form(["dt"]));
		expect(references(storedInstantOfText(t), t)).toBe(56);
	});
});
