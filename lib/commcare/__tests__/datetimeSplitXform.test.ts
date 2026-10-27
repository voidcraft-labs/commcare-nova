/**
 * The date-and-time split's joined value as Nova prints it into an XForm:
 * the clock-keeping date over the date and time questions, bound
 * `xsd:dateTime` (bind rule R3) for a writer and a non-writer alike, with its
 * Vellum shadow, and for a writer the same `nova_datetime_` case-write
 * sibling a date-and-time question had. HQ's import and Core read these
 * bytes; the snapshot here is the one execution that settles their spacing.
 */
import { type Element, isTag } from "domhandler";
import { findAll } from "domutils";
import { parseDocument } from "htmlparser2";
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { expandDoc } from "@/lib/commcare/expander";
import { datetimeSplitOriginal } from "@/lib/doc/__tests__/datetimeSplitFixture";
import { planDatetimeSplits } from "@/lib/doc/datetimeSplit";
import { applyMutations } from "@/lib/doc/mutations";
import type { BlueprintDoc } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";

function split(original: BlueprintDoc): BlueprintDoc {
	const plan = planDatetimeSplits(original);
	if (!plan.ok) throw new Error(plan.message);
	return produce(original, (draft) => {
		applyMutations(draft, plan.mutations);
	});
}

/** Every bind of every form the HQ JSON carries, by nodeset. */
function binds(doc: BlueprintDoc): Map<string, Record<string, string>> {
	const hq = expandDoc(doc);
	const found = new Map<string, Record<string, string>>();
	for (const source of Object.values(hq._attachments)) {
		if (typeof source !== "string") continue;
		const tree = parseDocument(source, { xmlMode: true });
		for (const bind of findAll(
			(element: Element) => isTag(element) && element.name === "bind",
			tree.children,
		)) {
			const nodeset = bind.attribs.nodeset;
			if (nodeset !== undefined) found.set(nodeset, bind.attribs);
		}
	}
	return found;
}

const join = (date: string, time: string) =>
	`date(format-date(if(${date} = '' or ${time} = '', '', concat(${date}, 'T', ${time})), '%Y-%m-%dT%H:%M:%S.%3%Z'))`;

describe("the split's joined value in an XForm", () => {
	const found = binds(split(datetimeSplitOriginal()));

	it("binds a writer xsd:dateTime calculated by the join, with its Vellum shadow", () => {
		expect(found.get("/data/seen_at")).toEqual({
			type: "xsd:dateTime",
			nodeset: "/data/seen_at",
			"vellum:nodeset": "#form/seen_at",
			calculate: join("/data/seen_at_date", "/data/seen_at_time"),
			"vellum:calculate": join("#form/seen_at_date", "#form/seen_at_time"),
		});
	});

	it("keeps the writer's case-write sibling exactly as a date-and-time question had it", () => {
		expect(found.get("/data/nova_datetime_seen_at")).toEqual({
			type: "xsd:string",
			nodeset: "/data/nova_datetime_seen_at",
			calculate:
				"if(/data/seen_at = '', '', format-date(coalesce(/data/seen_at, ''), '%Y-%m-%dT%H:%M:%S.%3%Z'))",
			relevant: "count(/data/seen_at) > 0",
		});
	});

	it("binds a non-writer xsd:dateTime too, so Core keeps its clock", () => {
		for (const id of ["planned_at", "due_at"]) {
			expect(found.get(`/data/${id}`)).toEqual({
				type: "xsd:dateTime",
				nodeset: `/data/${id}`,
				"vellum:nodeset": `#form/${id}`,
				calculate: join(`/data/${id}_date`, `/data/${id}_time`),
				"vellum:calculate": join(`#form/${id}_date`, `#form/${id}_time`),
			});
			expect(found.has(`/data/nova_datetime_${id}`)).toBe(false);
		}
		expect(found.get("/data/planned_at_date")?.type).toBe("xsd:date");
		expect(found.get("/data/planned_at_time")?.type).toBe("xsd:time");
	});

	it("prints a join inside a repeat over the repeat's own paths", () => {
		const inRepeat = binds(
			split(
				buildDoc({
					modules: [
						{
							name: "Visits",
							forms: [
								{
									name: "Log",
									type: "survey",
									fields: [
										f({
											kind: "repeat",
											id: "visits",
											label: proseText("Visits"),
											children: [
												f({
													kind: "datetime",
													id: "visit",
													label: proseText("Visit"),
												}),
											],
										}),
									],
								},
							],
						},
					],
				}),
			),
		);
		expect(inRepeat.get("/data/visits/visit")).toMatchObject({
			type: "xsd:dateTime",
			calculate: join("/data/visits/visit_date", "/data/visits/visit_time"),
			"vellum:calculate": join(
				"#form/visits/visit_date",
				"#form/visits/visit_time",
			),
		});
	});
});
