import { expressionEditorFixture } from "@/__tests__/helpers/expressionEditorFixture";
import { scalarDataType, typeOf } from "@/lib/domain/expression";
// components/builder/shared/__tests__/runtimeMatchModes.test.ts
//
// Which match modes a surface may offer is decided by WHICH RUNTIME
// evaluates its rule, and getting that backwards is invisible either
// way: withhold too much and an advanced search input silently loses
// fuzzy matching it has always had; withhold too little and a device
// app installs and then fails when the screen opens.
//
// So both directions are pinned here, against the verb menu's own
// admission function rather than a restatement of it.

import { describe, expect, it } from "vitest";
import {
	subjectOf,
	VERB_ENTRIES,
	verbEntryAdmitted,
} from "@/components/builder/shared/cards/PredicateVerbMenu";
import type { PredicateEditContext } from "@/components/builder/shared/editorSchemas";
import { editorExpressionContext } from "@/components/builder/shared/editorTypeContext";
import type { CaseType } from "@/lib/domain";
import {
	type Expression,
	eq,
	literal,
	prop,
	term,
} from "@/lib/domain/expression";
import { proseText } from "@/lib/domain/prose";

const CASE_TYPES: readonly CaseType[] = [
	{
		name: "patient",
		properties: [
			{ name: "nickname", label: proseText("Nickname"), data_type: "text" },
			{ name: "case_name", label: proseText("Name"), data_type: "text" },
		],
	},
];

function context(
	evaluationTarget: PredicateEditContext["evaluationTarget"],
): PredicateEditContext {
	return expressionEditorFixture(
		evaluationTarget === "case-search"
			? "search-predicate"
			: evaluationTarget === "on-device-and-case-search"
				? "search-case-filter"
				: "case-filter",
		{
			caseTypes: CASE_TYPES,
			currentCaseType: "patient",
			knownInputs: [],
			caseDataScope: "per-case",
			...(evaluationTarget === undefined ? {} : { evaluationTarget }),
		},
	).context;
}

/** A filled comparison: the real starting point for a verb switch, and
 *  one that carries a value so the carry gate is satisfied. */
const CURRENT: Expression = eq(
	term(prop("patient", "nickname")),
	term(literal("ali")),
);

function admittedModes(
	evaluationTarget: PredicateEditContext["evaluationTarget"],
): readonly string[] {
	const ctx = context(evaluationTarget);
	const typeCtx = editorExpressionContext(ctx);
	const subject = subjectOf(CURRENT);
	const subjectType =
		subject === undefined
			? undefined
			: scalarDataType(typeOf(subject, typeCtx)?.data);
	return VERB_ENTRIES.filter(
		(entry) =>
			entry.id.startsWith("match:") &&
			verbEntryAdmitted(entry, CURRENT, subjectType, ctx),
	).map((entry) => entry.id.slice("match:".length));
}

describe("match modes follow the carrier's runtime", () => {
	it("offers the configured device-safe mode", () => {
		expect(admittedModes("on-device")).toEqual(["starts-with"]);
	});

	it("offers the four server-query modes", () => {
		expect([...admittedModes("case-search")].sort()).toEqual(
			["fuzzy-date", "starts-with", "phonetic", "fuzzy"].sort(),
		);
	});

	it("offers only the shared subset when the same rule runs in both runtimes", () => {
		expect(admittedModes("on-device-and-case-search")).toEqual(["starts-with"]);
	});

	// The existing device carrier remains authoritative when presentation
	// metadata is absent.
	it("fails closed when a surface states no runtime at all", () => {
		expect(admittedModes(undefined)).toEqual(["starts-with"]);
	});
});
