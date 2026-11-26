/**
 * The provisional document and the binding of a reading's expressions.
 *
 * Contract: the provisional document is a document the schema admits in a
 * reading that holds findings, with a stand-in where a question got one (a
 * group for a node with children), and no mirror menu, so an expression
 * reading the refused question still binds, and a reading holding a stand-in
 * returns no document; it is deeply frozen,
 * the same object until a draft is written, a new one after. No stage of
 * `STAGES` writes a draft outside `ctx.writeDraft`. The expression stage's
 * answer is applied to the nodes it was read from: each registration's
 * outcome is its bound tree and its slot's own claim, the second run's over
 * the worker information the first found the app reads, an ownerless
 * registration stands under the finding at or above its place or throws,
 * naming the slot, and a table the catalog lacks is listed once, as read or as
 * only declared. One cause is one finding: a read of a table the catalog lacks
 * is handed to project data, a read of an inline instance stands under the
 * instance's refusal, and a read of a Search field's answer or the legacy
 * search input is its instance's one entry.
 *
 * Plausible failures: a stale document served after a draft changed, a
 * stand-in missing so a second false finding appears, a surface use's claim
 * given as the slot's, a tag listed twice, a declaration taken for a read, one
 * read reported twice.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { type BlueprintDoc, blueprintDocSchema } from "@/lib/domain/blueprint";
import { asUuid, type Uuid } from "@/lib/domain/uuid";
import { expandDoc } from "../../expander";
import { inventoryIndex } from "../../surface/inventory";
import type { ReadContext } from "../context";
import { readerDefect } from "../defects";
import { EXPRESSION_CLAIMS } from "../expressions/findings";
import { readHqApp, STAGES } from "../index";
import { pendingPlaceholder } from "../pendingExpressions";
import {
	applyExpressionReading,
	bindExpressions,
	provisionalDocument,
} from "../provisional";
import { X } from "../xform/claims";
import { exportedBody, inputFor, mirrorMenu } from "./novaExport";
import {
	readContext,
	readerInput,
	retainedSourceBody,
	sourceFromBody,
} from "./readerInput";

/** A reading of `doc` as HQ serves Nova's export of it, with `edit` applied to the source of
 *  its one form, run through every stage before the expression stage. */
async function readUpToBinding(
	doc: BlueprintDoc,
	edit: (xml: string) => string = (xml) => xml,
): Promise<ReadContext> {
	const emitted = expandDoc(doc);
	const attachments = Object.fromEntries(
		Object.entries(emitted._attachments as Record<string, string>).map(
			([name, xml]) => [name, edit(xml)],
		),
	);
	const body = JSON.parse(
		JSON.stringify({
			...retainedSourceBody("shell/app-source"),
			modules: emitted.modules,
			_attachments: attachments,
		}),
	);
	const input = readerInput(await sourceFromBody(body));
	const ctx = readContext({ ...input, recordDialect: () => undefined });
	for (const stage of STAGES) {
		if (stage === bindExpressions) break;
		stage(ctx);
	}
	return ctx;
}

function survey(): BlueprintDoc {
	return buildDoc({
		modules: [
			{
				name: "Survey",
				forms: [
					{
						name: "Visit",
						type: "survey",
						fields: [
							f({ kind: "text", id: "q1", label: "First" }),
							f({
								kind: "text",
								id: "q2",
								label: "Second",
								relevant: "#form/q1 = 'x'",
							}),
						],
					},
				],
			},
		],
	});
}

/** Renames the question `q1` to an id a worker's submission reads as a case change, everywhere it is named. */
const refuseQ1 = (xml: string) => xml.replaceAll("q1", "Case");

/** A survey whose group `boxed` holds `q1`, which `q2`'s condition reads, beside a text `q3`. */
function boxed(): BlueprintDoc {
	return buildDoc({
		modules: [
			{
				name: "Survey",
				forms: [
					{
						name: "Visit",
						type: "survey",
						fields: [
							f({
								kind: "group",
								id: "boxed",
								label: "Box",
								children: [f({ kind: "text", id: "q1", label: "First" })],
							}),
							f({
								kind: "text",
								id: "q2",
								label: "Second",
								relevant: "#form/boxed/q1 = 'x'",
							}),
							f({ kind: "text", id: "q3", label: "Third" }),
						],
					},
				],
			},
		],
	});
}

/** Renames the group `boxed` to an id a submission reads as a case change, and binds `q3` as a Long, a kind
 *  Nova refuses. */
