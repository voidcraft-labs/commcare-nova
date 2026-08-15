import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig } from "@/lib/__tests__/docHelpers";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import type { Predicate } from "@/lib/domain/predicate";
import {
	CASE_STATUS_FILTER_REPAIR_TARGETS,
	planCaseStatusFilterRepair,
} from "../caseStatusFilterRepair";

const FIRST_APP = "NJEsUdfCjbgBqAv3nXDN";

function filter(
	value: "collected" | "delivered",
	property = "status",
): Predicate {
	return {
		kind: "eq",
		left: {
			kind: "term",
			term: {
				kind: "prop",
				caseType: "rdt_sample",
				property,
				via: { kind: "self" },
			},
		},
		right: {
			kind: "term",
			term: {
				kind: "literal",
				value,
				data_type: "single_select",
			},
		},
	};
}

function fixture() {
	const targets = CASE_STATUS_FILTER_REPAIR_TARGETS.filter(
		(target) => target.appId === FIRST_APP,
	);
	return toPersistableDoc(
		buildDoc({
			appId: FIRST_APP,
			caseTypes: [
				{
					name: "rdt_sample",
					properties: [
						{ name: "case_name", label: "Sample ID" },
						{
							name: "status_value",
							label: "Sample status",
							data_type: "single_select",
							options: [
								{ value: "collected", label: "Collected" },
								{ value: "delivered", label: "Delivered" },
							],
						},
					],
				},
			],
			modules: targets.map((target) => ({
				uuid: target.moduleUuid,
				name: target.value,
				caseType: "rdt_sample",
				caseListOnly: true,
				caseListConfig: {
					...caseListConfig([{ field: "case_name", header: "Sample" }]),
					filter: filter(target.value),
				},
			})),
		}),
	);
}

describe("case-status filter cutover repair", () => {
	it("changes only the reviewed built-in status references and is idempotent", () => {
		const source = fixture();
		const first = planCaseStatusFilterRepair(source);
		expect(first.findings.map((finding) => finding.standing)).toEqual([
			"repairable",
			"repairable",
		]);
		for (const target of CASE_STATUS_FILTER_REPAIR_TARGETS.filter(
			(candidate) => candidate.appId === FIRST_APP,
		)) {
			expect(
				first.targetDoc.modules[target.moduleUuid]?.caseListConfig?.filter,
			).toEqual(filter(target.value, "status_value"));
			expect(source.modules[target.moduleUuid]?.caseListConfig?.filter).toEqual(
				filter(target.value),
			);
		}
		expect(
			planCaseStatusFilterRepair(first.targetDoc).findings.map(
				(finding) => finding.standing,
			),
		).toEqual(["clean", "clean"]);
	});

	it("does not overwrite a later user correction", () => {
		const source = fixture();
		const target = CASE_STATUS_FILTER_REPAIR_TARGETS.find(
			(candidate) => candidate.appId === FIRST_APP,
		);
		if (target === undefined) throw new Error("missing fixture target");
		const module = source.modules[target.moduleUuid];
		if (module?.caseListConfig === undefined) throw new Error("missing module");
		const corrected = {
			...source,
			modules: {
				...source.modules,
				[target.moduleUuid]: {
					...module,
					caseListConfig: {
						...module.caseListConfig,
						filter: { kind: "match-all" as const },
					},
				},
			},
		};
		expect(planCaseStatusFilterRepair(corrected).findings[0]).toMatchObject({
			standing: "superseded",
		});
	});

	it("blocks when the reviewed destination option no longer exists", () => {
		const source = fixture();
		if (source.caseTypes === null) throw new Error("missing case types");
		const blocked = {
			...source,
			caseTypes: source.caseTypes.map((caseType) => ({
				...caseType,
				properties: caseType.properties.map((property) =>
					property.name === "status_value"
						? { ...property, options: [] }
						: property,
				),
			})),
		};
		expect(
			planCaseStatusFilterRepair(blocked).findings.every(
				(finding) => finding.standing === "blocked",
			),
		).toBe(true);
	});
});
