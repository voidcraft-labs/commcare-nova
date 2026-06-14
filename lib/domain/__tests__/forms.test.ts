// lib/domain/__tests__/forms.test.ts
//
// Schema-level invariants for form entities. These tests pin
// semantic invariants the runtime consumers rely on (e.g. session
// emitter / expander agree on what "condition present" means) rather
// than the shape of Zod's own combinator output.

import { describe, expect, it } from "vitest";
import { asUuid, formSchema } from "@/lib/domain";
import { opaqueXPathExpression } from "../xpath";

describe("formSchema — formLinks", () => {
	const baseForm = {
		uuid: asUuid("frm-1"),
		id: "intake",
		name: "Intake",
		type: "survey" as const,
	};

	const linkTarget = {
		type: "form" as const,
		moduleUuid: asUuid("mod-1"),
		formUuid: asUuid("frm-2"),
	};

	it("accepts an empty condition expression — emitters read it as unconditional", () => {
		// No commit boundary stores an empty condition (an empty commit
		// clears the slot), and both emitters collapse a degenerate empty
		// expression to "unconditional": the session emitter's truthy
		// check over the printed text, and the expander's explicit
		// empty-printed-condition drop.
		const result = formSchema.safeParse({
			...baseForm,
			formLinks: [{ condition: opaqueXPathExpression(""), target: linkTarget }],
		});
		expect(result.success).toBe(true);
	});

	it("accepts an absent condition (unconditional link)", () => {
		const result = formSchema.safeParse({
			...baseForm,
			formLinks: [{ target: linkTarget }],
		});
		expect(result.success).toBe(true);
	});

	it("accepts a non-empty condition (conditional link)", () => {
		const result = formSchema.safeParse({
			...baseForm,
			formLinks: [
				{
					condition: opaqueXPathExpression("/data/outcome = 'yes'"),
					target: linkTarget,
				},
			],
		});
		expect(result.success).toBe(true);
	});
});
