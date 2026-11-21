/**
 * Connect blocks (15). The four blocks the emitter writes read back into the
 * form's Connect slots, each calculate registered for the expression stage;
 * every refusal row is held by a hand-written source, each with the one
 * finding its row names; and an app whose forms hold learn and deliver blocks
 * is the one finding at the app, its document taking the first block's kind.
 *
 * The emitted learn and deliver apps also read whole with no finding at all,
 * so a wrapper or a leaf bind left unclaimed, or a shadow that disagrees on a
 * block's bind, cannot hide behind a filter of Connect's own codes.
 *
 * Plausible failures: a deliver unit beside a task held; an app of both kinds
 * read as `unrecognized`; a learn module whose description holds
 * `instance('casedb')` read to anything but the one finding
 * `connect-block-text-read-as-an-instance`; a block of the wrong shape held.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc } from "@/lib/domain";
import type { Expression } from "@/lib/domain/expression/types";
import type { Finding } from "@/lib/publish/hqFindings";
import {
	DEFAULT_ASSESSMENT_USER_SCORE_EXPRESSION,
	DEFAULT_DELIVER_ENTITY_ID_EXPRESSION,
	DEFAULT_DELIVER_ENTITY_NAME_EXPRESSION,
} from "../../../connectDefaults";
import { buildConnectSlugMap } from "../../../connectSlugs";
import { buildXForm } from "../../../xform/builder";
import { exportedBody, inputFor } from "../../__tests__/novaExport";
import {
	closeAfterStructure,
	readContext,
	readerInput,
	retainedSourceBody,
	sourceFromBody,
} from "../../__tests__/readerInput";
import { readApplication } from "../../appShell";
import type { DraftForm, ReadContext } from "../../context";
import { readHqApp } from "../../index";
import { readStructure } from "../../structure";
import { connectDefaultsUnset } from "../afterBinding";
import { readForms } from "../index";
import { XMLNS, xformSource } from "./formReading";

const Q = (id: string) => `questions/${id}`;

/** Reads an app of one menu whose forms' sources are given whole, each under its own xmlns. */
async function readApp(sources: readonly string[]): Promise<{
	readonly ctx: ReadContext;
	readonly forms: readonly DraftForm[];
	readonly findings: readonly Finding[];
}> {
	const xmlns = (index: number) => `${XMLNS}-${index}`;
	const body = {
		...retainedSourceBody("shell/app-source"),
		modules: [
			{
				doc_type: "Module",
				unique_id: "m-reader",
				name: { en: "Menu" },
				case_type: "",
				forms: sources.map((_, index) => ({
					doc_type: "Form",
					unique_id: `r${index}`,
					xmlns: xmlns(index),
					name: { en: `Form ${index}` },
				})),
			},
		],
		_attachments: Object.fromEntries(
			sources.map((source, index) => [
				`r${index}.xml`,
				source.replace(`xmlns="${XMLNS}"`, `xmlns="${xmlns(index)}"`),
			]),
		),
	};
	const ctx = readContext(readerInput(await sourceFromBody(body)));
	readApplication(ctx);
	readStructure(ctx);
	readForms(ctx);
	const forms = ctx.draft.modules[0]?.forms ?? [];
	return { ctx, forms, findings: closeAfterStructure(ctx).findings };
}

const connectCodes = (findings: readonly Finding[]) =>
	findings
		.map((finding) => finding.code)
		.filter((code) => code.includes("connect") || code.includes("question-id"));

// ── Hand-written blocks, in the shapes `buildConnectBlocks` writes ──────────

const CONNECT = 'xmlns="http://commcareconnect.com/data/v1/learn"';

const learnModule = (
	id: string,
	options: {
		name?: string;
		description?: string;
		estimate?: string;
		path?: string;
	} = {},
) => ({
	data: `<${id} vellum:role="ConnectLearnModule"><module ${CONNECT} id="${id}"><name>${options.name ?? "Module"}</name><description>${options.description ?? "About"}</description><time_estimate>${options.estimate ?? "2"}</time_estimate></module></${id}>`,
	binds: `<bind nodeset="${options.path ?? `/data/${id}`}" vellum:nodeset="#form/${(options.path ?? `/data/${id}`).slice("/data/".length)}"/>`,
});

