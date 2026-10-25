/** The date-and-time pre-check of `addFields` and `editField`, through the
 * published grammar and the shared tool body, and held to the commit gate:
 * for each declaration it refuses exactly the batch the gate refuses, in the
 * gate finding's own message. */
import { describe, expect, it } from "vitest";
import { makeAuthoringHarness } from "@/lib/agent/__tests__/authoringHarness";
import { namedFormFixture } from "@/lib/agent/__tests__/namedFormFixture";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc, Platform, Uuid } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { guardedMutate } from "../common";
import { assembleFieldMutations } from "../shared/fieldAssembly";
import { fieldKindPlatformRefusal } from "../shared/platformPrecheck";

const FORM = "Register visit";

function fixtureDoc(runsOnlyOn?: Platform): BlueprintDoc {
	return namedFormFixture(
		[{ name: "Visits", forms: [{ name: FORM, type: "survey" }] }],
		runsOnlyOn === undefined ? {} : { runsOnlyOn },
	);
}

function formUuidOf(doc: BlueprintDoc): Uuid {
	const form = Object.values(doc.forms).find((each) => each.name === FORM);
	if (!form) throw new Error("The fixture form is missing.");
	return form.uuid;
}

const DATETIME = { kind: "datetime", id: "visit_time", label: "Visit time" };

describe("the date-and-time pre-check", () => {
	it("refuses a date-and-time question in an app that runs on both, before staging", async () => {
		const doc = fixtureDoc();
		const h = makeAuthoringHarness({}, doc);
		const result = await h.call("addFields", {
			formUuid: FORM,
			fields: [DATETIME],
		});
		expect(result).toEqual({
			error: fieldKindPlatformRefusal(doc, formUuidOf(doc), [
				{ kind: "datetime", id: "visit_time" },
			]),
		});
		expect(result).toMatchObject({
			error: expect.stringContaining(
				`Question "visit_time" in form "${FORM}" is a date-and-time question, and the app runs in Web Apps and on Android.`,
			),
		});
		expect(h.recordMutations).not.toHaveBeenCalled();
		expect(h.currentDoc()).toBe(doc);
	});

	it("adds a date-and-time question in an app that runs only on Android", async () => {
		const h = makeAuthoringHarness({}, fixtureDoc("android"));
		expect(
			await h.call("addFields", { formUuid: FORM, fields: [DATETIME] }),
		).toMatchObject({ ok: true });
	});

	it.each([
		[undefined, "refuses"],
		["android", "converts"],
	] as const)(
		"with runsOnlyOn %s, a date question converted to date and time %s",
		async (runsOnlyOn, verb) => {
			const h = makeAuthoringHarness({}, fixtureDoc(runsOnlyOn));
			expect(
				await h.call("addFields", {
					formUuid: FORM,
					fields: [{ kind: "date", id: "visit_time", label: "Visit time" }],
				}),
			).toMatchObject({ ok: true });
			const before = h.currentDoc();
			const field = Object.values(before.fields).find(
				(each) => each.id === "visit_time",
			);
			if (!field) throw new Error("The date question is missing.");
			const result = await h.call("editField", {
				fieldUuid: field.uuid,
				updates: { kind: "datetime" },
			});
			if (verb === "refuses") {
				expect(result).toEqual({
					error: fieldKindPlatformRefusal(before, formUuidOf(before), [
						{ kind: "datetime", id: "visit_time" },
					]),
				});
				expect(h.currentDoc()).toBe(before);
			} else {
				expect(result).toMatchObject({ ok: true });
				expect(h.currentDoc().fields[field.uuid]?.kind).toBe("datetime");
			}
		},
	);

	it("names a question renamed in the same call by its new id, as the gate does", async () => {
		const h = makeAuthoringHarness({}, fixtureDoc());
		expect(
			await h.call("addFields", {
				formUuid: FORM,
				fields: [{ kind: "date", id: "visit_time", label: "Visit time" }],
			}),
		).toMatchObject({ ok: true });
		const before = h.currentDoc();
		const field = Object.values(before.fields).find(
			(each) => each.id === "visit_time",
		);
		if (!field) throw new Error("The date question is missing.");
		expect(
			await h.call("editField", {
				fieldUuid: field.uuid,
				updates: { id: "visit_moment", kind: "datetime" },
			}),
		).toEqual({
			error: fieldKindPlatformRefusal(before, formUuidOf(before), [
				{ kind: "datetime", id: "visit_moment" },
			]),
		});
		expect(h.currentDoc()).toBe(before);
	});

	it.each([undefined, "web-apps", "android"] as const)(
		"with runsOnlyOn %s, refuses exactly what the gate refuses, in its words",
		async (runsOnlyOn) => {
			const doc = fixtureDoc(runsOnlyOn);
			const formUuid = formUuidOf(doc);
			const assembly = assembleFieldMutations({
				doc,
				formUuid,
				items: [
					{ ...DATETIME, kind: "datetime", label: proseText(DATETIME.label) },
				],
				anchor: {},
			});
			if (!assembly.ok) throw new Error("The question didn't assemble.");
			const precheck = fieldKindPlatformRefusal(doc, formUuid, [
				{ kind: "datetime", id: "visit_time" },
			]);
			// The same batch, with the pre-check bypassed.
			const h = makeAuthoringHarness({}, doc);
			const gate = await h.workspace.invoke({
				toolName: "addFields",
				execute: (ctx) => guardedMutate(ctx, assembly.mutations),
			});
			expect(precheck !== undefined).toBe(!gate.ok);
			const verdict = mutationCommitVerdict(
				doc,
				assembly.mutations,
				LOOKUP_CONTEXT_UNAVAILABLE,
			);
			const finding = verdict.ok
				? undefined
				: verdict.findings.find(
						(each) => each.code === "PLATFORM_FEATURE_UNAVAILABLE",
					);
			expect(precheck).toBe(finding?.message);
		},
	);
});
