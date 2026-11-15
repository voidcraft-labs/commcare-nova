/**
 * Acceptance accepts a correct reading.
 *
 * Contract: CommCare HQ's retained answers for an app it reads whole (the
 * corpus document `navigation-base` after Nova's first publish: its
 * application resource with HQ's own question summary, its source and its
 * version read), read by the production reader with a fresh minting
 * resolver, answer `ok` through all five checks, with one declaration per
 * choice the reading offers, the preselected one's first-publish list, and
 * whether the source holds a Save to Case block. The registration form
 * there holds Nova's conjoined case-name check alone, which HQ's summary
 * reports as the source's validation and the document holds as none. Each
 * named case is a reading of a source CommCare HQ could hold, built from
 * that retained source or from Nova's own emission, that must also answer
 * `ok`.
 *
 * Plausible failure: a check that fails a correct reading, which would stop
 * every bring-in.
 */

import { describe, expect, it } from "vitest";
import {
	retainedBodyJson,
	retainedReadingRead,
} from "@/__tests__/helpers/retainedHqReads";
import { testMediaAssetId } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { exportedBody } from "@/lib/commcare/reader/__tests__/novaExport";
import { sourceFromBody } from "@/lib/commcare/reader/__tests__/readerInput";
import { FormPath } from "@/lib/commcare/xform/formPath";
import { typedInstantValue } from "@/lib/commcare/xpath/wire/instant";
import { serializeWire } from "@/lib/commcare/xpath/wire/serialize";
import { type BlueprintDoc, proseText } from "@/lib/domain";
import { type AcceptReadingInput, acceptReading } from "../acceptance";
import {
	acceptanceInput,
	DOMAIN,
	HOST,
	navigationBaseRead,
	readClean,
	readingInput,
} from "./acceptanceInput";
import {
	controlAt,
	editXml,
	findElement,
	servedReading,
	servedSource,
} from "./servedReading";

type Body = Record<string, unknown>;

/** Acceptance's answer, which the test holds to be `ok`. */
function accepted(input: AcceptReadingInput) {
	const answer = acceptReading(input);
	if (!answer.ok)
		throw new Error(
			`${answer.check}: ${answer.differences.map((one) => `${one.signature} ${one.detail}`).join("\n")}`,
		);
	return answer;
}

/** Each form's XML of a source body, through `edit`. */
function eachForm(
	edit: (
		root: ReturnType<typeof import("@/lib/commcare/xmlParse").parseXml>,
	) => void,
) {
	return (body: Body): Body => ({
		...body,
		_attachments: Object.fromEntries(
			Object.entries(body._attachments as Record<string, string>).map(
				([name, xml]) => [name, editXml(xml, edit)],
			),
		),
	});
}

/** Every summarized question of HQ's application body, through `edit`. */
function eachQuestion(edit: (question: Body) => Body) {
	return (body: Body): Body => ({
		...body,
		modules: (body.modules as Body[]).map((module) => ({
			...module,
			forms: ((module.forms as Body[] | undefined) ?? []).map((form) => ({
				...form,
				questions: (form.questions as Body[]).map(edit),
			})),
		})),
	});
}

/** Acceptance over navigation-base as CommCare HQ serves and summarizes it, each doctored alike. */
async function navigationBase(
	options: Parameters<typeof navigationBaseRead>[0],
) {
	const { source, modules } = await navigationBaseRead(options);
	const reader = readingInput(source, modules);
	return accepted(acceptanceInput(reader, readClean(reader)));
}