const assessment = (id: string, path = `/data/${id}`) => ({
	data: `<${id} vellum:role="ConnectAssessment"><assessment ${CONNECT} id="${id}"><user_score/></assessment></${id}>`,
	binds: `<bind nodeset="${path}"/><bind nodeset="${path}/assessment/user_score" calculate="100"/>`,
});

const deliverUnit = (
	id: string,
	options: {
		entityCalculate?: boolean;
		workArea?: string;
		/** Text written into the `work_area_id` leaf, a fixed id. */
		workAreaText?: string;
		relevant?: string;
		name?: string;
		path?: string;
	} = {},
) => {
	const path = options.path ?? `/data/${id}`;
	const workArea =
		options.workAreaText === undefined
			? "<work_area_id/>"
			: `<work_area_id>${options.workAreaText}</work_area_id>`;
	return {
		data: `<${id} vellum:role="ConnectDeliverUnit"><deliver ${CONNECT} id="${id}"><name>${options.name ?? "Visit"}</name><entity_id/><entity_name/>${workArea}</deliver></${id}>`,
		binds: [
			`<bind nodeset="${path}"${options.relevant === undefined ? "" : ` relevant="${options.relevant}"`}/>`,
			`<bind nodeset="${path}/deliver/entity_id"${options.entityCalculate === false ? "" : ' calculate="/data/q"'}/>`,
			`<bind nodeset="${path}/deliver/entity_name" calculate="/data/q"/>`,
			`<bind nodeset="${path}/deliver/work_area_id"${options.workArea === undefined ? "" : ` calculate="${options.workArea}"`}/>`,
		].join(""),
	};
};

const task = (
	id: string,
	options: { name?: string; description?: string; path?: string } = {},
) => ({
	data: `<${id} vellum:role="ConnectTask"><task ${CONNECT} id="${id}"><name>${options.name ?? "Task"}</name><description>${options.description ?? "Do it"}</description></task></${id}>`,
	binds: `<bind nodeset="${options.path ?? `/data/${id}`}"/>`,
});

/** A form whose one block stands inside a group or a repeat of the root. */
const nested = (
	container: "group" | "repeat",
	block: { data: string; binds: string },
) =>
	xformSource({
		data: `<q/><rows${container === "repeat" ? ' jr:template=""' : ""}><answer/>${block.data}</rows>`,
		model: `<bind nodeset="/data/q" type="xsd:string"/><bind nodeset="/data/rows/answer" type="xsd:string"/>${block.binds}`,
		body:
			container === "repeat"
				? '<input ref="/data/q"/><group><repeat nodeset="/data/rows"><input ref="/data/rows/answer"/></repeat></group>'
				: '<input ref="/data/q"/><group ref="/data/rows"><input ref="/data/rows/answer"/></group>',
	});

const withBlocks = (...blocks: { data: string; binds: string }[]) =>
	xformSource({
		data: `<q/>${blocks.map((block) => block.data).join("")}`,
		model: `<bind nodeset="/data/q" type="xsd:string"/>${blocks.map((block) => block.binds).join("")}`,
		body: '<input ref="/data/q"/>',
	});

