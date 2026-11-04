/**
 * A question's answer saved as it is to the form's own case saves nothing
 * while the question is not answered, wherever the own arm's block stands:
 * HQ's basic update guards its row with `count(path) > 0`, so the Save to
 * Case row the own arm takes when Case Management can't state it carries
 * the same guard. Catches a hidden question clearing a stored property in
 * one placement and keeping it in the other.
 */
import { type Element, isTag } from "domhandler";
import { parseDocument } from "htmlparser2";
import { expect, it } from "vitest";
import { planPlacements } from "@/lib/commcare/placement";
import { buildXForm } from "@/lib/commcare/xform/builder";
import { concat } from "@/lib/domain/expression/builders";
import { OWN, own, placementFixture, read } from "./placementFixture";

function elements(node: { children: unknown[] }): Element[] {
	return (node.children as Element[])
		.filter(isTag)
		.flatMap((child) => [child, ...elements(child)]);
}

it("guards an own-case answer row in a Save to Case block as the basic update does", () => {
	const { doc, formUuid } = placementFixture("followup", {
		operations: () => [
			own({
				writes: [
					{ property: "age", value: read("age") },
					{ property: "status", value: concat(read("name"), read("name")) },
				],
			}),
		],
	});
	expect(
		planPlacements(doc, formUuid).placements.get(OWN)?.placement.kind,
	).toBe("save-to-case");
	const xml = buildXForm(doc, formUuid, {
		xmlns: "http://openrosa.org/formdesigner/own-answer-presence",
		moduleCaseType: "patient",
	});
	const binds = elements(parseDocument(xml, { xmlMode: true })).filter(
		(element) => element.name === "bind",
	);
	const bindOf = (suffix: string) =>
		binds.find((bind) => bind.attribs.nodeset?.endsWith(suffix))?.attribs;
	expect(bindOf("/case/update/age")?.relevant).toBe("count(/data/age) > 0");
	expect(bindOf("/case/update/status")?.relevant).toBeUndefined();
});
