/**
 * Sample data names a child's parent by the index the app's forms read it
 * through.
 *
 * Contract: in an app whose forms link a member to its household as `home`, a
 * form opened on a member reads its household through `index/home`
 * (`lib/commcare/caseTypeDepths.ts::caseTypeHopMap`). Sample members, and a
 * record inserted with a supplied parent, carry that index, so Preview's read
 * of a sample member's household finds the household the member was generated
 * under.
 *
 * The plausible failure: sample members written under `parent` whatever the
 * app's links name, so every household value a member's form shows reads
 * blank in Preview while the parent-select list still offers the member.
 */
import { type Kysely, sql } from "kysely";
import { beforeEach, describe, expect, it } from "vitest";
import { buildCaseTypeMap, type CaseStore } from "@/lib/case-store";
import { PostgresCaseStore } from "@/lib/case-store/postgres/store";
import { HeuristicCaseGenerator } from "@/lib/case-store/sample/heuristic";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";
import type { Database } from "@/lib/case-store/sql/database";
import {
	advancedFixture,
	HOUSEHOLD_VISIT,
	OP,
	read,
	UNDER_TEST,
} from "@/lib/commcare/__tests__/advancedPlacementFixture";
import { serializeWire } from "@/lib/commcare/xpath/wire/serialize";
import type { BlueprintDoc, CaseType, Uuid } from "@/lib/domain";
import { formField, term } from "@/lib/domain/expression/builders";
import { evaluate } from "@/lib/preview/xpath/evaluator";
import { sampleParentLink, seedSampleCases } from "../caseDataBindingHelpers";
import { formSessionBindings } from "../formExpressionRuntime";
import {
	caseDatabaseXPathInstance,
	commcareSessionXPathInstance,
} from "../xpathInstances";

const APP_ID = "app-sample-parent-index";
const PROJECT = "project-sample-parent-index";
const OWNER = "owner-sample-parent-index";

const dbHandle = setupPerTestDatabase({
	schema: "migrated",
	databaseNamePrefix: "sample_parent_index_",
});

beforeEach(async () => {
	await sql`
		INSERT INTO apps (id, owner, project_id, app_name, app_name_lower)
		VALUES (${APP_ID}, ${OWNER}, ${PROJECT}, ${"Members"}, ${"members"})
	`.execute(dbHandle.db);
});

/** Members chosen under their household, where the household's visit
 *  registers a member linked to it as `identifier`, under `relationship`. */
function members(
	identifier: string,
	relationship: "child" | "extension" = "child",
): BlueprintDoc {
	return advancedFixture({
		formType: "followup",
		menu: "members",
		heldKind: false,
		operations: () => [
			{
				uuid: OP("own"),
				id: "member",
				action: "own",
				writes: [{ property: "age", value: read("age") }],
			},
		],
		configure: (doc) => {
			const remark = doc.fieldOrder[HOUSEHOLD_VISIT]?.[0] as Uuid;
			doc.forms[HOUSEHOLD_VISIT] = {
				...doc.forms[HOUSEHOLD_VISIT],
				caseOperations: [
					{
						uuid: OP("household"),
						id: "household",
						action: "own",
						writes: [{ property: "remark", value: term(formField(remark)) }],
					},
					{
						uuid: OP("member"),
						id: "member",
						action: "create",
						caseType: "member",
						target: { kind: "new" },
						name: term(formField(remark)),
						links: [
							{
								identifier,
								targetType: "household",
								target: { kind: "session" },
								relationship,
							},
						],
					},
				],
			} as never;
		},
	}).doc;
}

function storeFor(): CaseStore {
	return new PostgresCaseStore({
		projectId: PROJECT,
		actorUserId: OWNER,
		ownerId: OWNER,
		db: dbHandle.db as unknown as Kysely<Database>,
		sampleGenerator: new HeuristicCaseGenerator(),
	});
}

async function materialize(store: CaseStore, doc: BlueprintDoc) {
	const caseTypeSchemas = buildCaseTypeMap(doc);
	for (const caseType of ["household", "member"]) {
		await store.applySchemaChange({ appId: APP_ID, caseType, caseTypeSchemas });
	}
	const type = (name: string) => caseTypeSchemas.get(name) as CaseType;
	return { household: type("household"), member: type("member") };
}

/** The member form's read of its household's remark, evaluated as Preview
 *  evaluates it over the device rows. */
function householdRemarkOf(
	doc: BlueprintDoc,
	world: Parameters<typeof caseDatabaseXPathInstance>[0],
	memberId: string,
): unknown {
	const text = serializeWire(
		formSessionBindings(doc, UNDER_TEST).formCaseProperty(
			"household",
			"remark",
		),
		{ target: "preview" },
	).text;
	const casedb = caseDatabaseXPathInstance(world, doc.caseTypes ?? []);
	const session = commcareSessionXPathInstance(
		{ context: {}, user: {}, userPropertySlugs: {} } as never,
		{ case_id: memberId },
	);
	return evaluate(text, {
		getValue: () => undefined,
		contextPath: "/data",
		position: undefined,
		resolveXPathInstance: (id) =>
			id === "casedb" ? casedb : id === "commcaresession" ? session : undefined,
	});
}

