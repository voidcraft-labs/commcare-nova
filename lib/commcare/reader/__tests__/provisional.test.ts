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
 * registration stands under the finding at or above its place or is the
 * invariant C10, and a table the catalog lacks is listed once.
 *
 * Plausible failures: a stale document served after a draft changed, a
 * stand-in missing so a second false finding appears, a surface use's claim
 * given as the slot's, a tag listed twice.
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

/** Renames the question `q1` to an id the question id grammar refuses, everywhere it is named. */
const refuseQ1 = (xml: string) => xml.replaceAll("q1", "script");

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

/** Renames the group `boxed` to an id the grammar refuses, and binds `q3` as a Long, a kind
 *  Nova refuses. */
function refuseBoxedAndQ3(xml: string): string {
	const renamed = xml.replaceAll("boxed", "script");
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
			(field) => field.id === "script",
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
		const group = byId("script");
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
			expect.objectContaining({ kind: "question", path: "script" }),
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
		connectType: draft.connectType,
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
			declaredProperties: [],
			worldReads: { userFields: [], locationDataSlugs: [] },
			unreadTables: ["clinics", "clinics"],
			ownerless: [],
			rounds: 1,
		});
		expect(ctx.pending.outcome(at).expression).toBe(tree);
		expect(ctx.pending.outcome(at).claim?.key).toBe(pending[at]?.key);
		expect(ctx.pending.outcome(at).claim?.entryId).toBe(own);
		expect(ctx.facts.unreadTables.map((table) => table.tag)).toEqual([
			"clinics",
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
				declaredProperties: [],
				worldReads: { userFields: [], locationDataSlugs: [] },
				unreadTables: [],
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
			declaredProperties: [],
			worldReads: { userFields: [], locationDataSlugs: [] },
			unreadTables: [],
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
