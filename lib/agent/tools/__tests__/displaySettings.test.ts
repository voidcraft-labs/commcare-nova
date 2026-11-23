/**
 * Every display setting through the tools a model calls, as a client calls
 * them: `addFields` and `editField` from the shared registry (the SA's and
 * MCP's one surface), their published grammar, the tool body and the commit
 * gate.
 *
 * The keys live in three hand-kept lists (the generated tool schema, the add
 * path's `flatFieldToField` and the edit path's patch keys), so the plausible
 * failure is a setting the schema accepts and the tool answers ok for, which
 * then never reaches the document, or a cleared one that stays. Walking the
 * registry catches a key dropped from any of the three. The refusals hold the
 * gate's own rule (`QUESTION_DISPLAY_COMBINATION_INVALID`) and its words on a
 * surface the Builder never reaches, since the Builder hides each refused
 * combination.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { fieldDisplayProblem } from "@/lib/commcare/xform/readDisplaySettings";
import {
	type BlueprintDoc,
	FIELD_DISPLAY_SETTINGS,
	type Field,
	type FieldDisplaySetting,
	type FieldKind,
	fieldDisplayOptionsFor,
} from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { canOfferDisplaySetting } from "@/lib/domain/questionDisplay";
import { expectAdmittedDoc } from "../../__tests__/admittedFixture";
import { makeAuthoringHarness } from "../../__tests__/authoringHarness";

const MOD = testUuid("display-settings-module");
const FORM = testUuid("display-settings-form");
const FORM_ADDRESS = { moduleUuid: MOD, formUuid: FORM };

/** A survey whose one form holds `intro` and `fields`. */
function makeDoc(fields: ReturnType<typeof f>[] = []): BlueprintDoc {
	return expectAdmittedDoc(
		buildDoc({
			modules: [
				{
					uuid: MOD,
					name: "Visits",
					forms: [
						{
							uuid: FORM,
							name: "Visit",
							type: "survey",
							fields: [
								f({ id: "intro", kind: "text", label: "Intro" }),
								...fields,
							],
						},
					],
				},
			],
		}),
	);
}

const OPTIONS = {
	kind: "inline",
	options: [
		{ value: "yes", label: proseText("Yes") },
		{ value: "no", label: proseText("No") },
	],
};

/** The smallest item of `kind` the add path admits, named `q`, as a client
 * authors it. */
function itemOf(kind: FieldKind): Record<string, unknown> {
	return {
		id: "q",
		kind,
		label: "Q",
		...((kind === "single_select" || kind === "multi_select") && {
			optionsSource: {
				kind: "inline",
				options: [
					{ value: "yes", label: "Yes" },
					{ value: "no", label: "No" },
				],
			},
		}),
		...(kind === "repeat" && { repeat: { mode: "user_controlled" } }),
		// A labelled group is born on one screen, which holds no other
		// display setting; the ordinary group is the one the walk sets.
		...(kind === "group" && { field_list: false }),
	};
}

/** The same question as the document holds it, for the domain's own tests. */
function fieldOf(kind: FieldKind, extra: Record<string, unknown>): Field {
	return {
		uuid: testUuid(`display-settings-${kind}`),
		id: "q",
		kind,
		label: proseText("Q"),
		...((kind === "single_select" || kind === "multi_select") && {
			optionsSource: OPTIONS,
		}),
		...(kind === "repeat" && { repeat_mode: "user_controlled" }),
		...extra,
	} as Field;
}

function candidates(
	kind: FieldKind,
	setting: FieldDisplaySetting,
): readonly unknown[] {
	switch (setting.input) {
		case "enum":
		case "flag":
			return Object.keys(fieldDisplayOptionsFor(kind, setting)).map((value) =>
				value === "true" ? true : value,
			);
		case "choice":
			return [{ kind: "dropdown" }, { kind: "grid", columns: 3 }];
		case "channels":
			return [["home"]];
		case "receiver":
			return [{ channel: "home", field: "city" }];
		case "count":
			return ["2"];
	}
}

/** Each setting the Builder offers on an ordinary question of each kind,
 * with a value the gate keeps on its own. */
