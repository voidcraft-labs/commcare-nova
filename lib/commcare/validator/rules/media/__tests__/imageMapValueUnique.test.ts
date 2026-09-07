import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	mediaRecords,
	mediaWireFixture,
} from "@/lib/commcare/__tests__/mediaWireFixtures";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { columnSchema } from "@/lib/domain";
import { runValidation } from "../../../runner";

describe("image mapping identity gate", () => {
	it("refuses a duplicate in both persisted schema and validator with exact row identity", () => {
		const { doc, assets } = mediaWireFixture();
		const module = doc.modules[doc.moduleOrder[0]];
		const column = module.caseListConfig?.columns[1];
		if (column?.kind !== "image-map") throw new Error("Missing image column");
		expect(columnSchema.parse(column)).toEqual(column);
		column.mapping[1].value = column.mapping[0].value;
		const parsed = columnSchema.safeParse(column);
		expect(parsed.success).toBe(false);
		if (parsed.success) throw new Error("Duplicate admitted");
		expect(
			parsed.error.issues.map((issue) => ({
				code: issue.code,
				path: issue.path,
			})),
		).toEqual([{ code: "custom", path: ["mapping"] }]);
		const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE, {
			mediaAssets: mediaRecords(assets),
		});
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({
			code: "CASE_LIST_IMAGE_MAP_DUPLICATE_VALUE",
			scope: "module",
			location: { moduleUuid: module.uuid },
			details: {
				slot: "caseListConfig.columns[1].mapping[1].value",
				columnUuid: column.uuid,
				columnIndex: "1",
				firstRowIndex: "0",
				duplicateRowIndex: "1",
				value: "active",
			},
		});
	});
	it("allows the same value in a different column", () => {
		const { doc, assets } = mediaWireFixture();
		const config = doc.modules[doc.moduleOrder[0]].caseListConfig;
		if (!config) throw new Error("Missing columns");
		const original = config.columns[1];
		const second = { ...original, uuid: testUuid("second-image-map") };
		config.columns.push(second);
		config.listColumnOrder.push(second.uuid);
		config.detailColumnOrder.push(second.uuid);
		expect(
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE, {
				mediaAssets: mediaRecords(assets),
			}),
		).toEqual([]);
	});
});
