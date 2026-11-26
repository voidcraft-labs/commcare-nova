import type { Element } from "domhandler";
import { type WireElementContext, xel } from "../elementBuilders";
import { validatePropertyName } from "../identifierValidation";
import { w } from "../xpath/wire/builders";
import { caseById } from "../xpath/wire/rowScope";
import type { WireExpr } from "../xpath/wire/tree";
import { FormPath } from "./formPath";

/** HQ XForm.add_case_preloads and the equivalent advanced load loop. Each
 * get_case_parent_id_xpath step follows the named index on the last case. */
export function caseOpeningSetvalues(
	preload: Readonly<Record<string, string>>,
	selection: WireExpr,
	context: WireElementContext,
): Element[] {
	return Object.entries(preload).map(([target, path]) => {
		const steps = path.split("/");
		const property = steps.pop() ?? "";
		let id = selection;
		for (const step of steps)
			id = w.append(caseById(id, "casedb"), [
				w.step("index"),
				w.step(validatePropertyName(step)),
			]);
		const leaf =
			property === "owner_id"
				? w.attr("owner_id")
				: w.step(
						property === "name" ? "case_name" : validatePropertyName(property),
					);
		return xel(
			"setvalue",
			{
				attributes: { event: "xforms-ready" },
				xpath: {
					ref: FormPath.parse(target).toWire(),
					value: w.append(caseById(id, "casedb"), [leaf]),
				},
			},
			context,
		);
	});
}