const CASES = FIELD_DISPLAY_SETTINGS.flatMap((setting) =>
	(setting.kinds as readonly FieldKind[]).flatMap((kind) => {
		// The document runs on both platforms, where a date-and-time
		// question is refused before any display setting is read.
		if (kind === "datetime") return [];
		if (!canOfferDisplaySetting(fieldOf(kind, {}), setting.key, false))
			return [];
		const value = candidates(kind, setting).find(
			(one) =>
				fieldDisplayProblem(fieldOf(kind, { [setting.key]: one })) ===
				undefined,
		);
		return [{ key: setting.key, kind, value }];
	}),
);

/** A refusal at the published grammar throws; one the tool reports is its result's `error`. */
async function attempt(
	h: ReturnType<typeof makeAuthoringHarness>,
	name: string,
	input: unknown,
): Promise<{ ok: true } | { error: string }> {
	try {
		const result = (await h.call(name, input)) as Record<string, unknown>;
		return typeof result.error === "string"
			? { error: result.error }
			: { ok: true };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

function stored(h: ReturnType<typeof makeAuthoringHarness>): Field {
	const field = Object.values(h.currentDoc().fields).find(
		(one) => one?.id === "q",
	);
	if (field === undefined) throw new Error("The question was not added.");
	return field;
}

describe("display settings through addFields and editField", () => {
	it("walks a value for every offered setting and kind", () => {
		expect(CASES.length).toBeGreaterThan(40);
		expect(CASES.filter((one) => one.value === undefined)).toEqual([]);
	});

	it.each(CASES)(
		"stores, clears and sets $key on $kind",
		async ({ key, kind, value }) => {
			const h = makeAuthoringHarness({}, makeDoc());
			expect(
				await attempt(h, "addFields", {
					...FORM_ADDRESS,
					fields: [{ ...itemOf(kind), [key]: value }],
				}),
			).toEqual({ ok: true });
			expect(Reflect.get(stored(h), key)).toEqual(value);
			const at = { ...FORM_ADDRESS, fieldUuid: stored(h).uuid };

			expect(
				await attempt(h, "editField", {
					...at,
					updates: { kind, [key]: null },
				}),
			).toEqual({ ok: true });
			expect(stored(h)).not.toHaveProperty(key);

			expect(
				await attempt(h, "editField", {
					...at,
					updates: { kind, [key]: value },
				}),
			).toEqual({ ok: true });
			expect(Reflect.get(stored(h), key)).toEqual(value);
			expectAdmittedDoc(h.currentDoc());
		},
	);
});

describe("display combinations the tools refuse", () => {
	it.each([
		{
			name: "updates sent from a text question with no address search",
			item: { ...itemOf("text"), sendTopics: ["home"] },
			says: "You can clear Send updates to",
		},
		{
			name: "a placeholder hint on a question with no entry box for it",
			item: { ...itemOf("date"), hintPlacement: "placeholder" },
			says: "You can choose Hide in Web Apps",
		},
		{
			name: "Web Apps signing alone on a picture question",
			item: { ...itemOf("image"), webSignature: true },
			says: "change this picture to a signature on Android",
		},
		{
			name: "a channel name Web Apps reads as a row layout",
			item: { ...itemOf("image"), sendTopics: ["step-1-per-row"] },
			says: "ends in a number followed by -per-row",
		},
	])("refuses $name, naming the step that works", async ({ item, says }) => {
		const h = makeAuthoringHarness({}, makeDoc());
		const refused = await attempt(h, "addFields", {
			...FORM_ADDRESS,
			fields: [item],
		});
		expect(refused).toMatchObject({ error: expect.stringContaining(says) });
		expect(
			Object.values(h.currentDoc().fields).some((one) => one?.id === "q"),
		).toBe(false);
	});

	it("refuses a row setting for repeat entries on a group with no repeat", async () => {
		const h = makeAuthoringHarness({}, makeDoc());
		const refused = await attempt(h, "addFields", {
			...FORM_ADDRESS,
			fields: [{ ...itemOf("group"), repeatsPerRow: "2" }],
		});
		expect(refused).toHaveProperty("error");
	});
});
