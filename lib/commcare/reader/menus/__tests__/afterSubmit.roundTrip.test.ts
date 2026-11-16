/**
 * After-submit links read back from Nova's emission, over the link
 * generator the stack algebra test draws from: the destinations in Nova's
 * order (HQ stores them reversed), the otherwise in both its shapes, and no
 * held-case guard left in a read condition.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { BlueprintDoc, FormLinkTarget } from "@/lib/domain";
import {
	buildShape,
	type DrawnOtherwise,
	mayNotRun,
	shape,
} from "../../../__tests__/formLinkDocArbitrary";
import { codesOf, formNamed, readMenusOf } from "./menuReading";

/** A target by the names of what it opens, so two documents' minted ids compare. */
function named(doc: BlueprintDoc, target: FormLinkTarget): string {
	if (target.type === "this-form") return "this-form";
	const menu = doc.modules[target.moduleUuid]?.name ?? "?";
	return target.type === "form"
		? `${menu}/${doc.forms[target.formUuid]?.name ?? "?"}`
		: menu;
}

/** A form's after-submit with identities replaced by names. */
function afterSubmitOf(doc: BlueprintDoc, formName: string) {
	const form = formNamed(doc, formName);
	return {
		postSubmit: form.postSubmit,
		links: (form.formLinks ?? []).map((link) => ({
			target: named(doc, link.target),
			condition: link.condition,
			datums: link.datums?.map((datum) => ({
				module:
					datum.name.kind === "selected-case"
						? doc.modules[datum.name.module]?.name
						: "?",
				xpath: datum.xpath,
			})),
		})),
		otherwise:
			form.otherwise?.kind === "link"
				? {
						kind: "link",
						target: named(doc, form.otherwise.target),
						datums: form.otherwise.datums?.map((datum) => datum.xpath),
					}
				: form.otherwise,
	};
}

describe("after-submit links read back from Nova's emission", () => {
	it("reads the destinations in Nova's order, the otherwise in both shapes, and no guard", async () => {
		await fc.assert(
			fc.asyncProperty(shape, async ({ destinations, otherwise: drawn }) => {
				const drawnOtherwise: DrawnOtherwise = destinations.some(mayNotRun)
					? drawn
					: { kind: "none" };
				const doc = buildShape(destinations, drawnOtherwise);
				const reading = await readMenusOf(doc);
				expect(codesOf(reading)).toEqual([]);
				const read = reading.doc as BlueprintDoc;
				expect(afterSubmitOf(read, "Check")).toEqual(
					afterSubmitOf(doc, "Check"),
				);
			}),
			{ numRuns: 30 },
		);
	});
});
