/**
 * READ-ONLY — prove that no stored app carries a uuid-less after-submit link.
 *
 * `FormLink` gained a required `uuid` and `updateForm.patch.formLinks` left
 * the mutation grammar; neither ships a runtime migration because, per this
 * scan, nothing persisted holds the old shape. It reads every store that
 * could: current `blueprint_entities` form rows, each app's greatest
 * `app_change_fold_baselines` snapshot, and the post-baseline
 * `autosave` / `mcp` / `chat` rows of `app_changes` whose mutations carry
 * `updateForm.patch.formLinks` or `addForm.form.formLinks`. Any nonzero
 * count exits 2: stop and plan a conversion before deploying.
 */
import "dotenv/config";
import { Command } from "commander";
import { sql } from "kysely";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { getAppDb } from "@/lib/db/pg";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";

interface Options {
	app?: string;
	prod?: boolean;
	json?: boolean;
}

const program = new Command();
program
	.name("scan-form-links")
	.description(
		"Count every stored after-submit link (entity rows, fold-baseline snapshots, post-baseline mutation rows); never writes.",
	)
	.option("--app <appId>", "scope the scan to one app")
	.option("--prod", "scan production through the read-only operator identity")
	.option("--json", "print one JSON object instead of the text report");
program.parse();
const options = program.opts<Options>();
if (options.prod === true) targetProdDb();

const MUTATION_KINDS_THAT_PERSIST_LINKS = ["autosave", "mcp", "chat"] as const;

interface AppReport {
	readonly appId: string;
	/** Current form rows whose data carries `formLinks`, with the link total. */
	readonly entityForms: number;
	readonly entityLinks: number;
	/** Forms with `formLinks` in the greatest fold-baseline snapshot. */
	readonly baselineSeq: number | null;
	readonly baselineForms: number;
	/** Post-baseline mutation rows carrying a legacy whole-array link write. */
	readonly legacyMutationRows: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const linkCount = (value: unknown): number =>
	Array.isArray(value) ? value.length : 0;

function rowCarriesLegacyLinkWrite(mutations: unknown): boolean {
	if (!Array.isArray(mutations)) return false;
	return mutations.some((mutation) => {
		if (!isRecord(mutation)) return false;
		if (mutation.kind === "updateForm") {
			return isRecord(mutation.patch) && "formLinks" in mutation.patch;
		}
		if (mutation.kind === "addForm") {
			return isRecord(mutation.form) && "formLinks" in mutation.form;
		}
		return false;
	});
}

async function scanApp(
	db: Awaited<ReturnType<typeof getAppDb>>,
	appId: string,
): Promise<AppReport> {
	const formRows = await db
		.selectFrom("blueprint_entities")
		.select(
			sql<string>`${sql.ref("blueprint_entities.data")}->'formLinks'`.as(
				"form_links",
			),
		)
		.where("app_id", "=", appId)
		.where("kind", "=", "form")
		.where(sql<boolean>`${sql.ref("blueprint_entities.data")} ? 'formLinks'`)
		.execute();
	let entityLinks = 0;
	for (const row of formRows) {
		entityLinks += linkCount(
			typeof row.form_links === "string"
				? JSON.parse(row.form_links)
				: row.form_links,
		);
	}

	const baseline = await db
		.selectFrom("app_change_fold_baselines")
		.select(["seq"])
		.select(
			sql<string>`${sql.ref("app_change_fold_baselines.snapshot")}::text`.as(
				"snapshot_text",
			),
		)
		.where("app_id", "=", appId)
		.orderBy("seq", "desc")
		.limit(1)
		.executeTakeFirst();
	let baselineForms = 0;
	let baselineSeq: number | null = null;
	if (baseline !== undefined) {
		baselineSeq = Number(baseline.seq);
		const snapshot: unknown = JSON.parse(baseline.snapshot_text);
		if (isRecord(snapshot) && isRecord(snapshot.forms)) {
			for (const form of Object.values(snapshot.forms)) {
				if (isRecord(form) && "formLinks" in form) baselineForms += 1;
			}
		}
	}

	let changeQuery = db
		.selectFrom("app_changes")
		.select(
			sql<string>`${sql.ref("app_changes.mutations")}::text`.as(
				"mutations_text",
			),
		)
		.where("app_id", "=", appId)
		.where("kind", "in", [...MUTATION_KINDS_THAT_PERSIST_LINKS])
		// Cheap SQL pre-filter; the JS walk below is the verdict.
		.where(
			sql<boolean>`${sql.ref("app_changes.mutations")}::text LIKE '%formLinks%'`,
		);
	if (baselineSeq !== null) {
		changeQuery = changeQuery.where("seq", ">", String(baselineSeq));
	}
	const changeRows = await changeQuery.execute();
	let legacyMutationRows = 0;
	for (const row of changeRows) {
		if (rowCarriesLegacyLinkWrite(JSON.parse(row.mutations_text))) {
			legacyMutationRows += 1;
		}
	}

	return {
		appId,
		entityForms: formRows.length,
		entityLinks,
		baselineSeq,
		baselineForms,
		legacyMutationRows,
	};
}

async function main(): Promise<void> {
	const db = await getAppDb();
	let query = db.selectFrom("apps").select("id").orderBy("id");
	if (options.app !== undefined) query = query.where("id", "=", options.app);
	const apps = await query.execute();
	if (options.app !== undefined && apps.length === 0) {
		throw new Error(`App ${options.app} not found.`);
	}

	const reports: AppReport[] = [];
	for (const { id } of apps) reports.push(await scanApp(db, id));

	const totals = reports.reduce(
		(acc, report) => ({
			entityForms: acc.entityForms + report.entityForms,
			entityLinks: acc.entityLinks + report.entityLinks,
			baselineForms: acc.baselineForms + report.baselineForms,
			legacyMutationRows: acc.legacyMutationRows + report.legacyMutationRows,
		}),
		{ entityForms: 0, entityLinks: 0, baselineForms: 0, legacyMutationRows: 0 },
	);
	const nonzero =
		totals.entityForms + totals.baselineForms + totals.legacyMutationRows > 0;

	if (options.json === true) {
		console.log(
			JSON.stringify(
				{
					apps: reports.length,
					...totals,
					nonzero,
					perApp: reports.filter(
						(r) => r.entityForms + r.baselineForms + r.legacyMutationRows > 0,
					),
				},
				null,
				2,
			),
		);
	} else {
		for (const report of reports) {
			if (
				report.entityForms +
					report.baselineForms +
					report.legacyMutationRows ===
				0
			) {
				continue;
			}
			console.log(
				`${report.appId}\tentity forms with links: ${report.entityForms} (${report.entityLinks} link(s))\tbaseline seq ${report.baselineSeq ?? "none"} forms with links: ${report.baselineForms}\tpost-baseline legacy link writes: ${report.legacyMutationRows}`,
			);
		}
		console.log(
			`\nScanned ${reports.length} app(s): ${totals.entityForms} form row(s) with links (${totals.entityLinks} link(s)), ${totals.baselineForms} baseline form(s) with links, ${totals.legacyMutationRows} post-baseline legacy link write(s).`,
		);
		console.log(
			nonzero
				? "Stored links exist: a conversion is needed before this change deploys."
				: "No stored links: the identity change needs no data migration.",
		);
	}
	if (nonzero) process.exitCode = 2;
}

runMain(async () => {
	try {
		await main();
	} finally {
		await closeCaseStoreDatabase();
	}
});
