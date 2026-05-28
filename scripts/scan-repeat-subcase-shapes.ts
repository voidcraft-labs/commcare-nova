/**
 * Read-only scan of every app in Firestore for shapes touched by the
 * repeat-context-subcase rollout (the splice algorithm + the two new
 * validator rules `PRIMARY_CASE_FIELD_IN_REPEAT` and
 * `CHILD_CASE_NO_NAME_FIELD`).
 *
 * Three counters per app, one TSV row per offense:
 *
 *   - `PRIMARY_CASE_FIELD_IN_REPEAT` — the new rejection. Was permitted
 *     before this rollout; now isn't. Vellum hides per-field case-
 *     management when any ancestor is a Repeat
 *     (`Vellum/src/caseManagement.js::getSectionDisplay`) and CCHQ rejects
 *     with "Inside the wrong repeat!"
 *     (`commcare-hq/.../case_config_ui.js::caseProperty.validate`), so
 *     the historical Nova-side leak is bounded — but the scan answers
 *     definitively rather than asserting.
 *
 *   - `CHILD_CASE_NO_NAME_FIELD` — the new rejection that replaces the
 *     silent first-field fallback in `deriveCaseConfig::deriveChildCases`.
 *     Any existing app that relied on the fallback (a child-case bucket
 *     with no `case_name`-id'd field) now fails validation. The fallback
 *     was a footgun that silently re-purposed an unrelated field as the
 *     case display name; flagged apps need their authoring fixed.
 *
 *   - `REPEAT_CONTEXT_SUBCASE_UNBLOCKED` — shapes that USED to trip
 *     `SUBCASE_IN_REPEAT_NOT_MODELED` (deleted) and now compile cleanly.
 *     A capability gained, not a rejection — surfaces apps whose authors
 *     can now reach the supported pattern without working around it.
 *
 * Output is TSV to stdout. One row per offense per app. Run with `--help`
 * for the flag reference. The script is READ-ONLY — there is no
 * `--apply` flag and no migrator: the rejected shapes are exactly what
 * the user wants to author (or are unrepresentable invariant violations
 * Vellum + CCHQ also reject); there's nothing to mechanically transform.
 * Operators read the output, then talk to affected authors directly.
 */

import "dotenv/config";
import { Command } from "commander";
import { readFieldString } from "../lib/commcare/fieldProps";
import { runValidation } from "../lib/commcare/validator/runner";
import type { BlueprintDoc, Uuid } from "../lib/domain";
import { db, hydrateBlueprint } from "./lib/firestore";
import { runMain } from "./lib/main";

interface ScanRow {
	appId: string;
	ownerEmail: string;
	moduleName: string;
	formName: string;
	ruleCode:
		| "PRIMARY_CASE_FIELD_IN_REPEAT"
		| "CHILD_CASE_NO_NAME_FIELD"
		| "REPEAT_CONTEXT_SUBCASE_UNBLOCKED";
	fieldId: string;
	details: string;
}

/**
 * Walk a form's field tree and report every cross-case-type
 * (`case_property_on != module.caseType`) field that lives inside a
 * repeat. These are the shapes that USED to trip
 * `SUBCASE_IN_REPEAT_NOT_MODELED`; post-rollout they compile cleanly
 * via the splice algorithm in `xform/caseBlocks.ts::addCaseBlocks`.
 *
 * The walker is intentionally separate from the validator's
 * `primaryCaseFieldInRepeat` and `childCaseNoNameField` rules — those
 * rules report what's now BROKEN; this report counts what's now WORKING.
 */
function findUnblockedSubcaseFields(
	doc: BlueprintDoc,
	formUuid: Uuid,
	moduleCaseType: string,
	knownCaseTypes: ReadonlySet<string>,
): Array<{ fieldId: string; repeatId: string; caseType: string }> {
	const matches: Array<{
		fieldId: string;
		repeatId: string;
		caseType: string;
	}> = [];
	const walk = (parentUuid: Uuid, repeatAncestor: string | undefined): void => {
		for (const uuid of doc.fieldOrder[parentUuid] ?? []) {
			const field = doc.fields[uuid];
			if (!field) continue;
			const cpoOn = readFieldString(field, "case_property_on");
			if (
				repeatAncestor &&
				cpoOn &&
				cpoOn !== moduleCaseType &&
				knownCaseTypes.has(cpoOn)
			) {
				matches.push({
					fieldId: field.id,
					repeatId: repeatAncestor,
					caseType: cpoOn,
				});
			}
			if (doc.fieldOrder[uuid] !== undefined) {
				walk(uuid, field.kind === "repeat" ? field.id : repeatAncestor);
			}
		}
	};
	walk(formUuid, undefined);
	return matches;
}

/**
 * Scan one Firestore app document. Runs the validator (the two new
 * rules fire here) AND the read-only `findUnblockedSubcaseFields` pass
 * (counts the now-supported shapes). Returns one row per offense.
 *
 * Validation errors carry a `location` block the validator populates with
 * `moduleName` / `formName` (via `baseLocation`), so the human-readable
 * names come straight off the error — no rehydration needed. Per-rule
 * context (the offending field id / case type) lives in `error.details`.
 */
