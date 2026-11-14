/**
 * A calculated value in wording, `{{= formula}}`, at the authoring boundary.
 *
 * Contract: a formula in a text a form evaluates (a question's label, hint,
 * help text, validation message or choice label) is parsed as form logic in
 * that text's prose slot, against the call's whole scope, and stored as one
 * typed part; a formula that only reads one reference is stored as that
 * reference; a read prints it back as `{{= formula}}`, and sending that read
 * back stores the same document. A text no form evaluates, and an insertion
 * that is empty, unclosed or unreadable, is refused in a sentence the caller
 * can act on. The plausible failures: a question added in the same call left
 * unresolved; an insertion cut at a `}}` inside a quoted string; a choice
 * label sent through `setFieldOptionsSource`, or a new page's title sent
 * through `setFormSections`, read as having no slot; a print
 * that does not parse back to the same part; a case property's label taking
 * a value no form works out.
 */

import { expect, it } from "vitest";
import { makeAuthoringHarness } from "@/lib/agent/__tests__/authoringHarness";
import { namedFormFixture } from "@/lib/agent/__tests__/namedFormFixture";
import { type BlueprintDoc, translationUnitsById } from "@/lib/domain";
import type { ProseTemplate } from "@/lib/domain/prose";
import { proseSlotAt } from "../proseSlots";

function visitApp() {
	return makeAuthoringHarness(
		{},
		namedFormFixture([
			{
				name: "Clients",
				caseType: "client",
				forms: [
					{ name: "Register", type: "registration" },
					{ name: "Visit", type: "followup" },
				],
			},
		]),
	);
}

function fieldNamed(doc: BlueprintDoc, id: string) {
	const field = Object.values(doc.fields).find((each) => each.id === id);
	if (field === undefined) throw new Error(`The app holds no field ${id}.`);
	return field;
}

function partsOf(template: ProseTemplate | undefined) {
	if (template === undefined) throw new Error("The text is missing.");
	return template.parts;
}

async function addVisitNotes(h: ReturnType<typeof visitApp>) {
	const result = await h.call("addFields", {
		moduleUuid: "Clients",
		formUuid: "Visit",
		fields: [
			{ kind: "date", id: "visit_date", label: "Visit date" },
			{
				kind: "text",
				id: "notes",
				// The formula reads a question this same call adds.
				label: "Visit on {{= format-date(date(#form/visit_date), '%e %b %Y')}}",
				// A `}}` inside a quoted string is no end of the formula.
				hint: "{{= concat('a', '}}')}}",
				// A formula that only reads one answer is that answer's reference.
				help: "Seen {{= #form/visit_date}}",
				validate: {
					expr: ". != ''",
					msg: "Write a note for {{= format-date(date(#form/visit_date), '%e %b %Y')}}",
				},
			},
		],
	});
	expect(result).toMatchObject({ ok: true });
}

it("stores a formula as a calculated value in its prose slot, including one reading a question added in the same call", async () => {
	const h = visitApp();
	await addVisitNotes(h);
	const doc = h.currentDoc();
	const visitDate = fieldNamed(doc, "visit_date");
	const notes = fieldNamed(doc, "notes");
	if (notes.kind !== "text") throw new Error("notes is no text question");

	const label = partsOf(notes.label);
	expect(label[0]).toEqual({ kind: "text", text: "Visit on " });
	expect(label[1]).toMatchObject({ kind: "value" });
	expect(label).toHaveLength(2);

	const hint = partsOf(notes.hint);
	expect(hint).toHaveLength(1);
	expect(hint[0]).toMatchObject({ kind: "value" });

	expect(partsOf(notes.help)).toEqual([
		{ kind: "text", text: "Seen " },
		{ kind: "field-ref", uuid: visitDate.uuid },
	]);
	expect(partsOf(notes.validate_msg)[1]).toMatchObject({ kind: "value" });
});

