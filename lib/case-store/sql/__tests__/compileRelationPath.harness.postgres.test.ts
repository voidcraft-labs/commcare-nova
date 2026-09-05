// Execute relation walks against real rows: SQL spelling alone cannot prove
// direction, tenant isolation, type narrowing, or direct-edge semantics.
import {
	ancestorPath,
	anyRelationPath,
	relationStep,
	subcasePath,
} from "@/lib/domain/predicate/builders";
import type { RelationPath } from "@/lib/domain/predicate/types";
import { compileRelationPath } from "../compileRelationPath";
import { expect, makeCaseRow, test } from "./setup";

const APP_ID = "app-relation-path";
const PROJECT_ID = "owner-relation-path";
const id = (n: number) =>
	`00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
type Db = Parameters<typeof compileRelationPath>[1]["db"];

async function leaves(db: Db, path: RelationPath): Promise<string[]> {
	const compiled = compileRelationPath(path, {
		db,
		appId: APP_ID,
		projectId: PROJECT_ID,
		anchorAlias: "c",
	});
	if (compiled.kind !== "joined") throw new Error("Expected a joined path");
	const rows = await db
		.selectFrom("cases as c")
		.innerJoin(
			() => compiled.buildLeafSubquery(),
			(join) =>
				join.onRef(`${compiled.leafAlias}.anchor_case_id`, "=", "c.case_id"),
		)
		.where("c.case_id", "=", id(1))
		.where("c.app_id", "=", APP_ID)
		.where("c.project_id", "=", PROJECT_ID)
		.select(`${compiled.leafAlias}.case_id as leaf_id`)
		.execute();
	return rows.map((row) => row.leaf_id).sort();
}

const singleHopArms = [
	{
		name: "ancestor",
		path: ancestorPath(relationStep("link", "member")),
		all: ancestorPath(relationStep("link")),
		expected: [id(2)],
	},
	{
		name: "subcase",
		path: subcasePath("link", "member"),
		all: subcasePath("link"),
		expected: [id(12)],
	},
	{
		name: "any-relation",
		path: anyRelationPath("link", "member"),
		all: anyRelationPath("link"),
		expected: [id(2), id(12)],
	},
];
for (const arm of singleHopArms) {
	test(`${arm.name} respects direction and filters every leaf`, async ({
		db,
		pgClient,
	}) => {
		// Intentionally corrupt tenant rows exercise the compiler boundary on its
		// own. Defer only this FK; the harness rolls the adversarial rows back.
		await pgClient.query(
			"SET CONSTRAINTS cases_project_app_tenant_fk DEFERRED",
		);
		const variants = [
			{},
			{ project_id: "foreign-project" },
			{ app_id: "foreign-app" },
			{ case_type: "other-type" },
			{}, // Wrong index identifier.
			{}, // Transitive edge.
		];
		await db
			.insertInto("cases")
			.values([
				makeCaseRow({
					case_id: id(1),
					app_id: APP_ID,
					project_id: PROJECT_ID,
					case_type: "anchor",
				}),
				...[2, 12].flatMap((start) =>
					variants.map((variant, offset) =>
						makeCaseRow({
							case_id: id(start + offset),
							app_id: APP_ID,
							project_id: PROJECT_ID,
							case_type: "member",
							owner_id: `different-owner-${offset}`,
							...variant,
						}),
					),
				),
			])
			.execute();
		await db
			.insertInto("case_indices")
			.values(
				[2, 12].flatMap((start) =>
					variants.map((variant, offset) => ({
						case_id: start === 2 ? id(1) : id(start + offset),
						ancestor_id: start === 2 ? id(start + offset) : id(1),
						target_case_type:
							start === 2 ? (variant.case_type ?? "member") : "anchor",
						identifier: offset === 4 ? "different-link" : "link",
						relationship: "child" as const,
						depth: offset === 5 ? 2 : 1,
					})),
				),
			)
			.execute();
		expect(await leaves(db, arm.path)).toEqual(arm.expected);
		// Removing the type qualifier admits the other type, while the same
		// identifier, depth and tenant exclusions still apply.
		const otherTypes = arm.expected.map((value) =>
			id(Number(value.slice(-12)) + 3),
		);
		expect(await leaves(db, arm.all)).toEqual(
			[...arm.expected, ...otherTypes].sort(),
		);
	});
}

for (const hop of [2, 3]) {
	test(`two-hop walks enforce tenant, type and direct edges at hop ${hop - 1}`, async ({
		db,
		pgClient,
	}) => {
		// Intentionally corrupt tenant rows exercise the compiler boundary on its
		// own. Defer only this FK; the harness rolls the adversarial rows back.
		await pgClient.query(
			"SET CONSTRAINTS cases_project_app_tenant_fk DEFERRED",
		);
		await db
			.insertInto("cases")
			.values(
				[1, 2, 3].map((n) =>
					makeCaseRow({
						case_id: id(n),
						app_id: APP_ID,
						project_id: PROJECT_ID,
						case_type: n === 2 ? "household" : "village",
						owner_id: `owner-${n}`,
					}),
				),
			)
			.execute();
		await db
			.insertInto("case_indices")
			.values([
				{
					case_id: id(1),
					ancestor_id: id(2),
					identifier: "parent",
					target_case_type: "household",
					relationship: "child",
					depth: 1,
				},
				{
					case_id: id(2),
					ancestor_id: id(3),
					identifier: "host",
					target_case_type: "village",
					relationship: "extension",
					depth: 1,
				},
			])
			.execute();
		const path = ancestorPath(
			relationStep("parent", "household"),
			relationStep("host", "village"),
		);
		expect(await leaves(db, path)).toEqual([id(3)]);
		const original = {
			app_id: APP_ID,
			project_id: PROJECT_ID,
			case_type: hop === 2 ? "household" : "village",
		};
		for (const patch of [
			{ app_id: "foreign-app" },
			{ project_id: "foreign-project" },
			{ case_type: "wrong-type" },
		]) {
			await db
				.updateTable("cases")
				.set(patch)
				.where("case_id", "=", id(hop))
				.execute();
			expect(await leaves(db, path), JSON.stringify(patch)).toEqual([]);
			await db
				.updateTable("cases")
				.set(original)
				.where("case_id", "=", id(hop))
				.execute();
		}
		for (const patch of [{ depth: 2 }, { identifier: "wrong-link" }]) {
			await db
				.updateTable("case_indices")
				.set(patch)
				.where("case_id", "=", id(hop - 1))
				.execute();
			expect(await leaves(db, path), JSON.stringify(patch)).toEqual([]);
			await db
				.updateTable("case_indices")
				.set({ depth: 1, identifier: hop === 2 ? "parent" : "host" })
				.where("case_id", "=", id(hop - 1))
				.execute();
		}
		expect(await leaves(db, path)).toEqual([id(3)]);
	});
}
