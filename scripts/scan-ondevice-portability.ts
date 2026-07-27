/**
 * READ-ONLY — find persisted apps holding an expression that the on-device
 * emitter now refuses.
 *
 * `caseListFilterEmitter` used to lower `fuzzy` / `phonetic` / `fuzzy-date`
 * into XPath CommCare Core cannot evaluate, and case operations accepted a
 * strict `is-null` the wire cannot express. Both are now refused. Every
 * OTHER carrier that lowers through that emitter was already protected by an
 * AST rule (the case-list filter, the Search-button condition, module and
 * form display conditions), so a valid stored doc cannot hold one there.
 *
 * Two carriers were NOT protected, and are what this scan exists to clear:
 *
 *   - case operations — every condition, write condition, and value slot;
 *   - a lookup-backed select's `optionsSource.filter`, which reaches the
 *     same emitter through `xform/builder.ts::buildLookupItemset`.
 *
 * An advanced search input's predicate is deliberately NOT scanned: it
 * resolves as a server-side case-search query, where all four match modes
 * are legal and always have been.
 *
 * The script never repairs or mutates. Any hit, or any app that cannot be
 * assembled, makes the process exit nonzero.
 */

import "dotenv/config";
import { Command } from "commander";
import type { Selectable, Transaction } from "kysely";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { assembleBlueprint, type EntityRow } from "@/lib/db/blueprintRows";
import { type AppDatabase, type AppsTable, getAppDb } from "@/lib/db/pg";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { orderedCaseOperations } from "@/lib/domain";
import type { Predicate, ValueExpression } from "@/lib/domain/predicate";
import {
	walkExpressionPredicateNodes,
	walkPredicateNodes,
} from "@/lib/domain/predicate";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";

interface ScanOptions {
	prod?: boolean;
}

const program = new Command();
program
	.name("scan-ondevice-portability")
	.description(
		"Read-only fleet audit for expressions the on-device emitter now refuses: CSQL-only match modes and strict is-null, in case operations and lookup-backed select filters. Exits nonzero on any hit.",
	)
	.option(
		"--prod",
		"scan production Cloud SQL through your read-only gcloud IAM identity",
	)
	.addHelpText(
		"after",
		"\nExamples:\n" +
			"  $ npx tsx scripts/scan-ondevice-portability.ts\n" +
			"  $ npx tsx scripts/scan-ondevice-portability.ts --prod\n",
	);
program.parse();
const opts = program.opts<ScanOptions>();
if (opts.prod === true) targetProdDb();

/** The three modes CommCare Core's XPath dispatch does not register. */
const CSQL_ONLY = new Set(["fuzzy", "phonetic", "fuzzy-date"]);

