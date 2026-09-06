import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { caseListConfig } from "@/lib/__tests__/docHelpers";
import { hiddenSearchInputDef, simpleSearchInputDef } from "@/lib/domain";
import {
	and,
	eq,
	literal,
	matchAll,
	matchNone,
	prop,
	term,
} from "@/lib/domain/predicate";
import { compileForPlatform } from "../compileForPlatform";

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

it.each([
	["none", undefined, noLaunch],
	["true", matchAll(), noLaunch],
	["folded true", and(matchAll(), matchAll()), noLaunch],
	["false", matchNone(), autoRemote],
	["condition", eq(prop("patient", "status"), literal("open")), autoRemote],
] as const)(
	"projects platform and first-screen choices with %s filtering",
	(_name, filter, unpromptedWeb) => {
		for (const inputs of [[], [hidden], [visible], [hidden, visible]]) {
			const list = caseListConfig([{ field: "case_name", header: "Name" }]);
			list.filter = filter;
			list.searchInputs = inputs;
			const before = structuredClone(list);
			// Only the visible input changes whether the worker has something to answer.
			const prompted = inputs.includes(visible);
			for (const platform of ["android", "web"] as const) {
				expect(compileForPlatform(list, {}, { platform })).toEqual(
					platform === "android" || prompted ? noLaunch : unpromptedWeb,
				);
				expect(
					compileForPlatform(list, { searchFirst: true }, { platform }),
				).toEqual(prompted ? promptedInline : autoInline);
			}
			expect(list).toEqual(before);
		}
	},
);
