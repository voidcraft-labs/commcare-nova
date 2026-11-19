/**
 * A name every JavaScript object inherits, wherever an app supplies a name.
 *
 * Contract: the reader holds what it reads under a name the source supplies
 * only as the name's own entry (`lib/commcare/sourceKeys.ts`: a fixed table
 * is a `SourceTable`, a record the reader builds comes from
 * `recordFromEntries`, a record it did not build is read through
 * `ownRecordValue`, and every object of HQ's JSON and every element's
 * attributes come in with no prototype), so an app that
 * names a language, a case type, a case property, a translation key or a
 * media path `constructor`, `__proto__`, `toString` or `hasOwnProperty`
 * reads as one that uses an ordinary name in its place. Nova's own export of
 * a document whose case type and case property hold such a name reads back
 * to that document's names; an HQ app that holds one where Nova would not
 * write it reads exactly as the same app holding an ordinary name of the same
 * shape, with the name standing where the ordinary one stood.
 *
 * Plausible failures: a record built on `{}` answering the prototype's
 * function for a name it was never given, so the reader reads a function as
 * a text, refuses a legal name or throws from inside a stage; an entry
 * written under `__proto__` dropped, so its language's text or its key's
 * value is lost (a label an ID mapping keys by a case's value, in a second
 * language); a static table indexed by the name.
 */
import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { type BlueprintDoc, proseText } from "@/lib/domain";
import { AUTHORED_CASE_PROPERTY_NAME_PATTERN } from "@/lib/domain/casePropertyName";
import { serializeClaimLog } from "../accounting";
import { readHqApp } from "../index";
import type { ReadOutcome } from "../types";
import { exportedBody, inputFor } from "./novaExport";

/** Each inherited name, beside an ordinary name of the same length and the same characters'
 *  kinds, which no inherited name and nothing else in an app spells. */
const NAMES = [
	["constructor", "constructar"],
	["__proto__", "__prota__"],
	["toString", "toStrang"],
	["hasOwnProperty", "hasOwnPropertz"],
] as const;

type Body = Record<string, unknown>;

/** A registration form writing `property` to a case of `caseType`, listed by it. */
function caseDoc(caseType: string, property: string): BlueprintDoc {
	return buildDoc({
		appName: "Visits",
		modules: [
			{
				name: "Patients",
				caseType,
				caseListConfig: caseListConfig([{ field: property, header: "Seen" }]),
				forms: [
					{
						name: "Register",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "case_name",
								label: proseText("Name"),
								caseWrite: { caseType, property: "case_name" },
							}),
							f({
								kind: "text",
								id: "seen",
								label: proseText("Seen"),
								caseWrite: { caseType, property },
							}),
						],
					},
				],
			},
		],
		caseTypes: [
			{
				name: caseType,
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: property, label: proseText("Seen") },
				],
			},
		],
	});
}

async function read(body: Body): Promise<ReadOutcome> {
	return readHqApp(await inputFor(body), { claims: "full" });
}

/** What a reading says, for comparing two readings: its kind, the document it holds or its
 *  findings, every claim it made and its defects. */
function said(outcome: ReadOutcome): string {
	return JSON.stringify({
		kind: outcome.kind,
		held: outcome.kind === "read" ? outcome.draft.doc : outcome.findings,
		claims: serializeClaimLog(outcome.claims),
		defects: outcome.defects.map((defect) => defect.name),
	});
}

/** One document, so every reading of its export but the edit reads the same identities. */
const PATIENTS = caseDoc("patient", "visits");

/** The app `PATIENTS` exports, with `name` written where `edit` writes it. */
function edited(name: string, edit: (body: Body, name: string) => Body): Body {
	return edit(exportedBody(PATIENTS), name);
}

/** Where two texts first differ, with what each holds there; empty where they are one. */
function around(got: string, want: string): string {
	let at = 0;
	while (at < got.length && got[at] === want[at]) at++;
	if (at === got.length && at === want.length) return "";
	const near = (text: string) => text.slice(Math.max(0, at - 120), at + 120);
	return `got …${near(got)}…\nwant …${near(want)}…`;
}

/** Whether reading the app with the inherited name says what reading it with the ordinary one
 *  says, the inherited name standing where the ordinary one stood (`identities`: whether a
 *  reading mints an entity's identity from the name, which then differs). */
