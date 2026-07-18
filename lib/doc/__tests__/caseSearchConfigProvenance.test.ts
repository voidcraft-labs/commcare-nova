import { produce } from "immer";
import { describe, expect, it } from "vitest";
import {
	enableCaseSearchMutation,
	legacyCompatibleCaseSearchConfig,
	setOwnerOnlyCaseSearchMutation,
} from "@/lib/doc/caseSearchConfigMutations";
import { applyMutations } from "@/lib/doc/mutations";
import type { Mutation } from "@/lib/doc/types";
import {
	asUuid,
	type BlueprintDoc,
	type CaseSearchConfig,
	effectiveCaseSearchConfig,
	isOwnerOnlyCaseSearchConfig,
	normalizeOwnerOnlyCaseSearchConfig,
} from "@/lib/domain";

const MODULE = asUuid("10000000-0000-4000-8000-000000000001");
const INPUT = asUuid("20000000-0000-4000-8000-000000000001");
const OWNER_EXPRESSION = {
	kind: "term" as const,
	term: { kind: "literal" as const, value: "owner-a" },
};
const AUTHORED_NEVER: CaseSearchConfig = {
	excludedOwnerIds: OWNER_EXPRESSION,
	searchButtonDisplayCondition: { kind: "match-none" },
};

function docWith(config: CaseSearchConfig): BlueprintDoc {
	return {
		appId: "search-provenance",
		appName: "Search provenance",
		connectType: null,
		caseTypes: null,
		modules: {
			[MODULE]: {
				uuid: MODULE,
				id: "patients",
				name: "Patients",
				caseType: "patient",
				caseListConfig: { columns: [], searchInputs: [] },
				caseSearchConfig: config,
			},
		},
		forms: {},
		fields: {},
		moduleOrder: [MODULE],
		formOrder: { [MODULE]: [] },
		fieldOrder: {},
		fieldParent: {},
	};
}

function apply(
	doc: BlueprintDoc,
	mutations: readonly Mutation[],
): BlueprintDoc {
	return produce(doc, (draft) => {
		applyMutations(draft, [...mutations]);
	});
}

describe("case-search owner-only provenance", () => {
	it("does not infer private provenance from an authored Never condition", () => {
		expect(isOwnerOnlyCaseSearchConfig(AUTHORED_NEVER)).toBe(false);
		expect(normalizeOwnerOnlyCaseSearchConfig(AUTHORED_NEVER)).toBe(
			AUTHORED_NEVER,
		);
	});

	it("uses an old-schema Never projection without placing the private bit in the fallback", () => {
		expect(
			legacyCompatibleCaseSearchConfig({
				searchActionEnabled: false,
				excludedOwnerIds: OWNER_EXPRESSION,
			}),
		).toEqual(AUTHORED_NEVER);
	});

	it("keeps an origin-compatible Never projection inert with zero inputs without rewriting it", () => {
		const doc = docWith(AUTHORED_NEVER);
		expect(effectiveCaseSearchConfig(doc.modules[MODULE])).toBeUndefined();
		expect(doc.modules[MODULE].caseSearchConfig).toEqual(AUTHORED_NEVER);
	});

	it("keeps an ordinary zero-input Never action when no owner projection is present", () => {
		const neverAction: CaseSearchConfig = {
			searchButtonDisplayCondition: { kind: "match-none" },
		};
		const doc = docWith(neverAction);
		expect(effectiveCaseSearchConfig(doc.modules[MODULE])).toBe(neverAction);
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