describe("acceptReading over CommCare HQ's retained answers", () => {
	it("accepts the reading of navigation-base with the first-publish list of each choice", async () => {
		const { source, modules } = await navigationBaseRead();
		const reader = readingInput(source, modules);
		const outcome = readClean(reader);
		const input = acceptanceInput(reader, outcome);
		const accepted = acceptReading(input);
		if (!accepted.ok)
			throw new Error(
				`${accepted.check}: ${accepted.differences.map((one) => `${one.signature} ${one.detail}`).join("\n")}`,
			);
		expect(accepted.declarations).toHaveLength(input.choices.choices.length);
		expect(accepted.declarations.findIndex((one) => one.preselected)).toBe(
			input.choices.proposed,
		);
		const preselected = accepted.declarations[input.choices.proposed];
		expect(accepted.firstPublish).toEqual(preselected?.firstPublish);
		expect(accepted.firstPublish.of).toBe("first-publish");
		expect(accepted.firstPublish.ids).toContain("forms-and-settings-rewritten");
		expect(accepted.sourceHoldsSaveToCase).toBe(false);
	});

	it("accepts a registration form whose name question holds no validation", async () => {
		await navigationBase({
			body: eachForm((root) => {
				const bind = findElement(
					root,
					(element) =>
						element.name === "bind" && element.attribs.nodeset === "/data/name",
				);
				if (bind === undefined) return;
				delete bind.attribs.constraint;
				delete bind.attribs.required;
			}),
			summary: eachQuestion((question) =>
				question.value === "/data/name"
					? { ...question, constraint: null, required: false }
					: question,
			),
		});
	});

	it("accepts a label written inline, which CommCare HQ does not summarize", async () => {
		await navigationBase({
			body: eachForm((root) => {
				const input = findElement(root, controlAt("/data/answer"));
				const label =
					input === undefined
						? undefined
						: findElement(input, (element) => element.name === "label");
				if (label === undefined) return;
				delete label.attribs.ref;
				label.children = [{ type: "text", data: "Notes" } as never];
			}),
			summary: eachQuestion((question) =>
				question.value === "/data/answer"
					? { ...question, translations: {} }
					: question,
			),
		});
	});

	it("skips a menu CommCare HQ could not summarize", async () => {
		const errorEntry = (
			retainedBodyJson(retainedReadingRead("application-error-module"))
				.modules as unknown[]
		)[0];
		const { source, modules } = await navigationBaseRead({
			summary: (body) => ({ ...body, modules: [errorEntry] }),
		});
		expect(modules[0]?.kind).toBe("not-summarized");
		const reader = readingInput(source, modules);
		const accepted = acceptReading(acceptanceInput(reader, readClean(reader)));
		expect(accepted.ok).toBe(true);
	});
});

/** One form holding each shape a named case doctors. */
const SHAPES = buildDoc({
	appName: "Shapes",
	modules: [
		{
			name: "Visits",
			forms: [
				{
					name: "Visit",
					type: "survey",
					fields: [
						f({
							kind: "group",
							id: "grp",
							fieldList: true,
							children: [f({ kind: "text", id: "inner" })],
						}),
						f({
							kind: "group",
							id: "plain_group",
							children: [f({ kind: "text", id: "held" })],
						}),
						f({ kind: "text", id: "plain" }),
					],
				},
			],
		},
	],
});

/** Acceptance over a source of `doc`'s export, each form's XML through `edit`. */
async function servedAccepted(
	doc: BlueprintDoc,
	edit?: (xml: string) => string,
	change: (input: AcceptReadingInput) => AcceptReadingInput = (input) => input,
) {
	const read = servedReading(await servedSource(doc, edit));
	return accepted(change(acceptanceInput(read.reader, read.outcome)));
}