function scanApp(
	appId: string,
	ownerEmail: string,
	doc: BlueprintDoc,
): ScanRow[] {
	const rows: ScanRow[] = [];

	// Two new rejection rules — surface via the validator runner so the
	// scan's verdict matches what authors will see in the editor.
	const errors = runValidation(doc);
	for (const error of errors) {
		if (
			error.code !== "PRIMARY_CASE_FIELD_IN_REPEAT" &&
			error.code !== "CHILD_CASE_NO_NAME_FIELD"
		) {
			continue;
		}
		const details = error.details ?? {};
		// PRIMARY_CASE_FIELD_IN_REPEAT carries `fieldId`; CHILD_CASE_NO_NAME_FIELD
		// carries `caseType` (the bucket has no single offending field).
		const fieldId =
			details.fieldId ??
			(details.caseType ? `<bucket:${details.caseType}>` : "<unknown>");
		rows.push({
			appId,
			ownerEmail,
			moduleName: error.location.moduleName ?? "<unknown>",
			formName: error.location.formName ?? "<unknown>",
			ruleCode: error.code,
			fieldId,
			details: error.message,
		});
	}

	// Tag-along read of the now-supported shape (former
	// SUBCASE_IN_REPEAT_NOT_MODELED). Reports a capability gained.
	// The declared case-type set is constant per app, so compute it once
	// here rather than rebuilding it inside the per-form walk.
	const knownCaseTypes = new Set((doc.caseTypes ?? []).map((ct) => ct.name));
	for (const moduleUuid of doc.moduleOrder) {
		const mod = doc.modules[moduleUuid];
		if (!mod.caseType) continue;
		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			const form = doc.forms[formUuid];
			const matches = findUnblockedSubcaseFields(
				doc,
				formUuid,
				mod.caseType,
				knownCaseTypes,
			);
			for (const m of matches) {
				rows.push({
					appId,
					ownerEmail,
					moduleName: mod.name,
					formName: form.name,
					ruleCode: "REPEAT_CONTEXT_SUBCASE_UNBLOCKED",
					fieldId: m.fieldId,
					details: `case_property_on=${m.caseType} inside repeat ${m.repeatId}; now compiles cleanly via the splice algorithm.`,
				});
			}
		}
	}

	return rows;
}

/**
 * Resolve a user's email from their id, memoized by id. The same owner
 * owns many apps, so without the cache a full-collection scan issues one
 * redundant `user` read per app; with it, one read per distinct owner.
 * Returns `""` for an unknown / missing user.
 */
function makeOwnerEmailResolver(): (ownerId: string) => Promise<string> {
	const cache = new Map<string, string>();
	return async (ownerId: string): Promise<string> => {
		if (!ownerId) return "";
		const cached = cache.get(ownerId);
		if (cached !== undefined) return cached;
		let email = "";
		try {
			const userSnap = await db.collection("auth_users").doc(ownerId).get();
			const data = userSnap.data();
			email = data && typeof data.email === "string" ? data.email : "";
		} catch {
			email = "";
		}
		cache.set(ownerId, email);
		return email;
	};
}

async function main(): Promise<void> {
	const program = new Command();
	program
		.name("scan-repeat-subcase-shapes")
		.description(
			"Read-only scan of every app in Firestore for shapes the repeat-context-subcase rollout affects. " +
				"Reports two new rejections (PRIMARY_CASE_FIELD_IN_REPEAT, CHILD_CASE_NO_NAME_FIELD) " +
				"and one capability gained (REPEAT_CONTEXT_SUBCASE_UNBLOCKED). TSV output to stdout. " +
				"Run any time — no writes, no --apply flag, no migrator. Talk to affected authors directly.",
		)
		.option(
			"--limit <n>",
			"cap the number of apps inspected (default: all)",
			(value) => Number.parseInt(value, 10),
		)
		.option(
			"--owner <email>",
			"only inspect apps belonging to the user with this email",
		);
	program.parse(process.argv);
	const options = program.opts<{ limit?: number; owner?: string }>();

	// TSV header — single tab-separated row at the top, then data
	// rows. Operators read it into a spreadsheet or pipe through `awk`.
	console.log(
		[
			"app_id",
			"owner_email",
			"module_name",
			"form_name",
			"rule_code",
			"field_id",
			"details",
		].join("\t"),
	);

	const resolveOwnerEmail = makeOwnerEmailResolver();
	const appsSnap = await db.collection("apps").get();
	let scanned = 0;
	let rowCount = 0;
	for (const appSnap of appsSnap.docs) {
		if (options.limit !== undefined && scanned >= options.limit) break;
		const data = appSnap.data();
		const ownerId = typeof data.owner === "string" ? data.owner : "";
		const ownerEmail = await resolveOwnerEmail(ownerId);
		if (options.owner !== undefined && ownerEmail !== options.owner) continue;
		const doc = data.blueprint;
		if (!doc || typeof doc !== "object") continue;
		let hydrated: BlueprintDoc;
		try {
			hydrated = hydrateBlueprint(doc);
		} catch {
			continue;
		}
		const rows = scanApp(appSnap.id, ownerEmail, hydrated);
		for (const row of rows) {
			console.log(
				[
					row.appId,
					row.ownerEmail,
					row.moduleName,
					row.formName,
					row.ruleCode,
					row.fieldId,
					row.details.replace(/\t/g, " ").replace(/\n/g, " "),
				].join("\t"),
			);
			rowCount += 1;
		}
		scanned += 1;
	}

	console.error(`# scanned ${scanned} apps, emitted ${rowCount} offense rows`);
}

runMain(main);
