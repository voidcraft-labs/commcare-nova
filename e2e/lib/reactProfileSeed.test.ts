import { describe, expect, it } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { evaluateCommit } from "@/lib/commcare/validator/gate";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import { countFieldsUnder } from "@/lib/doc/fieldWalk";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	buildReactProfileBlueprint,
	REACT_PROFILE_SEED,
} from "./reactProfileSeed";

describe("React profile seed", () => {
	it("matches the production-shaped field and logic inventory", () => {
		const { doc, moduleUuid, targetFieldUuid } = buildReactProfileBlueprint();
		const counts = new Map<string, number>();
		let calculates = 0;
		let relevants = 0;
		let validations = 0;
		for (const field of Object.values(doc.fields)) {
			counts.set(field.kind, (counts.get(field.kind) ?? 0) + 1);
			if ("calculate" in field && field.calculate) calculates++;
			if ("relevant" in field && field.relevant) relevants++;
			if ("validate" in field && field.validate) validations++;
		}

		expect(
			doc.formOrder[moduleUuid].map((formUuid) =>
				countFieldsUnder(doc, formUuid),
			),
		).toEqual(REACT_PROFILE_SEED.fieldCounts);
		expect(Object.fromEntries(counts)).toEqual({
			section: 4,
			text: 60,
			group: 14,
			int: 52,
			single_select: 52,
			date: 26,
			label: 4,
			hidden: 114,
		});
		expect(calculates).toBe(102);
		expect(relevants).toBe(192);
		expect(validations).toBe(104);
		expect(doc.caseTypes?.[0]?.properties).toHaveLength(94);
		expect(doc.modules[moduleUuid]?.caseType).toBe("profile_participant");
		expect(
			doc.formOrder[moduleUuid].map((formUuid) => doc.forms[formUuid]?.type),
		).toEqual(["registration", "followup", "followup", "followup"]);
		expect(doc.fields[targetFieldUuid]?.id).toBe(
			REACT_PROFILE_SEED.targetHiddenId,
		);
		expect(
			evaluateCommit({
				nextDoc: doc,
				lookupContext: LOOKUP_CONTEXT_UNAVAILABLE,
			}),
		).toEqual({ ok: true });
		expect(() =>
			diffDocsToMutations(
				buildDoc({ appId: doc.appId, appName: doc.appName }),
				doc,
			),
		).not.toThrow();
	});

	it("can remove the case catalog for a smaller first profiling pass", () => {
		const { doc, moduleUuid } = buildReactProfileBlueprint("profile-app", {
			casePropertyCount: 0,
		});

		expect(doc.caseTypes).toBeNull();
		expect(doc.modules[moduleUuid]?.caseType).toBeUndefined();
		expect(
			doc.formOrder[moduleUuid].map((formUuid) => doc.forms[formUuid]?.type),
		).toEqual(["survey", "survey", "survey", "survey"]);
	});
});