it("prints each calculated value as {{= formula}}, and a read sent back stores the same document", async () => {
	const h = visitApp();
	await addVisitNotes(h);
	const read = (await h.call("getField", {
		moduleUuid: "Clients",
		formUuid: "Visit",
		fieldUuid: "notes",
	})) as {
		field: {
			label: string;
			hint: string;
			help: string;
			validate: { expr: string; msg: string };
		};
	};
	expect(read.field.label).toMatch(/^Visit on \{\{= format-date\(/);
	expect(read.field.hint).toBe("{{= concat('a', '}}')}}");
	expect(read.field.help).toBe("Seen {{visit_date}}");
	expect(read.field.validate.msg).toMatch(/^Write a note for \{\{= /);

	const before = h.currentDoc();
	const resent = await h.call("editField", {
		moduleUuid: "Clients",
		formUuid: "Visit",
		fieldUuid: "notes",
		updates: {
			kind: "text",
			label: read.field.label,
			hint: read.field.hint,
			help: read.field.help,
			validate: read.field.validate,
		},
	});
	expect(resent).toMatchObject({ ok: true });
	expect(h.currentDoc().fields).toEqual(before.fields);
});

it("parses a formula in a choice label sent through setFieldOptionsSource in that choice's slot", async () => {
	const h = visitApp();
	await addVisitNotes(h);
	const added = await h.call("addFields", {
		moduleUuid: "Clients",
		formUuid: "Visit",
		fields: [
			{
				kind: "single_select",
				id: "outcome",
				label: "Outcome",
				optionsSource: {
					kind: "inline",
					options: [
						{ value: "seen", label: "Seen" },
						{ value: "missed", label: "Missed" },
					],
				},
			},
		],
	});
	expect(added).toMatchObject({ ok: true });
	const result = await h.call("setFieldOptionsSource", {
		moduleUuid: "Clients",
		formUuid: "Visit",
		fieldUuid: "outcome",
		source: {
			kind: "inline",
			options: [
				{
					value: "seen",
					label: "Seen {{= concat('on ', #form/visit_date)}}",
				},
				{ value: "missed", label: "Missed" },
			],
		},
	});
	expect(result).toMatchObject({ ok: true });
	const outcome = fieldNamed(h.currentDoc(), "outcome");
	if (
		outcome.kind !== "single_select" ||
		outcome.optionsSource.kind !== "inline"
	)
		throw new Error("outcome is no inline select");
	expect(outcome.optionsSource.options[0]?.label.parts[1]).toMatchObject({
		kind: "value",
	});
});

it("parses a formula in a new page's title, whether the page names its own uuid or leaves it to Nova", async () => {
	const h = visitApp();
	await addVisitNotes(h);
	const before = h.currentDoc();
	const visit = Object.values(before.forms).find(
		(form) => form.name === "Visit",
	);
	if (visit === undefined) throw new Error("The app holds no Visit form.");
	const [first, ...rest] = before.fieldOrder[visit.uuid] ?? [];
	if (first === undefined) throw new Error("The Visit form holds no field.");
	const freshPage = "55555555-5555-4555-8555-555555555555";
	const result = await h.call("setFormSections", {
		moduleUuid: "Clients",
		formUuid: "Visit",
		sections: [
			{
				label: "Visit {{= format-date(today(), '%e %b %Y')}}",
				fields: [first],
			},
			{
				sectionUuid: freshPage,
				label: "Notes {{= concat('for ', #form/visit_date)}}",
				fields: rest,
			},
		],
	});
	expect(result).toMatchObject({ ok: true });
	const doc = h.currentDoc();
	const pages = (doc.fieldOrder[visit.uuid] ?? []).map(
		(uuid) => doc.fields[uuid],
	);
	expect(pages.map((page) => page?.kind)).toEqual(["section", "section"]);
	expect(pages[1]?.uuid).toBe(freshPage);
	for (const page of pages) {
		if (page?.kind !== "section") throw new Error("The page is no section.");
		expect(partsOf(page.label)[1]).toMatchObject({ kind: "value" });
	}
});

it("refuses an empty, unclosed or unreadable formula, and one in a text no form evaluates", async () => {
	const h = visitApp();
	await addVisitNotes(h);
	const label = (text: string) =>
		h.call("editField", {
			moduleUuid: "Clients",
			formUuid: "Visit",
			fieldUuid: "notes",
			updates: { kind: "text", label: text },
		});
	await expect(label("Visit {{= }}")).rejects.toThrow(
		"{{= }} needs a formula after the equals sign, such as {{= format-date(date(#form/visit_date), '%e %b %Y')}}.",
	);
	await expect(
		label("Visit {{= concat('a, #form/visit_date)}}"),
	).rejects.toThrow(
		"The calculated value that starts {{= concat('a, #form/visit_date)}} has no closing }}. A quote mark inside it may be unclosed.",
	);
	await expect(label("Visit {{= #form/nowhere}}")).rejects.toThrow(
		"The calculated value {{= #form/nowhere}} can't be read.",
	);
	await expect(
		h.call("updateCaseProperty", {
			caseType: "client",
			property: "case_name",
			updates: { label: "Name {{= today()}}" },
		}),
	).rejects.toThrow(
		"A calculated value shows only in a question's label, hint, help text, validation message or choice label, where the form works it out. This text is none of those, so it can't hold {{= today()}}. You can write the text without it.",
	);
});

it("answers the prose slot of a translated field text, and none for a text no form evaluates", async () => {
	const h = visitApp();
	await addVisitNotes(h);
	const doc = h.currentDoc();
	const notes = fieldNamed(doc, "notes");
	const units = [...translationUnitsById(doc).values()];
	const hint = units.find(
		(unit) =>
			unit.role === "field-hint" &&
			unit.owner.kind === "field" &&
			unit.owner.fieldUuid === notes.uuid,
	);
	const moduleName = units.find((unit) => unit.role === "module-name");
	if (hint === undefined || moduleName === undefined)
		throw new Error("The app's translation units are missing.");
	const at = (unitId: string) =>
		proseSlotAt(
			"updateTranslations",
			{ updates: [{ unitId, value: "x" }] },
			["updates", 0, "value"],
			doc,
		);
	expect(at(hint.id)).toEqual({
		entity: "field",
		uuid: notes.uuid,
		slot: "hint",
	});
	expect(at(moduleName.id)).toBeUndefined();
	expect(
		proseSlotAt(
			"updateCaseProperty",
			{ updates: {} },
			["updates", "label"],
			doc,
		),
	).toBeUndefined();
});