function refuseBoxedAndQ3(xml: string): string {
	const renamed = xml.replaceAll("boxed", "Case");
	const at = renamed.indexOf('nodeset="/data/q3"');
	const open = renamed.lastIndexOf("<bind", at);
	const close = renamed.indexOf(">", at);
	if (open < 0 || close < 0) throw new Error("The form binds q3.");
	const bind = renamed.slice(open, close);
	if (!bind.includes('type="xsd:string"'))
		throw new Error("q3 is bound as text.");
	return `${renamed.slice(0, open)}${bind.replace('type="xsd:string"', 'type="xsd:long"')}${renamed.slice(close)}`;
}

/** A reading of `body`, run through every stage before the expression stage. */
async function readBodyUpToBinding(
	body: Record<string, unknown>,
): Promise<ReadContext> {
	const ctx = readContext(await inputFor(body));
	for (const stage of STAGES) {
		if (stage === bindExpressions) break;
		stage(ctx);
	}
	return ctx;
}

describe("the provisional document", () => {
	it("is a document the schema admits, with a stand-in for a refused question", async () => {
		const ctx = await readUpToBinding(survey(), refuseQ1);
		const doc = provisionalDocument(ctx);
		expect(blueprintDocSchema.safeParse(toPersistableDoc(doc)).success).toBe(
			true,
		);
		const standIn = Object.values(doc.fields).find(
			(field) => field.id === "Case",
		);
		expect(standIn?.kind).toBe("hidden");
		bindExpressions(ctx);
		const pending = ctx.pending.list();
		const relevant = pending.findIndex((one) => one.ref.slot === "relevant");
		expect(relevant).toBeGreaterThanOrEqual(0);
		expect(ctx.pending.outcome(relevant).expression).toBeDefined();
	});

	it("holds no mirror menu, a stand-in group for a refused node with children and a stand-in for a refused control, and is never returned", async () => {
		const doc = boxed();
		const body = exportedBody(doc, {
			xml: refuseBoxedAndQ3,
			modules: (modules) => [
				...modules,
				mirrorMenu(String(modules[0]?.unique_id)),
			],
		});
		const ctx = await readBodyUpToBinding(body);
		const provisional = provisionalDocument(ctx);
		expect(
			blueprintDocSchema.safeParse(toPersistableDoc(provisional)).success,
		).toBe(true);
		expect(provisional.moduleOrder).toHaveLength(1);
		const byId = (id: string) =>
			Object.values(provisional.fields).find((field) => field.id === id);
		const group = byId("Case");
		expect(group?.kind).toBe("group");
		expect(
			provisional.fieldOrder[group?.uuid as Uuid]?.map(
				(uuid) => provisional.fields[uuid]?.id,
			),
		).toEqual(["q1"]);
		expect(byId("q3")?.kind).toBe("hidden");
		bindExpressions(ctx);
		const pending = ctx.pending.list();
		const relevant = pending.findIndex((one) => one.ref.slot === "relevant");
		expect(relevant).toBeGreaterThanOrEqual(0);
		expect(ctx.pending.outcome(relevant).expression).toBeDefined();

		const outcome = readHqApp(await inputFor(body));
		expect(outcome.kind).toBe("account");
		if (outcome.kind !== "account") return;
		const places = outcome.findings.map((finding) => finding.place);
		expect(places).toContainEqual(
			expect.objectContaining({ kind: "question", path: "Case" }),
		);
		expect(places).toContainEqual(
			expect.objectContaining({ kind: "question", path: "q3" }),
		);
		expect(places).toContainEqual(
			expect.objectContaining({ kind: "menu", menu: 1 }),
		);
	});

	it("is frozen, and the same object until a draft is written", async () => {
		const ctx = await readUpToBinding(survey());
		const doc = provisionalDocument(ctx);
		expect(Object.isFrozen(doc)).toBe(true);
		expect(Object.isFrozen(doc.fields)).toBe(true);
		expect(provisionalDocument(ctx)).toBe(doc);
		ctx.writeDraft(() => {});
		expect(provisionalDocument(ctx)).not.toBe(doc);
	});
});

/** The drafts as JSON, without the cursors and parsed sources they point at. */
function fingerprint(ctx: ReadContext): string {
	const { draft } = ctx;
	return JSON.stringify({
		appName: draft.appName === undefined,
		localization: draft.localization,
		appSettings: draft.appSettings,
		logo: draft.logo,
		levels: draft.levels,
		connectRoles: draft.connectRoles,
		userProperties: draft.userProperties,
		locationProperties: draft.locationProperties,
		caseTypes: draft.caseTypes,
		modules: draft.modules.map((module) => ({
			module: module.module,
			forms: module.forms.map((form) => {
				const xform = form.xform;
				const fields: unknown[] = [];
				const walk = (
					parent: Parameters<NonNullable<typeof xform>["childrenOf"]>[0],
				) => {
					if (xform === null) return;
					for (const field of xform.childrenOf(parent)) {
						fields.push([field.kind, field.id, field.uuid, field.field]);
						walk(field);
					}
				};
				walk(null);
				return { form: form.form, read: xform !== null, fields };
			}),
		})),
	});
}

