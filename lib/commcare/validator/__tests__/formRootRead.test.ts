import { describe, expect, it } from "vitest";
import {
	formFixture,
	ids,
	requireContext,
} from "@/lib/domain/expression/__tests__/formFixture";
import { typeOf } from "@/lib/domain/expression/typeChecker";
import type { Expression } from "@/lib/domain/expression/types";
import {
	formLogicFindings,
	SESSION_FORM_READ_MESSAGE,
} from "../formLogicFindings";

const root: Expression = {
	kind: "term",
	term: {
		kind: "form-node",
		node: { kind: "form-root", form: ids.form },
		spelling: "relative",
	},
};
describe("the finite form root coordinate", () => {
	it("is typed by its actual form structure while the form is open", () => {
		const ctx = requireContext(formFixture(), {
			entity: "field",
			uuid: ids.hidden,
			slot: "calculate",
		});
		expect(typeOf(root, ctx)?.data).toEqual(
			expect.objectContaining({ structural: true }),
		);
		expect(formLogicFindings(root, ctx)).toEqual([]);
	});
	it("cannot read a closed form in a link", () => {
		const ctx = requireContext(formFixture(), {
			entity: "form",
			uuid: ids.form,
			slot: "form_link_condition",
			member: { linkUuid: ids.link },
		});
		expect(formLogicFindings(root, ctx)).toEqual([
			expect.objectContaining({
				code: "INVALID_REF",
				message: SESSION_FORM_READ_MESSAGE,
				checkCode: "form-answer-unavailable",
			}),
		]);
	});
});