describe("the four blocks the emitter writes", () => {
	it("read back into a learn form's slots, each calculate registered", async () => {
		const doc = buildDoc({
			connectType: "learn",
			modules: [
				{
					name: "Learn",
					forms: [
						{
							name: "Lesson",
							type: "survey",
							connect: {
								learn_module: {
									id: "lesson_one",
									name: "Lesson one",
									description: "The first lesson",
									time_estimate: 3,
								},
								assessment: { id: "lesson_quiz" },
							},
							fields: [f({ kind: "int", id: "score" })],
						},
					],
				},
			],
		});
		const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
		const source = buildXForm(doc, formUuid, {
			xmlns: XMLNS,
			connect: buildConnectSlugMap(doc).get(formUuid),
		});
		const { ctx, forms, findings } = await readApp([source]);
		expect(connectCodes(findings)).toEqual([]);
		// Read whole, every stage claims its share of the form: no finding of any kind.
		const whole = readHqApp(await inputFor(exportedBody(doc)));
		expect(whole.kind === "account" ? whole.findings : []).toEqual([]);
		expect(whole.kind).toBe("read");
		expect(ctx.draft.connectType).toBe("learn");
		const form = forms[0];
		expect(
			form?.xform?.connectBlocks.map((block) => [block.block, block.id]),
		).toEqual([
			["learn_module", "lesson_one"],
			["assessment", "lesson_quiz"],
		]);
		expect(form?.form.connect).toMatchObject({
			learn_module: {
				id: "lesson_one",
				name: "Lesson one",
				description: "The first lesson",
				time_estimate: 3,
			},
			assessment: { id: "lesson_quiz" },
		});
		expect(
			ctx.pending
				.list()
				.map((one) => [one.ref.entity, "slot" in one.ref ? one.ref.slot : ""]),
		).toContainEqual(["form", "assessment_user_score"]);
	});

	it("read back into a deliver form's slots, and a task into its own form's", async () => {
		const doc = buildDoc({
			connectType: "deliver",
			modules: [
				{
					name: "Deliver",
					forms: [
						{
							name: "Visit",
							type: "survey",
							connect: { deliver_unit: { id: "visit", name: "Visit" } },
							fields: [f({ kind: "text", id: "who" })],
						},
						{
							name: "Follow up",
							type: "survey",
							connect: {
								task: { id: "follow", name: "Follow up", description: "Again" },
							},
							fields: [f({ kind: "text", id: "how" })],
						},
					],
				},
			],
		});
		const slugs = buildConnectSlugMap(doc);
		const sources = doc.formOrder[doc.moduleOrder[0]].map((formUuid) =>
			buildXForm(doc, formUuid, { xmlns: XMLNS, connect: slugs.get(formUuid) }),
		);
		const { ctx, forms, findings } = await readApp(sources);
		expect(connectCodes(findings)).toEqual([]);
		const whole = readHqApp(await inputFor(exportedBody(doc)));
		expect(whole.kind === "account" ? whole.findings : []).toEqual([]);
		expect(whole.kind).toBe("read");
		expect(ctx.draft.connectType).toBe("deliver");
		expect(forms[0]?.form.connect).toMatchObject({
			deliver_unit: { id: "visit", name: "Visit" },
		});
		expect(forms[1]?.form.connect).toEqual({
			task: { id: "follow", name: "Follow up", description: "Again" },
		});
		const slots = ctx.pending
			.list()
			.map((one) => ("slot" in one.ref ? one.ref.slot : ""))
			.filter((slot) => slot.startsWith("deliver_"));
		expect(slots).toEqual(["deliver_entity_id", "deliver_entity_name"]);
	});
});

describe("a slot the emitter fills from its default", () => {
	/** Each form's Connect config, in menu and form order. */
	const connectsOf = (doc: BlueprintDoc): unknown[] =>
		doc.moduleOrder.flatMap((moduleUuid) =>
			(doc.formOrder[moduleUuid] ?? []).map(
				(formUuid) => doc.forms[formUuid]?.connect,
			),
		);

	/** The Connect config of each form of a whole reading of the document's export, held to the
	 *  document with its defaults unset: that document prints the same bytes, and the reading
	 *  returns its member. */
	async function readConnect(doc: BlueprintDoc): Promise<unknown[]> {
		const unset = connectDefaultsUnset(doc);
		expect(JSON.stringify(exportedBody(unset))).toBe(
			JSON.stringify(exportedBody(doc)),
		);
		expect(connectDefaultsUnset(unset)).toBe(unset);
		const outcome = readHqApp(await inputFor(exportedBody(doc)));
		expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
		if (outcome.kind !== "read") throw new Error("The export did not read.");
		const read = connectsOf(outcome.draft.doc);
		expect(read).toEqual(connectsOf(unset));
		return read;
	}

	it("reads unset where the document left it unset or wrote the default, and keeps an authored value", async () => {
		const score = (value: number): Expression => ({
			kind: "term",
			term: { kind: "literal", value },
		});
		const learn = (id: string, userScore: Expression | undefined) => ({
			name: "Lesson",
			type: "survey" as const,
			connect: {
				assessment: {
					id,
					...(userScore !== undefined && { user_score: userScore }),
				},
			},
			fields: [f({ kind: "int", id: "points" })],
		});
		const learnDoc = buildDoc({
			connectType: "learn",
			modules: [
				{
					name: "Learn",
					forms: [
						learn("quiz_one", undefined),
						learn("quiz_two", DEFAULT_ASSESSMENT_USER_SCORE_EXPRESSION),
						learn("quiz_three", score(80)),
					],
				},
			],
		});
		const [unset, defaulted, authored] = (await readConnect(
			learnDoc,
		)) as Record<string, Record<string, unknown>>[];
		expect(unset?.assessment).toEqual({ id: "quiz_one" });
		expect(defaulted?.assessment).toEqual({ id: "quiz_two" });
		expect(authored?.assessment).toEqual({
			id: "quiz_three",
			user_score: score(80),
		});

		const shown: Expression = {
			kind: "term",
			term: { kind: "literal", value: "Visit" },
		};
		const deliver = (
			id: string,
			entities: { entity_id?: Expression; entity_name?: Expression } = {},
		) => ({
			name: "Visit",
			type: "survey" as const,
			connect: { deliver_unit: { id, name: "Visit", ...entities } },
			fields: [f({ kind: "text", id: "who" })],
		});
		const deliverDoc = buildDoc({
			connectType: "deliver",
			modules: [
				{ name: "One", forms: [deliver("visit_one")] },
				{
					name: "Two",
					forms: [
						deliver("visit_two", {
							entity_id: DEFAULT_DELIVER_ENTITY_ID_EXPRESSION,
							entity_name: DEFAULT_DELIVER_ENTITY_NAME_EXPRESSION,
						}),
					],
				},
				{
					name: "Three",
					forms: [
						deliver("visit_three", {
							entity_id: DEFAULT_DELIVER_ENTITY_ID_EXPRESSION,
							entity_name: shown,
						}),
					],
				},
			],
		});
		const delivered = (await readConnect(deliverDoc)) as Record<
			string,
			Record<string, unknown>
		>[];
		expect(delivered.map((connect) => connect?.deliver_unit)).toEqual([
			{ id: "visit_one", name: "Visit" },
			{ id: "visit_two", name: "Visit" },
			{ id: "visit_three", name: "Visit", entity_name: shown },
		]);
	});
});

