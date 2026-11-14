// A date and time written to a case is the text CommCare HQ stores, each
// leaf printed by what a device holds. These read the wire tree by
// structure; what Core then stores in every device zone is the lane's
// `StoredInstantRuntimeTest`, and Preview's evaluation of the same text is
// `lib/preview/xpath/__tests__/storedInstant.test.ts`.

import { describe, expect, it } from "vitest";
import { questionDatetimeCaseValue } from "@/lib/commcare/xform/datetimeCaseValue";
import { FormPath } from "@/lib/commcare/xform/formPath";
import {
	coalesce,
	datetimeCoerce,
	datetimeLiteral,
	eq,
	ifExpr,
	literal,
	now,
	term,
} from "@/lib/domain/expression/builders";
import type { Expression } from "@/lib/domain/expression/types";
import { instantFixture } from "../xpath/wire/__tests__/instantFixture";
import { w } from "../xpath/wire/builders";
import {
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
});
const read = (id: string) => fx.lowerForm(fx.field(id));

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

	it("writes a question's sibling as its typed moment's stored text", () => {
		const path = FormPath.root().child("visit_time");
		expect(questionDatetimeCaseValue(path)).toEqual(
			storedInstantValue(path.toWire()),
		);
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

describe("storedInstantOfText", () => {
	it("prints its instant text 56 times, each sub-term built once", () => {
		const t = typedInstantText(w.form(["dt"]));
		expect(references(storedInstantOfText(t), t)).toBe(56);
	});
});