async function readsAsOrdinary(
	edit: (body: Body, name: string) => Body,
	identities: "same" | "minted-from-the-name" = "same",
): Promise<void> {
	const shown = (text: string) =>
		identities === "same" ? text : text.replaceAll(UUID, "<uuid>");
	const unedited = shown(said(await read(exportedBody(PATIENTS))));
	for (const [inherited, ordinary] of NAMES) {
		const withInherited = shown(said(await read(edited(inherited, edit))));
		const withOrdinary = shown(said(await read(edited(ordinary, edit))));
		// The edit reaches the reading: the ordinary name is read where it is written.
		expect(withOrdinary).not.toBe(unedited);
		expect(
			around(withInherited, withOrdinary.replaceAll(ordinary, inherited)),
		).toBe("");
	}
}

const menus = (body: Body) => body.modules as Body[];

/** A UUID as text, which a reading mints for an entity from what names it. */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

describe("a name every object inherits, in an app Nova exported", () => {
	it.each(NAMES.map(([inherited]) => inherited))(
		"reads a case type and a case property named %s back as themselves",
		async (name) => {
			const property = AUTHORED_CASE_PROPERTY_NAME_PATTERN.test(name)
				? name
				: "visits";
			const outcome = await read(exportedBody(caseDoc(name, property)));
			expect(outcome.defects).toEqual([]);
			if (outcome.kind !== "read")
				throw new Error(
					`The export read to an account: ${outcome.findings.map((one) => one.code).join(", ")}`,
				);
			const { doc } = outcome.draft;
			const [menu] = doc.moduleOrder.map((uuid) => doc.modules[uuid]);
			expect(menu?.caseType).toBe(name);
			expect(
				menu?.caseListConfig?.columns.map((column) =>
					"field" in column ? column.field : undefined,
				),
			).toEqual([property]);
			expect(
				doc.caseTypes?.map((type) => [
					type.name,
					type.properties.map((one) => one.name),
				]),
			).toEqual([[name, [property]]]);
		},
	);
});

describe("a name every object inherits, in an app made in CommCare HQ", () => {
	it("reads a language so named as one named in its place", async () => {
		await readsAsOrdinary((body, name) => ({
			...body,
			langs: [...(body.langs as string[]), name],
			modules: menus(body).map((menu) => ({
				...menu,
				name: { ...(menu.name as Body), [name]: "Pacientes" },
			})),
			translations: { ...(body.translations as Body), [name]: {} },
		}));
	});

	it("reads a translation key so named as one named in its place", async () => {
		await readsAsOrdinary((body, name) => {
			const translations = body.translations as Record<string, Body>;
			return {
				...body,
				translations: Object.fromEntries(
					Object.entries(translations).map(([language, strings]) => [
						language,
						// A value whose rest after a carriage return defines an app string is refused
						// at its own key, so the reading names the key.
						{ ...strings, [name]: "Hello\rmodules.m0=Visits" },
					]),
				),
			};
		});
	});

	it("reads a case property so named, which Nova's grammar refuses, as one named in its place", async () => {
		await readsAsOrdinary(
			(body, name) => ({
				...body,
				modules: menus(body).map((menu) => {
					const details = menu.case_details as Record<string, Body>;
					const short = details.short as Body;
					const [column, ...rest] = short.columns as Body[];
					return {
						...menu,
						case_details: {
							...details,
							short: {
								...short,
								columns: [{ ...column, field: name }, ...rest],
							},
						},
					};
				}),
				// A column's identity is minted from the property it shows.
			}),
			"minted-from-the-name",
		);
	});

	it("reads a case property's value so named, which an ID mapping keys a label by, as one named in its place", async () => {
		await readsAsOrdinary((body, name) => ({
			...body,
			// A second language, so each label's translation is held under the value it maps.
			langs: [...(body.langs as string[]), "es"],
			modules: menus(body).map((menu) => {
				const details = menu.case_details as Record<string, Body>;
				const short = details.short as Body;
				const [column, ...rest] = short.columns as Body[];
				const mapping = {
					format: "enum",
					enum: [
						{ key: name, value: { en: "Seen", es: "Visto" } },
						{ key: "unseen", value: { en: "Not seen", es: "No visto" } },
					],
				};
				return {
					...menu,
					case_details: {
						...details,
						short: { ...short, columns: [{ ...column, ...mapping }, ...rest] },
					},
				};
			}),
		}));
	});

	it("reads a media path so named, and a media map keyed by it, as one named in its place", async () => {
		await readsAsOrdinary((body, name) => ({
			...body,
			multimedia_map: {
				...(body.multimedia_map as Body),
				[`jr://file/${name}`]: {
					doc_type: "HQMediaMapItem",
					media_type: "CommCareImage",
					multimedia_id: "0123456789abcdef",
					path: `jr://file/${name}`,
					unique_id: "fedcba9876543210",
					version: 1,
				},
			},
			modules: menus(body).map((menu) => ({
				...menu,
				media_image: { en: `jr://file/${name}` },
			})),
		}));
	});
});