describe("acceptReading over sources CommCare HQ could hold", () => {
	it("accepts a control whose appearance the reader accounts as inert", async () => {
		await servedAccepted(SHAPES, (xml) =>
			editXml(xml, (root) => {
				const control = findElement(root, controlAt("/data/plain"));
				if (control === undefined) throw new Error("No control.");
				control.attribs.appearance = "whatever";
			}),
		);
	});

	it("accepts a group whose label is blank, and a group written Field-List", async () => {
		await servedAccepted(SHAPES, (xml) =>
			editXml(xml, (root) => {
				const text = findElement(
					root,
					(element) =>
						element.name === "text" &&
						element.attribs.id === "plain_group-label",
				);
				if (text === undefined) throw new Error("The group's label is itext.");
				for (const value of text.children)
					if ((value as { name?: string }).name === "value")
						(value as { children: unknown[] }).children = [];
			}),
		);
		await servedAccepted(SHAPES, (xml) =>
			editXml(xml, (root) => {
				const group = findElement(root, controlAt("/data/grp"));
				if (group === undefined) throw new Error("No group.");
				group.attribs.appearance = "Field-List";
			}),
		);
	});

	it("accepts a media reference with no file, left out as inert", async () => {
		const icon = testMediaAssetId("icon");
		const doc = buildDoc({
			appName: "Clinic",
			modules: [
				{
					name: "Visits",
					forms: [
						{
							name: "Visit",
							type: "survey",
							fields: [
								f({ kind: "text", id: "q", label_media: { image: icon } }),
							],
						},
					],
				},
			],
		});
		const source = await sourceFromBody(
			exportedBody(doc, {
				expand: {
					attachmentTarget: { origin: HOST, domain: DOMAIN },
					assets: new Map([
						[
							icon,
							{
								assetId: icon,
								kind: "image",
								wirePath: "commcare/icon.png",
								mimeType: "image/png",
								contentHash: "a".repeat(64),
								extension: ".png",
							},
						],
					]) as never,
				},
			}),
		);
		const read = servedReading(source);
		expect(read.outcome.claims.handOffs).not.toEqual([]);
		accepted({
			...acceptanceInput(read.reader, read.outcome),
			settlements: read.outcome.claims.handOffs.map((handOff) => ({
				artifact: handOff.artifact,
				where: handOff.where,
				key: handOff.key,
				by: "inert-claim" as const,
			})),
			mediaLeftOut: read.outcome.claims.handOffs.length,
		});
	});

	it("accepts an app with a Web Apps logo", async () => {
		const logo = testMediaAssetId("logo");
		const path = "jr://file/commcare/logo/data/hq_logo_web_apps.png";
		const doc = { ...SHAPES, logo };
		const source = await sourceFromBody(
			exportedBody(doc, {
				expand: { attachmentTarget: { origin: HOST, domain: DOMAIN } },
				root: { logo_refs: { hq_logo_web_apps: { path, m_id: "logo-file" } } },
			}),
		);
		const media = {
			resolve: (asked: string) =>
				asked === path
					? {
							kind: "asset" as const,
							assetId: logo,
							mediaKind: "image" as const,
						}
					: { kind: "no-entry" as const },
		};
		const read = servedReading(source, { media }, [
			{
				hqPath: path,
				assetId: logo,
				contentHash: "b".repeat(64),
				extension: ".png",
			},
		]);
		expect(read.outcome.draft.doc.logo).toBe(logo);
		accepted({
			...acceptanceInput(read.reader, read.outcome),
			media: {
				files: [
					{
						hqPath: path,
						assetId: logo,
						contentHash: "b".repeat(64),
						extension: ".png",
					},
				],
				rows: new Map([
					[
						logo,
						{
							id: logo,
							project_id: "",
							owner: "",
							contentHash: "b".repeat(64),
							mimeType: "image/png",
							extension: ".png",
							sizeBytes: 64,
							mediaFormat: "png",
							kind: "image",
							gcsObjectKey: "",
							originalFilename: "logo.png",
							status: "ready",
							created_at: new Date(0),
						},
					],
				]),
			},
		});
	});

	it("accepts a date and time saved in the spelling Nova wrote before, and declares the new one", async () => {
		const doc = buildDoc({
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: proseText("Name") },
						{ name: "seen_at", label: proseText("Seen") },
					],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							name: "Register",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "name",
									caseWrite: { caseType: "patient", property: "case_name" },
								}),
								f({
									kind: "datetime",
									id: "seen",
									caseWrite: { caseType: "patient", property: "seen_at" },
								}),
							],
						},
					],
				},
			],
		});
		const earlier = serializeWire(
			typedInstantValue(FormPath.root().child("seen").toWire()),
			{ target: "xform", constraint: false },
		).text;
		const answer = await servedAccepted(doc, (xml) =>
			editXml(xml, (root) => {
				const bind = findElement(
					root,
					(element) =>
						element.name === "bind" &&
						(element.attribs.nodeset ?? "").endsWith("/nova_datetime_seen"),
				);
				if (bind === undefined) throw new Error("No date and time sibling.");
				bind.attribs.calculate = earlier;
			}),
		);
		expect(answer.firstPublish.ids).toContain(
			"date-and-time-saved-as-hq-stores-it",
		);
	});
});
