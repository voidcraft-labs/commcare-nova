import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import {
	enableCaseSearchMutation,
	setOwnerOnlyCaseSearchMutation,
} from "@/lib/doc/caseSearchConfigMutations";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { Mutation } from "@/lib/doc/types";
import {
	type BlueprintDoc,
	type CaseSearchConfig,
	effectiveCaseSearchConfig,
	isOwnerOnlyCaseSearchConfig,
	plainColumn,
} from "@/lib/domain";
import { assertAdmittedDoc } from "./admittedDoc";

const MODULE = testUuid("10000000-0000-4000-8000-000000000001");
const INPUT = testUuid("20000000-0000-4000-8000-000000000001");
const OWNER_EXPRESSION = {
	kind: "term" as const,
	term: { kind: "literal" as const, value: "owner-a" },
};
const AUTHORED_NEVER: CaseSearchConfig = {
	excludedOwnerIds: OWNER_EXPRESSION,
	searchButtonDisplayCondition: { kind: "match-none" },
};

function docWith(config: CaseSearchConfig): BlueprintDoc {
	const doc = buildDoc({
		appId: "search-provenance",
		appName: "Search provenance",
		caseTypes: [{ name: "patient", properties: [] }],
		modules: [
			{
				uuid: MODULE,
				name: "Patients",
				caseType: "patient",
				caseListOnly: true,
				caseListConfig: {
					columns: [
						plainColumn(testUuid("provenance-column"), "case_name", "Name"),
					],
					searchInputs: [],
				},
				caseSearchConfig: config,
			},
		],
	});
	assertAdmittedDoc(doc);
	return doc;
}

function apply(
	doc: BlueprintDoc,
	mutations: readonly Mutation[],
): BlueprintDoc {
	const verdict = mutationCommitVerdict(
		doc,
		mutations,
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	expect(verdict.ok ? [] : verdict.findings).toEqual([]);
	return verdict.nextDoc;
}

describe("case-search owner-only provenance", () => {
	it("does not infer private provenance from an authored Never condition", () => {
		expect(isOwnerOnlyCaseSearchConfig(AUTHORED_NEVER)).toBe(false);
	});

	it("keeps an authored Never condition active with zero inputs without rewriting it", () => {
		const doc = docWith(AUTHORED_NEVER);
		expect(effectiveCaseSearchConfig(doc.modules[MODULE])).toEqual(
			AUTHORED_NEVER,
		);
		expect(doc.modules[MODULE].caseSearchConfig).toEqual(AUTHORED_NEVER);
	});

	it("keeps an ordinary zero-input Never action when no owner projection is present", () => {
		const neverAction: CaseSearchConfig = {
			searchButtonDisplayCondition: { kind: "match-none" },
		};
		const doc = docWith(neverAction);
		expect(effectiveCaseSearchConfig(doc.modules[MODULE])).toEqual(neverAction);
	});

	it("preserves the Never condition when a Search input is later added", () => {
		const doc = docWith(AUTHORED_NEVER);
		const withInput = apply(doc, [
			{
				kind: "addSearchInput",
				moduleUuid: MODULE,
				searchInput: {
					uuid: INPUT,
					kind: "simple",
					name: "case_name",
					label: "Client name",
					type: "text",
					property: "case_name",
				},
			},
		]);

		expect(effectiveCaseSearchConfig(withInput.modules[MODULE])).toEqual(
			AUTHORED_NEVER,
		);
		expect(withInput.modules[MODULE].caseSearchConfig).toEqual(AUTHORED_NEVER);
	});

	it("does not strip a legitimate Never condition during explicit-enable replay", () => {
		const doc = docWith(AUTHORED_NEVER);
		const replayed = apply(doc, [
			enableCaseSearchMutation(MODULE, AUTHORED_NEVER),
		]);
		expect(replayed.modules[MODULE].caseSearchConfig).toEqual(AUTHORED_NEVER);
	});

	it("preserves a peer's Never condition when a stale owner-only edit replays", () => {
		const peer = docWith(AUTHORED_NEVER);
		const replayed = apply(peer, [
			setOwnerOnlyCaseSearchMutation(MODULE, {
				searchActionEnabled: false,
				excludedOwnerIds: {
					kind: "term",
					term: { kind: "literal", value: "owner-b" },
				},
			}),
		]);
		expect(replayed.modules[MODULE].caseSearchConfig).toEqual({
			searchButtonDisplayCondition: { kind: "match-none" },
			excludedOwnerIds: {
				kind: "term",
				term: { kind: "literal", value: "owner-b" },
			},
		});
	});
});