describe("the stages", () => {
	it("change a draft only inside writeDraft", async () => {
		const body = retainedSourceBody("navigation-base/app-source");
		const input = readerInput(await sourceFromBody(body));
		const ctx = readContext({ ...input, recordDialect: () => undefined });
		const write = ctx.writeDraft.bind(ctx);
		let last = fingerprint(ctx);
		const outside: string[] = [];
		let stageName = "";
		ctx.writeDraft = (change) => {
			if (fingerprint(ctx) !== last) outside.push(stageName);
			write(change);
			last = fingerprint(ctx);
		};
		STAGES.forEach((stage, index) => {
			stageName = `stage ${index}`;
			stage(ctx);
			if (fingerprint(ctx) !== last) outside.push(stageName);
			last = fingerprint(ctx);
		});
		expect(outside).toEqual([]);
	});
});

/** Two expression claims the reader registers, an entry held and another use's. */
function heldClaims(): readonly string[] {
	const index = inventoryIndex();
	return Object.values(EXPRESSION_CLAIMS)
		.map((claim) => claim.entry)
		.filter((entry) => index.entry(entry)?.standing === "held");
}

/** `q2`'s condition, in place of the one Nova's export writes, with each instance of
 *  `instances` declared in the form's model after its main instance. */
function q2ShownWhen(condition: string, instances = "") {
	return (xml: string) =>
		xml
			.replace("</instance>", `</instance>${instances}`)
			.replace(
				`vellum:relevant="#form/q1 = &apos;x&apos;" relevant="/data/q1 = &apos;x&apos;"`,
				`relevant="${condition}"`,
			);
}

/** The findings of `survey()` read with `edit`, through the expression stage, and its
 *  context. */
async function bound(edit: (xml: string) => string) {
	const ctx = await readUpToBinding(survey(), edit);
	bindExpressions(ctx);
	return { ctx, closed: ctx.close() };
}

const Q2 = {
	kind: "question",
	menu: 0,
	form: 0,
	menuName: "Survey",
	formName: "Visit",
	path: "q2",
} as const;

describe("one cause, one finding, for a read the expressions cannot hold", () => {
	it("hands a read of a table the catalog lacks to project data, whose one finding is the table's", async () => {
		for (const declared of [
			`<instance id="item-list:harvests" src="jr://fixture/item-list:harvests"/>`,
			"",
		]) {
			const { ctx, closed } = await bound(
				q2ShownWhen(
					"count(instance(&apos;item-list:harvests&apos;)/harvests_list/harvests) &gt; 0",
					declared,
				),
			);
			expect(closed.findings).toEqual([]);
			expect(
				closed.claims.handOffs.map((one) => [one.to, one.subject, one.key]),
			).toEqual([
				["lookup-table-read", "harvests", "xform:model/bind@relevant"],
			]);
			expect(ctx.facts.unreadTables).toEqual([
				{ tag: "harvests", place: { kind: "lookup-table", tag: "harvests" } },
			]);
		}
	});

	it("lists a table a form only declares as declared, and claims the declaration", async () => {
		const { ctx, closed } = await bound(
			q2ShownWhen(
				"/data/q1 = &apos;x&apos;",
				`<instance id="item-list:harvests" src="jr://fixture/item-list:harvests"/>`,
			),
		);
		expect(closed.findings).toEqual([]);
		expect(closed.claims.handOffs).toEqual([]);
		expect(ctx.facts.unreadTables).toEqual([
			{
				tag: "harvests",
				place: { kind: "lookup-table", tag: "harvests" },
				declaredOnly: true,
			},
		]);
	});

	it("puts a read of an instance refused for its inline content under that refusal", async () => {
		const { closed } = await bound(
			q2ShownWhen(
				"instance(&apos;choices&apos;)/root/item = &apos;a&apos;",
				`<instance id="choices"><root><item>a</item></root></instance>`,
			),
		);
		expect(
			closed.findings.map((one) => [one.code, one.place, one.detail.name]),
		).toEqual([
			[
				"expressions-and-data/inline-instance-content-inside-instance-no-src",
				{ kind: "form", menu: 0, form: 0, menuName: "Survey", name: "Visit" },
				"choices",
			],
		]);
	});

	it.each([
		["an absolute path", "/data/meta/userID = &apos;u&apos;"],
		["a path from the question", "../meta/instanceID = &apos;u&apos;"],
		["the case block's id", "/data/case/@case_id = &apos;c&apos;"],
		[
			"a path inside a call",
			"concat(/data/meta/userID, /data/q1) = &apos;u&apos;",
		],
	])(
		"reads %s into a block HQ's build adds as a form expression outside what Nova types",
		async (_, condition) => {
			const { closed } = await bound(q2ShownWhen(condition));
			expect(closed.findings.map((one) => [one.code, one.place])).toEqual([
				["expressions-and-data/a-form-expression-outside-what-nova-types", Q2],
			]);
		},
	);

	it.each([
		[
			"a Search field's answer in a form no search reaches",
			"instance(&apos;search-input:results&apos;)/input/field[@name = &apos;v&apos;] = &apos;n&apos;",
			`<instance id="search-input:results" src="jr://instance/search-input/results"/>`,
			"expressions-and-data/search-input-read-in-form-expressions-reached-through-a-search",
		],
		[
			"the legacy search input, declared from its source",
			"instance(&apos;search-input&apos;)/input/field[@name = &apos;v&apos;] = &apos;n&apos;",
			`<instance id="search-input" src="jr://instance/search-input"/>`,
			"expressions-and-data/legacy-search-input-read-after-the-query-in-the-results-detail",
		],
	])("reads %s as one finding", async (_, condition, declared, entry) => {
		const { closed } = await bound(q2ShownWhen(condition, declared));
		expect(closed.findings.map((one) => [one.code, one.place])).toEqual([
			[entry, Q2],
		]);
	});
});