describe("sample members of an app that links them to their household as `home`", () => {
	it.each([
		["home", "child"],
		// The catalog calls a member a child; the app extends the household
		// as `host`, and a sample member carries that link as a submitted
		// one does, so a list that leaves extensions out leaves it out too.
		["host", "extension"],
	] as const)(
		"carry the `%s` index under its %s relationship, and a member's form reads the household it was generated under",
		async (identifier, relationship) => {
			const doc = members(identifier, relationship);
			const store = storeFor();
			const { household, member } = await materialize(store, doc);
			expect(sampleParentLink(doc, member)).toEqual({
				parentIdentifier: identifier,
				parentRelationship: relationship,
			});
			for (const caseType of [household, member]) {
				const seeded = await seedSampleCases(store, {
					appId: APP_ID,
					caseType,
					...sampleParentLink(doc, caseType),
				});
				expect(seeded.kind).toBe("ok");
			}
			const ids = (
				await (dbHandle.db as unknown as Kysely<Database>)
					.selectFrom("cases")
					.select("case_id")
					.where("app_id", "=", APP_ID)
					.execute()
			).map((row) => row.case_id);
			const world = await store.readCaseDatabasePatch({
				appId: APP_ID,
				caseIds: ids,
			});
			const members_ = world.rows.filter((row) => row.case_type === "member");
			expect(members_.length).toBeGreaterThan(0);
			expect(
				new Set(
					world.indices
						.filter((index) => index.target_case_type === "household")
						.map((index) => `${index.identifier} ${index.relationship}`),
				),
			).toEqual(new Set([`${identifier} ${relationship}`]));
			const households = new Map(
				world.rows
					.filter((row) => row.case_type === "household")
					.map((row) => [row.case_id, row]),
			);
			let readNonBlank = 0;
			for (const row of members_) {
				// The column holds a `parent` index alone, so a member named under
				// another index holds none there; its household is its edge.
				expect(row.parent_case_id).toBeNull();
				const edge = world.indices.find(
					(index) => index.case_id === row.case_id,
				);
				const parent =
					edge === undefined ? undefined : households.get(edge.ancestor_id);
				if (parent === undefined)
					throw new Error("A sample member has a household.");
				const remark = String(parent.properties.remark ?? "");
				expect(householdRemarkOf(doc, world, row.case_id)).toBe(remark);
				if (remark !== "") readNonBlank += 1;
			}
			// The read finds the household's value, not a blank that agrees with
			// a blank remark.
			expect(readNonBlank).toBeGreaterThan(0);
		},
	);

	it("an inserted record with a supplied household carries the index it is named", async () => {
		const doc = members("home");
		const store = storeFor();
		const { member } = await materialize(store, doc);
		const { caseId: householdId } = await store.insert({
			appId: APP_ID,
			row: {
				case_type: "household",
				case_name: "Household",
				properties: { remark: "the chosen household" },
			},
		});
		const { caseId: memberId } = await store.insert({
			appId: APP_ID,
			row: {
				case_type: "member",
				case_name: "Member",
				parent_case_id: householdId,
				properties: {},
			},
			parentRelationship: "child",
			parentIdentifier: sampleParentLink(doc, member).parentIdentifier,
		});
		const world = await store.readCaseDatabasePatch({
			appId: APP_ID,
			caseIds: [householdId, memberId],
		});
		expect(world.indices.map((index) => index.identifier)).toEqual(["home"]);
		expect(householdRemarkOf(doc, world, memberId)).toBe(
			"the chosen household",
		);
	});

	it("holds the household in `parent_case_id` only under a `parent` index, through every writer", async () => {
		const doc = members("home");
		const store = storeFor();
		await materialize(store, doc);
		const db = dbHandle.db as unknown as Kysely<Database>;
		const household = async (remark: string) =>
			(
				await store.insert({
					appId: APP_ID,
					row: {
						case_type: "household",
						case_name: remark,
						properties: { remark },
					},
				})
			).caseId;
		const first = await household("first");
		const second = await household("second");
		const state = async (caseId: string) => ({
			column: (
				await db
					.selectFrom("cases")
					.select("parent_case_id")
					.where("case_id", "=", caseId)
					.executeTakeFirstOrThrow()
			).parent_case_id,
			edges: (
				await db
					.selectFrom("case_indices")
					.select(["identifier", "ancestor_id"])
					.where("case_id", "=", caseId)
					.orderBy("identifier")
					.execute()
			).map((edge) => [edge.identifier, edge.ancestor_id]),
		});
		const member = async (parentIdentifier?: string) =>
			(
				await store.insert({
					appId: APP_ID,
					row: {
						case_type: "member",
						case_name: "Member",
						parent_case_id: first,
						properties: {},
					},
					parentRelationship: "child",
					...(parentIdentifier === undefined ? {} : { parentIdentifier }),
				})
			).caseId;

		const underParent = await member();
		expect(await state(underParent)).toEqual({
			column: first,
			edges: [["parent", first]],
		});
		const underHome = await member("home");
		expect(await state(underHome)).toEqual({
			column: null,
			edges: [["home", first]],
		});

		// An update names the parent under the index it is told, and leaves
		// the column to the `parent` index.
		await store.update({
			appId: APP_ID,
			caseId: underParent,
			patch: { parent_case_id: second },
			parentRelationship: "child",
			parentIdentifier: "home",
		});
		expect(await state(underParent)).toEqual({
			column: first,
			edges: [
				["home", second],
				["parent", first],
			],
		});
		await store.update({
			appId: APP_ID,
			caseId: underHome,
			patch: { parent_case_id: second },
			parentRelationship: "child",
			parentIdentifier: "home",
		});
		expect(await state(underHome)).toEqual({
			column: null,
			edges: [["home", second]],
		});
		await store.update({
			appId: APP_ID,
			caseId: underParent,
			patch: { parent_case_id: second },
			parentRelationship: "child",
		});
		expect(await state(underParent)).toEqual({
			column: second,
			edges: [
				["home", second],
				["parent", second],
			],
		});
		await store.update({
			appId: APP_ID,
			caseId: underParent,
			patch: { parent_case_id: null },
			parentIdentifier: "home",
		});
		expect(await state(underParent)).toEqual({
			column: second,
			edges: [["parent", second]],
		});
	});
});
