import { expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { publishedQuestionPaths } from "@/lib/commcare/hq/publishedQuestionPaths";
import { exportedBody } from "@/lib/commcare/reader/__tests__/novaExport";
import { sourceFromBody } from "@/lib/commcare/reader/__tests__/readerInput";
import { derivedFormXmlns } from "@/lib/commcare/wireIdentity";

it("recovers only the actual submitted columns from a historical query-form adoption", async () => {
	const doc = buildDoc({
		modules: [
			{
				name: "Visits",
				forms: [
					{
						name: "Check",
						type: "survey",
						fields: [
							f({
								kind: "repeat",
								id: "visits",
								repeat_mode: "query_bound",
								data_source: { ids_query: "'a b'" },
								children: [f({ kind: "text", id: "note" })],
							}),
						],
					},
				],
			},
		],
	});
	const form = Object.values(doc.forms)[0];
	form.dataRootName = "visit";
	const repeat = Object.values(doc.fields).find(
		(field) => field.id === "visits",
	);
	const note = Object.values(doc.fields).find((field) => field.id === "note");
	if (repeat?.kind !== "repeat" || !note)
		throw new Error("The fixture needs a repeated note.");
	const source = await sourceFromBody(exportedBody(doc));
	const adopted = new Map([[form.uuid, derivedFormXmlns(form.uuid)]]);
	expect(publishedQuestionPaths(doc, source, adopted)).toContain(note.uuid);
	const manual = structuredClone(doc);
	const rows = manual.fields[repeat.uuid];
	if (rows.kind !== "repeat" || rows.repeat_mode !== "query_bound")
		throw new Error("Expected a query repeat.");
	const { data_source: _query, ...base } = rows;
	manual.fields[repeat.uuid] = { ...base, repeat_mode: "user_controlled" };
	expect(publishedQuestionPaths(manual, source, adopted)).toEqual([
		repeat.uuid,
	]);
	Object.values(manual.forms)[0].dataRootName = "new_visit";
	expect(publishedQuestionPaths(manual, source, adopted)).toEqual([]);
});
