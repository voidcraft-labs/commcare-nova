// lib/domain/__tests__/forms.test.ts
//
// Schema-level invariants for form entities. These tests pin
// semantic invariants the runtime consumers rely on (e.g. session
// emitter / expander agree on what "condition present" means) rather
// than the shape of Zod's own combinator output.

import { describe, expect, it } from "vitest";
import { asUuid, formSchema } from "@/lib/domain";

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

	it("rejects empty-string condition on a form link", () => {
		// The session emitter's truthy check (`if (link.condition)`) treats
		// "" as unconditional while the expander's `!== undefined` check
		// treats it as present — schema rejection prevents the disagreement
		// from manifesting in a persisted blueprint.
		const result = formSchema.safeParse({
			...baseForm,
			formLinks: [{ condition: "", target: linkTarget }],
		});
		expect(result.success).toBe(false);
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
			formLinks: [{ condition: "/data/outcome = 'yes'", target: linkTarget }],
		});
		expect(result.success).toBe(true);
	});
});