describe("each refusal row", () => {
	const cases: readonly [string, string, string][] = [
		[
			"a learn module id over 50 characters",
			withBlocks(learnModule(`m${"x".repeat(50)}`)),
			Q("a-connect-learn-module-or-task-id-longer-than-50-characters-or"),
		],
		[
			"a deliver unit id over 100 characters",
			withBlocks(deliverUnit(`d${"x".repeat(100)}`)),
			Q("a-connect-learn-module-or-task-id-longer-than-50-characters-or"),
		],
		[
			"a deliver unit id of 51 to 100 characters",
			withBlocks(deliverUnit(`d${"x".repeat(60)}`)),
			Q("connect-blocks-beyond-one-of-each-kind"),
		],
		[
			"an id the question id grammar refuses",
			withBlocks(learnModule("XMLmodule")),
			Q("question-id-failing-the-grammar-or-meta-in-any-case"),
		],
		[
			"two assessments",
			withBlocks(assessment("quiz_a"), assessment("quiz_b")),
			Q("several-connect-assessment-blocks-in-one-form-or-one-inside-a"),
		],
		[
			"two learn modules",
			withBlocks(learnModule("first"), learnModule("second")),
			Q("connect-blocks-beyond-one-of-each-kind"),
		],
		[
			"a task id over 50 characters",
			withBlocks(task(`t${"x".repeat(50)}`)),
			Q("a-connect-learn-module-or-task-id-longer-than-50-characters-or"),
		],
		[
			"an assessment id of 51 to 100 characters",
			withBlocks(assessment(`a${"x".repeat(60)}`)),
			Q("connect-blocks-beyond-one-of-each-kind"),
		],
		[
			"a time estimate of 0",
			withBlocks(learnModule("lesson", { estimate: "0" })),
			Q("connect-blocks-beyond-one-of-each-kind"),
		],
		[
			"a time estimate that is no whole number",
			withBlocks(learnModule("lesson", { estimate: "2.5" })),
			Q("connect-blocks-beyond-one-of-each-kind"),
		],
		[
			"a learn module inside a group",
			nested("group", learnModule("lesson", { path: "/data/rows/lesson" })),
			Q("connect-blocks-beyond-one-of-each-kind"),
		],
		[
			"a learn module inside a repeat",
			nested("repeat", learnModule("lesson", { path: "/data/rows/lesson" })),
			Q("connect-blocks-beyond-one-of-each-kind"),
		],
		[
			"a deliver unit inside a group",
			nested("group", deliverUnit("visit", { path: "/data/rows/visit" })),
			Q("connect-blocks-beyond-one-of-each-kind"),
		],
		[
			"a deliver unit inside a repeat",
			nested("repeat", deliverUnit("visit", { path: "/data/rows/visit" })),
			Q("connect-blocks-beyond-one-of-each-kind"),
		],
		[
			"a task inside a group",
			nested("group", task("follow", { path: "/data/rows/follow" })),
			Q("connect-blocks-beyond-one-of-each-kind"),
		],
		[
			"a task inside a repeat",
			nested("repeat", task("follow", { path: "/data/rows/follow" })),
			Q("connect-blocks-beyond-one-of-each-kind"),
		],
		[
			"an assessment inside a group",
			nested("group", assessment("quiz", "/data/rows/quiz")),
			Q("connect-blocks-beyond-one-of-each-kind"),
		],
		[
			"a condition on a block",
			withBlocks(deliverUnit("visit", { relevant: "/data/q = 'x'" })),
			Q("connect-blocks-beyond-one-of-each-kind"),
		],
		[
			"an entity id with no calculate",
			withBlocks(deliverUnit("visit", { entityCalculate: false })),
			Q("connect-blocks-beyond-one-of-each-kind"),
		],
		[
			"a work area id expression",
			withBlocks(deliverUnit("visit", { workArea: "/data/q" })),
			Q("connect-deliver-unit-work-area-id-expression"),
		],
		[
			"a fixed work area id, which Connect files the visit under",
			withBlocks(
				deliverUnit("visit", {
					workAreaText: "3f2c0c1e-9a4b-4c8e-8d2f-5b7a1e6c9d01",
				}),
			),
			Q("connect-deliver-unit-work-area-id-expression"),
		],
		[
			"a deliver unit and a task in one form",
			withBlocks(deliverUnit("visit"), task("follow")),
			Q("connect-deliver-unit-and-task-in-one-form"),
		],
		[
			"a work area update",
			withBlocks({
				data: `<area vellum:role="ConnectWorkAreaUpdate"><work_area ${CONNECT} id="area"/></area>`,
				binds: "",
			}),
			Q("connect-work-area-update"),
		],
	];
	it.each(cases)("refuses %s", async (_, source, entry) => {
		const { findings } = await readApp([source]);
		expect(connectCodes(findings)).toEqual([entry]);
	});

	it("refuses two assessments whole, each bind's calculate under the one finding", async () => {
		const { findings } = await readApp([
			withBlocks(assessment("quiz_a"), assessment("quiz_b")),
		]);
		// The form's own places: the menu's keys are a later stage's, which this reading stops before.
		expect(
			findings
				.filter(
					(finding) =>
						finding.place.kind === "form" || finding.place.kind === "question",
				)
				.map((finding) => [finding.code, finding.detail.name]),
		).toEqual([
			[
				Q("several-connect-assessment-blocks-in-one-form-or-one-inside-a"),
				undefined,
			],
		]);
	});

	it("refuses an assessment inside a repeat", async () => {
		const block = assessment("quiz", "/data/rows/quiz");
		const source = xformSource({
			data: `<rows jr:template=""><answer/>${block.data}</rows>`,
			model: `<bind nodeset="/data/rows/answer" type="xsd:string"/>${block.binds}`,
			body: '<group><repeat nodeset="/data/rows"><input ref="/data/rows/answer"/></repeat></group>',
		});
		const { findings } = await readApp([source]);
		expect(connectCodes(findings)).toContain(
			Q("several-connect-assessment-blocks-in-one-form-or-one-inside-a"),
		);
	});

	it("reads a learn module whose description holds instance('casedb') to the one finding", async () => {
		const { forms, findings } = await readApp([
			withBlocks(
				learnModule("lesson", { description: "See instance('casedb') first" }),
			),
		]);
		expect(connectCodes(findings)).toEqual([
			Q("connect-block-text-read-as-an-instance"),
		]);
		expect(
			findings.find((finding) => finding.code.endsWith("as-an-instance"))
				?.detail.name,
		).toBe("instance('casedb')");
		expect(
			findings.filter(
				(finding) =>
					finding.code === "unrecognized" && finding.place.kind === "form",
			),
		).toEqual([]);
		expect(forms[0]?.xform?.connectBlocks.map((block) => block.id)).toEqual([
			"lesson",
		]);
	});

	it.each([
		[
			"a learn module's name",
			learnModule("lesson", { name: "See instance('casedb') first" }),
		],
		["a task's name", task("follow", { name: "See instance('casedb') first" })],
		[
			"a task's description",
			task("follow", { description: "See instance('casedb') first" }),
		],
		[
			"a deliver unit's name",
			deliverUnit("visit", { name: "See instance('casedb') first" }),
		],
	])(
		"reads %s holding instance('casedb') to the one finding",
		async (_, block) => {
			const { forms, findings } = await readApp([withBlocks(block)]);
			expect(connectCodes(findings)).toEqual([
				Q("connect-block-text-read-as-an-instance"),
			]);
			expect(
				findings.find((finding) => finding.code.endsWith("as-an-instance"))
					?.detail.name,
			).toBe("instance('casedb')");
			// A deliver unit's calculates are the expression stage's, which this reading stops before.
			expect(
				findings.filter(
					(finding) =>
						finding.code === "unrecognized" &&
						finding.place.kind === "form" &&
						finding.detail.name !== "xform:bind@calculate",
				),
			).toEqual([]);
			expect(forms[0]?.xform?.connectBlocks).toHaveLength(1);
		},
	);

	it("refuses a fixed work area id whole, with no deliver unit held and nothing left unclaimed", async () => {
		const { forms, findings } = await readApp([
			withBlocks(
				deliverUnit("visit", {
					workAreaText: "3f2c0c1e-9a4b-4c8e-8d2f-5b7a1e6c9d01",
				}),
			),
		]);
		// The form's own places: the menu's keys are a later stage's, which this reading stops before.
		expect(
			findings
				.filter(
					(finding) =>
						finding.place.kind === "form" || finding.place.kind === "question",
				)
				.map((finding) => finding.code),
		).toEqual([Q("connect-deliver-unit-work-area-id-expression")]);
		expect(forms[0]?.xform?.connectBlocks).toEqual([]);
	});

	// The block the emitter writes for the slots read is held only where it is the stored block
	// whole: anything else the stored block holds is left unclaimed, whatever the slots read.
	it.each([
		[
			"an attribute on a leaf",
			(data: string) => data.replace("<name>", '<name lang="fr">'),
		],
		[
			"an attribute on the wrapper",
			(data: string) =>
				data.replace(
					'vellum:role="ConnectDeliverUnit"',
					'vellum:role="ConnectDeliverUnit" note="kept"',
				),
		],
		[
			"text under a calculated leaf",
			(data: string) =>
				data.replace("<entity_id/>", "<entity_id>fixed</entity_id>"),
		],
	])("leaves a deliver unit holding %s unclaimed", async (_, edit) => {
		const block = deliverUnit("visit");
		const { forms, findings } = await readApp([
			withBlocks({ ...block, data: edit(block.data) }),
		]);
		expect(findings.map((finding) => finding.code)).toContain("unrecognized");
		expect(forms[0]?.xform?.connectBlocks).toEqual([]);
	});

	it("leaves a block whose wrapper is not named for its id unclaimed", async () => {
		const block = learnModule("lesson");
		const { findings } = await readApp([
			withBlocks({
				...block,
				data: block.data.replace('id="lesson"', 'id="other"'),
			}),
		]);
		expect(findings.map((finding) => finding.code)).toContain("unrecognized");
	});
});

describe("an app of both kinds", () => {
	it("is the one finding at the app, its document taking the first block's kind", async () => {
		const { ctx, forms, findings } = await readApp([
			withBlocks(learnModule("lesson")),
			withBlocks(deliverUnit("visit")),
		]);
		expect(
			findings
				.filter((finding) => finding.code.includes("connect"))
				.map((finding) => [finding.code, finding.place.kind]),
		).toEqual([[Q("connect-learn-and-deliver-blocks-in-one-app"), "app"]]);
		expect(
			findings.filter(
				(finding) =>
					finding.code === "unrecognized" &&
					(finding.place.kind === "form" || finding.place.kind === "app"),
			),
		).toEqual([]);
		expect(ctx.draft.connectType).toBe("learn");
		expect(forms[0]?.form.connect).toMatchObject({
			learn_module: { id: "lesson" },
		});
		expect(forms[1]?.form.connect).toBeUndefined();
	});
});
