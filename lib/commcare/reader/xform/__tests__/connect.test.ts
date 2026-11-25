/** Read the actual activity XML at its authored position. The block reader owns
 * the editor shape. Only bound expressions can establish receiver collisions. */
import { describe, expect, it } from "vitest";
import type { Finding } from "@/lib/publish/hqFindings";
import { inputFor } from "../../__tests__/novaExport";
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
import { readForms } from "../index";
import { XMLNS, xformSource } from "./formReading";

const Q = (id: string) => `questions/${id}`;

/** Reads an app of one menu whose forms' sources are given whole, each under its own xmlns. */
function appBody(sources: readonly string[]) {
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
	return body;
}

async function readApp(sources: readonly string[]): Promise<{
	readonly ctx: ReadContext;
	readonly forms: readonly DraftForm[];
	readonly findings: readonly Finding[];
}> {
	const ctx = readContext(readerInput(await sourceFromBody(appBody(sources))));
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

describe("readable activity shapes", () => {
	it("keeps the four positioned activities and their original IDs across three forms", async () => {
		const { ctx, forms, findings } = await readApp([
			withBlocks(learnModule("lesson"), assessment("quiz")),
			withBlocks(deliverUnit("visit")),
			withBlocks(task("follow")),
		]);
		expect(connectCodes(findings)).toEqual([]);
		expect(ctx.draft.connectRoles).toEqual(["learn", "deliver"]);
		expect(
			forms.map((form) =>
				form.xform?.connectBlocks.map(({ block, id }) => [block, id]),
			),
		).toEqual([
			[
				["learn_module", "lesson"],
				["assessment", "quiz"],
			],
			[["deliver_unit", "visit"]],
			[["task", "follow"]],
		]);
	});
});

describe("each refusal row", () => {
	const cases: readonly [string, string, string][] = [
		[
			"a fixed work area id, which a form editor save would clear",
			withBlocks(
				deliverUnit("visit", {
					workAreaText: "3f2c0c1e-9a4b-4c8e-8d2f-5b7a1e6c9d01",
				}),
			),
			Q("connect-value-that-the-editor-clears"),
		],
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
			"an id the question id grammar refuses",
			withBlocks(learnModule("XMLmodule")),
			Q("question-id-failing-the-grammar-or-meta-in-any-case"),
		],
		[
			"a task id over 50 characters",
			withBlocks(task(`t${"x".repeat(50)}`)),
			Q("a-connect-learn-module-or-task-id-longer-than-50-characters-or"),
		],
		[
			"a time estimate that is no whole number",
			withBlocks(learnModule("lesson", { estimate: "2.5" })),
			Q("connect-estimate-outside-receiver-range"),
		],
		[
			"a Vellum work area update whose photo the HQ forwarder drops",
			withBlocks({
				data: `<area vellum:role="ConnectWorkAreaUpdate"><work_area_update ${CONNECT} id="area"><work_area_id/><status/><reason/><additional_details/><photo_evidence/></work_area_update></area>`,
				binds: `<bind nodeset="/data/area"/>${["work_area_id", "status", "reason", "additional_details", "photo_evidence"].map((leaf) => `<bind nodeset="/data/area/work_area_update/${leaf}" calculate="'value'"/>`).join("")}`,
			}),
			Q("connect-work-area-update-photo-not-forwarded"),
		],
		[
			"an assessment whose score has no calculation",
			withBlocks({
				...assessment("quiz"),
				binds: assessment("quiz").binds.replace(' calculate="100"', ""),
			}),
			Q("connect-assessment-without-score"),
		],
		[
			"a lesson whose hours exceed Connect's storage",
			withBlocks(learnModule("lesson", { estimate: "2147483648" })),
			Q("connect-estimate-outside-receiver-range"),
		],
		[
			"a work area request whose photo uses a different namespace than the one Vellum writes",
			withBlocks({
				data: `<area vellum:role="ConnectWorkAreaUpdate"><work_area_update ${CONNECT} id="area"><work_area_id/><status/><reason/><additional_details/><photo_evidence xmlns="urn:other"/></work_area_update></area>`,
				binds: '<bind nodeset="/data/area"/>',
			}),
			Q("connect-work-area-update"),
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

	const shapes: readonly [string, string][] = [
		[
			"a fixed ID expressed by the work area calculation",
			withBlocks(
				deliverUnit("visit", {
					workArea: "'3f2c0c1e-9a4b-4c8e-8d2f-5b7a1e6c9d01'",
				}),
			),
		],

		[
			"a deliver unit id of 51 to 100 characters",
			withBlocks(deliverUnit(`d${"x".repeat(60)}`)),
		],
		["two assessments", withBlocks(assessment("quiz_a"), assessment("quiz_b"))],
		[
			"two learn modules",
			withBlocks(learnModule("first"), learnModule("second")),
		],
		[
			"an assessment id of 51 to 100 characters",
			withBlocks(assessment(`a${"x".repeat(60)}`)),
		],
		[
			"a time estimate of 0",
			withBlocks(learnModule("lesson", { estimate: "0" })),
		],
		[
			"a learn module inside a group",
			nested("group", learnModule("lesson", { path: "/data/rows/lesson" })),
		],
		[
			"a learn module inside a repeat",
			nested("repeat", learnModule("lesson", { path: "/data/rows/lesson" })),
		],
		[
			"a deliver unit inside a group",
			nested("group", deliverUnit("visit", { path: "/data/rows/visit" })),
		],
		[
			"a deliver unit inside a repeat",
			nested("repeat", deliverUnit("visit", { path: "/data/rows/visit" })),
		],
		[
			"a task inside a group",
			nested("group", task("follow", { path: "/data/rows/follow" })),
		],
		[
			"a task inside a repeat",
			nested("repeat", task("follow", { path: "/data/rows/follow" })),
		],
		[
			"an assessment inside a group",
			nested("group", assessment("quiz", "/data/rows/quiz")),
		],
		[
			"a condition on a block",
			withBlocks(deliverUnit("visit", { relevant: "/data/q = 'x'" })),
		],
		[
			"an entity id with no calculate",
			withBlocks(deliverUnit("visit", { entityCalculate: false })),
		],
		[
			"a work area id expression",
			withBlocks(deliverUnit("visit", { workArea: "/data/q" })),
		],
		[
			"a deliver unit and a task in one form",
			withBlocks(deliverUnit("visit"), task("follow")),
		],
	];
	it.each(shapes)(
		"reads the editor shape for %s before resolving row multiplicity",
		async (_, source) => {
			const { forms, findings } = await readApp([source]);
			expect(connectCodes(findings)).toEqual([]);
			expect(forms[0]?.xform?.connectBlocks.length).toBeGreaterThan(0);
		},
	);

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

	it.each([
		[
			"an attribute on a leaf",
			"unrecognized",
			(data: string) => data.replace("<name>", '<name lang="fr">'),
		],
		[
			"an attribute on the wrapper",
			"unrecognized",
			(data: string) =>
				data.replace(
					'vellum:role="ConnectDeliverUnit"',
					'vellum:role="ConnectDeliverUnit" note="kept"',
				),
		],
		[
			"text under a calculated leaf",
			Q("connect-value-that-the-editor-clears"),
			(data: string) =>
				data.replace("<entity_id/>", "<entity_id>fixed</entity_id>"),
		],
	])("leaves a deliver unit holding %s unclaimed", async (_, code, edit) => {
		const block = deliverUnit("visit");
		const { forms, findings } = await readApp([
			withBlocks({ ...block, data: edit(block.data) }),
		]);
		expect(findings.map((finding) => finding.code)).toContain(code);
		expect(forms[0]?.xform?.connectBlocks).toEqual([]);
	});

	it("locates a receiver ID that a form editor save would change", async () => {
		const block = learnModule("lesson");
		const read = readHqApp(
			await inputFor(
				appBody([
					withBlocks({
						...block,
						data: block.data.replace('id="lesson"', 'id="other"'),
					}),
				]),
			),
		);
		expect(read.defects).toEqual([]);
		const findings = read.kind === "account" ? read.findings : [];
		expect(
			findings.filter((finding) => finding.code.includes("connect")),
		).toMatchObject([
			{
				code: Q("connect-unit-id-changed-by-form-editor"),
				place: { kind: "question", path: "lesson" },
				detail: { name: "other" },
			},
		]);
		expect(
			findings.filter((finding) => finding.code === "unrecognized"),
		).toEqual([]);
	});
});

describe("worker submission collisions after expression binding", () => {
	it.each([
		[
			"two assessments",
			withBlocks(assessment("quiz_a"), assessment("quiz_b")),
			"several-connect-assessment-blocks-in-one-form-or-one-inside-a",
		],
		[
			"an assessment in an open repeat",
			nested("repeat", assessment("quiz", "/data/rows/quiz")),
			"several-connect-assessment-blocks-in-one-form-or-one-inside-a",
		],
		[
			"a learning module in an open repeat",
			nested("repeat", learnModule("lesson", { path: "/data/rows/lesson" })),
			"connect-repeats-module-completion-key",
		],
		[
			"a delivery and assigned task",
			withBlocks(deliverUnit("visit"), task("follow")),
			"connect-deliver-unit-and-task-in-one-form",
		],
	] as const)(
		"locates %s in the source question tree",
		async (_, source, entry) => {
			const read = readHqApp(await inputFor(appBody([source])));
			expect(
				read.kind === "account"
					? read.findings.map((finding) => [finding.code, finding.place.kind])
					: [],
			).toContainEqual([Q(entry), "question"]);
		},
	);
});
