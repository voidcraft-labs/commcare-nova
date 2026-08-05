import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import type { Automation, BlueprintDoc } from "@/lib/domain";
import {
	assembleBlueprint,
	blueprintScalars,
	decomposeBlueprint,
} from "../blueprintRows";

describe("automation entity-row persistence", () => {
	it("round-trips each complete automation as one sequence-bearing entity row", () => {
		const automationUuid = testUuid("row-automation");
		const conditionUuid = testUuid("row-automation-condition");
		const updateUuid = testUuid("row-automation-update");
		const automation: Automation = {
			uuid: automationUuid,
			kind: "case-update",
			name: "Close resolved referrals",
			caseType: "referral",
			criteriaOperator: "all",
			criteria: [
				{
					uuid: conditionUuid,
					kind: "match-property",
					scope: "case",
					property: "resolution",
					matchType: "equal",
					value: "complete",
				},
			],
			setupOnlyCriteria: [],
			updates: [
				{
					uuid: updateUuid,
					target: { scope: "case", property: "status_note" },
					value: { kind: "literal", value: "Closed automatically" },
				},
			],
			closeCase: true,
		};
		const doc: BlueprintDoc = {
			appId: "automation-row-app",
			appName: "Referral",
			connectType: null,
			caseTypes: null,
			modules: {},
			forms: {},
			fields: {},
			moduleOrder: [],
			formOrder: {},
			fieldOrder: {},
			fieldParent: {},
			automations: { [automationUuid]: automation },
			automationOrder: [automationUuid],
		};
		const persistable = toPersistableDoc(doc);
		const rows = decomposeBlueprint(persistable).map((row) => ({
			...row,
			data: JSON.parse(JSON.stringify(row.data)),
		}));
		expect(rows).toEqual([
			expect.objectContaining({
				uuid: automationUuid,
				kind: "automation",
				parent_uuid: null,
				ordinal: 0,
			}),
		]);
		expect(
			assembleBlueprint(doc.appId, blueprintScalars(persistable), rows),
		).toEqual(persistable);
	});
});
