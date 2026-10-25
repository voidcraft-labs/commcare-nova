/**
 * The search wire shape (`searchWireShape.ts`), and the platform table's
 * restatement of it.
 *
 * Contract: one shape for every platform an app declares. Search first is
 * HQ's inline search, prompted or not by whether a worker has a visible
 * field to answer; otherwise an effective filter with nothing to answer
 * skips to results, and anything else opens the list first. The platform
 * table's `skip-to-results` and `search-first` detectors restate those two
 * arms over the domain (`lib/domain/platformUses.ts`), so they hold exactly
 * where the emitted shape says, or a difference the builder states and the
 * gate refuses would drift from what the wire does.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig } from "@/lib/__tests__/docHelpers";
import {
	type CaseListConfig,
	effectiveCaseSearchConfig,
	hiddenSearchInputDef,
	type OrdinaryCaseSearchConfig,
	platformFeatureUses,
	proseText,
	simpleSearchInputDef,
} from "@/lib/domain";
import {
	and,
	eq,
	literal,
	matchAll,
	matchNone,
	prop,
	term,
} from "@/lib/domain/expression";
import { searchWireShape } from "../searchWireShape";

const visible = simpleSearchInputDef(
	testUuid("visible"),
	"name",
	"Name",
	"text",
	"case_name",
);
const hidden = hiddenSearchInputDef(
	testUuid("hidden"),
	"context",
	"Context",
	term(literal("North")),
);
const noLaunch = {
	autoLaunch: false,
	defaultSearch: false,
	inlineSearch: false,
};
const autoRemote = {
	autoLaunch: true,
	defaultSearch: true,
	inlineSearch: false,
};
const autoInline = {
	autoLaunch: true,
	defaultSearch: true,
	inlineSearch: true,
};
const promptedInline = {
	autoLaunch: true,
	defaultSearch: false,
	inlineSearch: true,
};

const FILTERS = [
	["none", undefined, noLaunch],
	["true", matchAll(), noLaunch],
	["folded true", and(matchAll(), matchAll()), noLaunch],
	["false", matchNone(), autoRemote],
	["condition", eq(prop("patient", "status"), literal("open")), autoRemote],
] as const;
const INPUTS = [[], [hidden], [visible], [hidden, visible]];

it.each(FILTERS)(
	"projects the first screen from %s filtering",
	(_name, filter, unprompted) => {
		for (const inputs of INPUTS) {
			const list = caseListConfig([{ field: "case_name", header: "Name" }]);
			list.filter = filter;
			list.searchInputs = inputs;
			const before = structuredClone(list);
			// Only the visible input changes whether the worker has something to answer.
			const prompted = inputs.includes(visible);
			expect(searchWireShape(list, {})).toEqual(
				prompted ? noLaunch : unprompted,
			);
			expect(searchWireShape(list, { searchFirst: true })).toEqual(
				prompted ? promptedInline : autoInline,
			);
			expect(list).toEqual(before);
		}
	},
);

describe("the platform table's restatement", () => {
	/** Every module the matrix draws: each filter, each set of inputs, with
	 * and without Search first. */
	const modules = FILTERS.flatMap(([name, filter]) =>
		INPUTS.flatMap((inputs) =>
			[{}, { searchFirst: true as const }].map(
				(search: OrdinaryCaseSearchConfig) => {
					const list: CaseListConfig = caseListConfig([
						{ field: "case_name", header: "Name" },
					]);
					list.filter = filter;
					list.searchInputs = inputs;
					return { name, list, search };
				},
			),
		),
	);

	it("finds skip-to-results and Search first exactly where the wire shape emits them", () => {
		for (const { name, list, search } of modules) {
			const doc = buildDoc({
				appName: "Search shape",
				modules: [
					{
						name: "Patients",
						caseType: "patient",
						caseListConfig: list,
						caseSearchConfig: search,
					},
				],
				caseTypes: [
					{
						name: "patient",
						properties: [
							{ name: "case_name", label: proseText("Name") },
							{ name: "status", label: proseText("Status") },
						],
					},
				],
			});
			const module = Object.values(doc.modules)[0];
			const effective =
				module === undefined ? undefined : effectiveCaseSearchConfig(module);
			if (effective === undefined || module?.caseListConfig === undefined)
				throw new Error("The module holds no search.");
			const shape = searchWireShape(module.caseListConfig, effective);
			const found = new Set(
				platformFeatureUses(doc, {
					features: new Set(["skip-to-results", "search-first"]),
				}).map((use) => use.feature),
			);
			expect([name, search, found.has("skip-to-results")]).toEqual([
				name,
				search,
				shape.autoLaunch && shape.defaultSearch && !shape.inlineSearch,
			]);
			expect([name, search, found.has("search-first")]).toEqual([
				name,
				search,
				shape.inlineSearch,
			]);
		}
	});
});