interface Hit {
	readonly appId: string;
	readonly projectId: string | null;
	readonly appName: string;
	readonly where: string;
	readonly what: string;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function inspectPredicate(predicate: Predicate, where: string): string[] {
	const found: string[] = [];
	walkPredicateNodes(predicate, (node) => {
		if (node.kind === "match" && CSQL_ONLY.has(node.mode)) {
			found.push(`${where}: ${node.mode} match`);
		}
		if (node.kind === "is-null") found.push(`${where}: strict is-null`);
	});
	return found;
}

function inspectExpression(
	expression: ValueExpression,
	where: string,
): string[] {
	const found: string[] = [];
	walkExpressionPredicateNodes(expression, (node) => {
		if (node.kind === "match" && CSQL_ONLY.has(node.mode)) {
			found.push(`${where}: ${node.mode} match`);
		}
		if (node.kind === "is-null") found.push(`${where}: strict is-null`);
	});
	return found;
}

type PersistedAppRow = Pick<
	Selectable<AppsTable>,
	| "id"
	| "project_id"
	| "app_name"
	| "connect_type"
	| "case_types"
	| "logo"
	| "deleted_at"
>;

async function scanApp(
	tx: Transaction<AppDatabase>,
	row: PersistedAppRow,
): Promise<{ hits: Hit[]; failure?: string }> {
	let doc: ReturnType<typeof hydratePersistedBlueprint>;
	try {
		const entityRows = (await tx
			.selectFrom("blueprint_entities")
			.select(["uuid", "kind", "parent_uuid", "ordinal", "data"])
			.where("app_id", "=", row.id)
			.execute()) as EntityRow[];
		doc = hydratePersistedBlueprint(
			assembleBlueprint(
				row.id,
				{
					app_name: row.app_name,
					connect_type: row.connect_type,
					case_types: row.case_types,
					logo: row.logo,
				},
				entityRows,
			),
		);
	} catch (error) {
		return { hits: [], failure: errorMessage(error) };
	}

	const found: string[] = [];

	for (const form of Object.values(doc.forms)) {
		for (const operation of orderedCaseOperations(form)) {
			const at = `form "${form.name}" operation "${operation.id}"`;
			if (operation.condition !== undefined) {
				found.push(...inspectPredicate(operation.condition, `${at} condition`));
			}
			for (const slot of ["name", "rename", "owner"] as const) {
				const value = operation[slot];
				if (value !== undefined) {
					found.push(...inspectExpression(value, `${at} ${slot}`));
				}
			}
			if (operation.target.kind === "expression") {
				found.push(...inspectExpression(operation.target.expr, `${at} target`));
			}
			for (const write of operation.writes ?? []) {
				found.push(
					...inspectExpression(write.value, `${at} write ${write.property}`),
				);
				if (write.condition !== undefined) {
					found.push(
						...inspectPredicate(
							write.condition,
							`${at} write ${write.property} condition`,
						),
					);
				}
			}
			for (const link of operation.links ?? []) {
				if (link.target?.kind === "expression") {
					found.push(
						...inspectExpression(
							link.target.expr,
							`${at} link ${link.identifier}`,
						),
					);
				}
			}
		}
	}

	for (const field of Object.values(doc.fields)) {
		// Only the select kinds carry a lookup source; the union has no
		// common slot, so narrow structurally rather than by kind list.
		const source = (field as { optionsSource?: { filter?: Predicate } })
			.optionsSource;
		const filter = source?.filter;
		if (filter !== undefined) {
			found.push(
				...inspectPredicate(filter, `field "${field.id}" list filter`),
			);
		}
	}

	return {
		hits: found.map((what) => ({
			appId: row.id,
			projectId: row.project_id,
			appName: row.app_name,
			where: what.split(":")[0],
			what,
		})),
	};
}

runMain(async () => {
	const db = await getAppDb();
	const hits: Hit[] = [];
	const failures: string[] = [];
	let scanned = 0;

	await db.transaction().execute(async (tx) => {
		const rows = (await tx
			.selectFrom("apps")
			.select([
				"id",
				"project_id",
				"app_name",
				"connect_type",
				"case_types",
				"logo",
				"deleted_at",
			])
			.execute()) as PersistedAppRow[];
		for (const row of rows) {
			scanned += 1;
			const result = await scanApp(tx, row);
			hits.push(...result.hits);
			if (result.failure !== undefined) {
				failures.push(`${row.id} (${row.app_name}): ${result.failure}`);
			}
		}
	});

	console.log(`Scanned ${scanned} app(s).`);
	if (failures.length > 0) {
		console.log(`\n${failures.length} app(s) could not be assembled:`);
		for (const failure of failures) console.log(`  ${failure}`);
	}
	if (hits.length === 0) {
		console.log(
			"No case operation or lookup-backed select filter holds a CSQL-only match mode or a strict is-null.",
		);
	} else {
		console.log(`\n${hits.length} expression(s) the emitter now refuses:`);
		for (const hit of hits) {
			console.log(`  ${hit.appId} (${hit.appName}) [${hit.projectId}]`);
			console.log(`    ${hit.what}`);
		}
	}

	await closeCaseStoreDatabase();
	if (hits.length > 0 || failures.length > 0) process.exitCode = 1;
});