describe("applying the expression stage's answer", () => {
	it("gives each registration its tree and its slot's own claim", async () => {
		const ctx = await readUpToBinding(survey());
		const pending = ctx.pending.list();
		const at = pending.findIndex((one) => one.ref.slot === "relevant");
		const [own, use] = heldClaims();
		expect(own).toBeDefined();
		const tree = pendingPlaceholder("condition");
		applyExpressionReading(ctx, {
			doc: provisionalDocument(ctx),
			bound: pending.map((_, index) => (index === at ? tree : undefined)),
			claims: [
				{
					source: at,
					entryId: use ?? (own as string),
					place: pending[at]?.place ?? { kind: "app" },
					key: "xpath-axis:AXIS_CHILD",
					detail: {},
				},
				{
					source: at,
					entryId: own as string,
					place: pending[at]?.place ?? { kind: "app" },
					key: pending[at]?.key ?? "",
					detail: {},
				},
			],
			circumstances: [],
			rewrites: [],
			levels: new Map(),
			declaredProperties: [],
			worldReads: {
				userFields: [],
				sessionUserFields: [],
				locationDataSlugs: [],
			},
			unreadTables: ["clinics", "clinics"],
			declaredTables: ["clinics", "spare"],
			ownerless: [],
			rounds: 1,
		});
		expect(ctx.pending.outcome(at).expression).toBe(tree);
		expect(ctx.pending.outcome(at).claim?.key).toBe(pending[at]?.key);
		expect(ctx.pending.outcome(at).claim?.entryId).toBe(own);
		expect(ctx.facts.unreadTables).toEqual([
			{ tag: "clinics", place: { kind: "lookup-table", tag: "clinics" } },
			{
				tag: "spare",
				place: { kind: "lookup-table", tag: "spare" },
				declaredOnly: true,
			},
		]);
		expect(Object.isFrozen(ctx.doc)).toBe(true);
	});

	it("logs an expression it could not write back behind its unrecognized finding, and a case datum it lacks beside it", async () => {
		const ctx = await readUpToBinding(survey());
		const pending = ctx.pending.list();
		const at = pending.findIndex((one) => one.ref.slot === "relevant");
		const place = pending[at]?.place ?? { kind: "app" as const };
		const name = pending[at]?.key ?? "";
		for (const reason of ["unprintable", "no-case-datum"]) {
			const fresh =
				reason === "unprintable" ? ctx : await readUpToBinding(survey());
			applyExpressionReading(fresh, {
				doc: provisionalDocument(fresh),
				bound: fresh.pending.list().map(() => undefined),
				claims: [],
				circumstances: [
					{ source: at, code: "unrecognized", place, detail: { name, reason } },
				],
				rewrites: [],
				levels: new Map(),
				declaredProperties: [],
				worldReads: {
					userFields: [],
					sessionUserFields: [],
					locationDataSlugs: [],
				},
				unreadTables: [],
				declaredTables: [],
				ownerless: [],
				rounds: 1,
			});
			const { findings, defects } = fresh.close();
			expect(
				findings.filter(
					(finding) =>
						finding.code === "unrecognized" && finding.detail.name === name,
				),
			).toHaveLength(1);
			expect(defects.map((defect) => defect.why)).toEqual(
				reason === "no-case-datum"
					? [
							readerDefect.expressionNotWrittenBack(place, reason),
							readerDefect.noCaseDatum(place),
						]
					: [readerDefect.expressionNotWrittenBack(place, reason)],
			);
		}
	});

	it("raises a finding for a tree a reader claims that the stage held nothing of, and none where it held one", async () => {
		for (const held of [false, true]) {
			const ctx = await readUpToBinding(survey());
			const own = ctx.pending.list();
			const at = own.findIndex((one) => one.ref.slot === "relevant");
			const registration = own[at];
			if (registration === undefined) throw new Error("No display condition");
			// The registrar's own read claims the node; nothing else claims or refuses it.
			const claimed = ctx.pending.register(
				{ ...registration, readerClaimed: true },
				ctx.pending.site(at).at,
			);
			const tree = pendingPlaceholder("condition");
			applyExpressionReading(ctx, {
				doc: provisionalDocument(ctx),
				bound: ctx.pending
					.list()
					.map((_, index) => (held && index === claimed ? tree : undefined)),
				claims: [],
				circumstances: [],
				rewrites: [],
				levels: new Map(),
				declaredProperties: [],
				worldReads: {
					userFields: [],
					sessionUserFields: [],
					locationDataSlugs: [],
				},
				unreadTables: [],
				declaredTables: [],
				ownerless: [],
				rounds: 1,
			});
			const { findings, defects } = ctx.close();
			const unrecognized = findings.filter(
				(finding) =>
					finding.code === "unrecognized" &&
					finding.detail.name === registration.key,
			);
			expect(unrecognized).toHaveLength(held ? 0 : 1);
			expect(defects.map((defect) => defect.why)).toEqual(
				held
					? []
					: [
							readerDefect.expressionNotWrittenBack(
								registration.place,
								"unknown-reason",
							),
						],
			);
		}
	});

	it("applies the second run, over the worker information the first run found the app reads", async () => {
		const workerProperty = asUuid("22222222-2222-4222-8222-222222222222");
		const built = buildDoc({
			modules: [
				{
					name: "Survey",
					forms: [
						{
							name: "Visit",
							type: "survey",
							fields: [
								f({
									kind: "hidden",
									id: "region",
									calculate: {
										kind: "term",
										term: {
											kind: "session-user-property",
											userPropertyUuid: workerProperty,
										},
									},
								}),
							],
						},
					],
				},
			],
		});
		const doc = {
			...built,
			userProperties: {
				[workerProperty]: {
					uuid: workerProperty,
					slug: "region",
					label: "Region",
				},
			},
			userPropertyOrder: [workerProperty],
		} as BlueprintDoc;
		const ctx = await readUpToBinding(doc);
		expect(provisionalDocument(ctx).userProperties ?? {}).toEqual({});
		bindExpressions(ctx);
		const minted = ctx.draft.userProperties[0]?.uuid;
		expect(ctx.draft.userProperties.map((one) => one.slug)).toEqual(["region"]);
		const at = ctx.pending
			.list()
			.findIndex((one) => one.ref.slot === "calculate");
		expect(ctx.pending.outcome(at).expression).toEqual({
			kind: "term",
			term: { kind: "session-user-property", userPropertyUuid: minted },
		});
		expect(ctx.close().findings).toEqual([]);
	});

	it("puts an ownerless registration under the finding at its form, and throws where none stands", async () => {
		const reading = (ctx: ReadContext, ownerless: number) => ({
			doc: provisionalDocument(ctx),
			bound: ctx.pending.list().map(() => undefined),
			claims: [],
			circumstances: [],
			rewrites: [],
			levels: new Map(),
			declaredProperties: [],
			worldReads: {
				userFields: [],
				sessionUserFields: [],
				locationDataSlugs: [],
			},
			unreadTables: [],
			declaredTables: [],
			ownerless: [ownerless],
			rounds: 1,
		});
		const covered = await readUpToBinding(survey());
		const form = covered.draft.modules[0]?.forms[0];
		if (form === undefined) throw new Error("The survey has a form.");
		covered.accounting.finding(X.loadOrder, form.place);
		expect(() =>
			applyExpressionReading(covered, reading(covered, 0)),
		).not.toThrow();
		const bare = await readUpToBinding(survey());
		expect(() => applyExpressionReading(bare, reading(bare, 0))).toThrow(
			/no finding explains why/,
		);
	});
});
