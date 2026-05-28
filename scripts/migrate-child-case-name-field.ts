/**
 * One-time migration: promote the first field in every child-case bucket
 * missing a `case_name`-id'd field to `case_name`.
 *
 * Mirrors what `deriveCaseConfig::deriveChildCases` USED to do silently —
 * before the `CHILD_CASE_NO_NAME_FIELD` validator landed, an authoring
 * shape with a child-case bucket and no `case_name` field fell back to
 * "use the first field in the bucket as the case_name source." The
 * fallback was a footgun and is gone; this migrator makes the implicit
 * fallback explicit so apps that relied on it keep compiling under the
 * new validator.
 *
 * Companion to `scripts/scan-repeat-subcase-shapes.ts`. The scan reports
 * the affected apps + buckets; this migrator rewrites them.
 *
 * Per affected bucket:
 *
 *   1. Identify the FIRST field (in `fieldOrder` walk order) whose
 *      `case_property_on` points at the bucket's case type AND whose
 *      enclosing repeat ancestor matches the bucket.
 *   2. Rename that field's `id` to `case_name`.
 *
 * Safety preconditions, checked per rename and refusing on violation:
 *
 *   - **No sibling collision.** The renamed field's parent must not
 *     already have a sibling with id `case_name` — CommCare requires
 *     sibling ids to be unique; the check is parent-scoped, not global.
 *   - **No XPath token references.** No other field's
 *     `calculate` / `relevant` / `constraint` / `validate` /
 *     `default_value` / `required` / `hint` / `label` body may reference
 *     the source field's id as a bare token. The check uses a
 *     word-boundary regex, not the Lezer parser — false positives are
 *     acceptable (a refusal is safer than an auto-rewrite that breaks
 *     the form silently).
 *
 * Refusal skips the rename, leaves the blueprint untouched, and emits a
 * WARN row in the report so the operator can fix manually.
 *
 * Post-rename, `runValidation` runs on the rewritten blueprint and the
 * `CHILD_CASE_NO_NAME_FIELD` count is compared against the pre-rename
 * count. Failure to reduce is a programming bug and throws.
 *
 * Dry-run is the default — bare invocation reports what would change
 * without any Firestore write. Pass `--apply` to commit. The persistence
 * write goes through `ref.set(..., { merge: true })` with
 * `updated_at: FieldValue.serverTimestamp()`, matching `recover-app.ts`'s
 * pattern; the fail-closed list-query heuristic sees a fresh
 * `updated_at` so the migrated app isn't flagged as stalled.
 *
 * Usage:
 *
 *   npx tsx scripts/migrate-child-case-name-field.ts            # dry-run
 *   npx tsx scripts/migrate-child-case-name-field.ts --apply    # writes
 *   npx tsx scripts/migrate-child-case-name-field.ts --app <id> --apply
 */

import "dotenv/config";
import { FieldValue } from "@google-cloud/firestore";
import { Command } from "commander";
import { readFieldString } from "../lib/commcare/fieldProps";
import { runValidation } from "../lib/commcare/validator/runner";
import type { BlueprintDoc, Field, Uuid } from "../lib/domain";
import { db, hydrateBlueprint } from "./lib/firestore";
import { runMain } from "./lib/main";

/** XPath-bearing field properties scanned for stale-reference detection. */
const XPATH_PROPS = [
	"relevant",
	"validate",
	"calculate",
	"default_value",
	"required",
	"hint",
	"label",
] as const;

interface RenamePlan {
	readonly appId: string;
	readonly ownerEmail: string;
	readonly moduleName: string;
	readonly formName: string;
	readonly bucketCaseType: string;
	readonly bucketRepeatAncestorId: string | undefined;
	readonly fieldUuid: Uuid;
	readonly oldId: string;
}

interface SkipReason {
	readonly appId: string;
	readonly ownerEmail: string;
	readonly moduleName: string;
	readonly formName: string;
	readonly bucketCaseType: string;
	readonly bucketRepeatAncestorId: string | undefined;
	readonly reason: string;
}

/**
 * Walk one form and produce one rename plan per child-case bucket missing
 * `case_name`. The walker mirrors `deriveCaseConfig`'s bucketing (keyed
 * by `(case_type, repeat_ancestor)`) and picks the FIRST field per
 * bucket in field-order, matching the deleted silent fallback's
 * behavior.
 */
function planRenamesForForm(
	doc: BlueprintDoc,
	formUuid: Uuid,
	moduleCaseType: string | undefined,
	moduleName: string,
	formName: string,
	appId: string,
	ownerEmail: string,
): { plans: RenamePlan[]; skips: SkipReason[] } {
	if (!moduleCaseType) return { plans: [], skips: [] };

	interface Bucket {
		readonly caseType: string;
		readonly repeatAncestorId: string | undefined;
		readonly fields: Array<{ uuid: Uuid; field: Field }>;
	}
	const buckets = new Map<string, Bucket>();

	const walk = (parentUuid: Uuid, repeatAncestorId: string | undefined) => {
		for (const u of doc.fieldOrder[parentUuid] ?? []) {
			const f = doc.fields[u];
			if (!f) continue;
			const cpo = readFieldString(f, "case_property_on");
			if (cpo && cpo !== moduleCaseType) {
				const key = `${cpo}::${repeatAncestorId ?? "<root>"}`;
				const b = buckets.get(key) ?? {
					caseType: cpo,
					repeatAncestorId,
					fields: [],
				};
				b.fields.push({ uuid: u, field: f });
				buckets.set(key, b);
			}
			if (doc.fieldOrder[u] !== undefined) {
				walk(u, f.kind === "repeat" ? f.id : repeatAncestorId);
			}
		}
	};
	walk(formUuid, undefined);

	const plans: RenamePlan[] = [];
	const skips: SkipReason[] = [];

	for (const bucket of buckets.values()) {
		const hasCaseName = bucket.fields.some(
			({ field }) => field.id === "case_name",
		);
		if (hasCaseName) continue;
		if (bucket.fields.length === 0) continue;

		const first = bucket.fields[0];
		const oldId = first.field.id;

		// Sibling-collision check at the field's parent scope.
		const parent = doc.fieldParent?.[first.uuid] ?? formUuid;
		const siblingHasCaseName = (doc.fieldOrder[parent] ?? []).some(
			(sibUuid) =>
				sibUuid !== first.uuid && doc.fields[sibUuid]?.id === "case_name",
		);
		if (siblingHasCaseName) {
			skips.push({
				appId,
				ownerEmail,
				moduleName,
				formName,
				bucketCaseType: bucket.caseType,
				bucketRepeatAncestorId: bucket.repeatAncestorId,
				reason:
					'sibling "case_name" already exists at the target scope; manual fix needed (delete the sibling, or promote a different bucket field)',
			});
			continue;
		}

		// XPath token-reference check.
		const tokenRe = new RegExp(
			`(?:^|[^a-zA-Z0-9_])${escapeRegex(oldId)}(?:[^a-zA-Z0-9_]|$)`,
		);
		const xpathHits: string[] = [];
		for (const otherUuid of Object.keys(doc.fields)) {
			if (otherUuid === first.uuid) continue;
			const other = doc.fields[otherUuid];
			if (!other) continue;
			for (const prop of XPATH_PROPS) {
				const v = readFieldString(other, prop);
				if (!v) continue;
				if (tokenRe.test(v)) {
					xpathHits.push(`${other.id}.${prop}`);
					break;
				}
			}
		}
		if (xpathHits.length > 0) {
			skips.push({
				appId,
				ownerEmail,
				moduleName,
				formName,
				bucketCaseType: bucket.caseType,
				bucketRepeatAncestorId: bucket.repeatAncestorId,
				reason: `source id "${oldId}" is referenced as a bare token in: ${xpathHits.join(", ")}; rename would break those expressions, manual fix needed`,
			});
			continue;
		}

		plans.push({
			appId,
			ownerEmail,
			moduleName,
			formName,
			bucketCaseType: bucket.caseType,
			bucketRepeatAncestorId: bucket.repeatAncestorId,
			fieldUuid: first.uuid,
			oldId,
		});
	}

	return { plans, skips };
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Apply renames in-place on the hydrated blueprint. */
function applyRenames(
	doc: BlueprintDoc,
	plans: ReadonlyArray<RenamePlan>,
): void {
	for (const plan of plans) {
		const f = doc.fields[plan.fieldUuid];
		if (!f) {
			throw new Error(
				`rename target field ${plan.fieldUuid} disappeared between plan and apply — programming bug, the blueprint was mutated in between`,
			);
		}
		f.id = "case_name";
	}
}

async function main(): Promise<void> {
	const program = new Command()
		.name("migrate-child-case-name-field")
		.description(
			[
				"Promote the first field in every child-case bucket missing",
				"`case_name` to id `case_name`. Companion to scan-repeat-subcase-",
				"shapes.ts. Dry-run by default; --apply commits Firestore writes.",
			].join(" "),
		)
		.option("--apply", "commit writes (default: dry-run report only)", false)
		.option("--app <id>", "limit to one app id (default: scan all apps)")
		.parse(process.argv);
	const options = program.opts() as { apply: boolean; app?: string };

	const appsRef = db.collection("apps");
	const appsSnap = options.app
		? { docs: [await appsRef.doc(options.app).get()] }
		: await appsRef.get();

	let appsScanned = 0;
	let appsWithPlans = 0;
	let totalPlans = 0;
	let totalApplied = 0;
	const skips: SkipReason[] = [];

	for (const appSnap of appsSnap.docs) {
		if (!appSnap.exists) continue;
		const data = appSnap.data();
		if (!data) continue;
		appsScanned += 1;

		const ownerId = typeof data.owner === "string" ? data.owner : "";
		const ownerEmail = await resolveOwnerEmail(ownerId);

		const blueprint = data.blueprint;
		if (!blueprint || typeof blueprint !== "object") continue;

		let hydrated: BlueprintDoc;
		try {
			hydrated = hydrateBlueprint(blueprint);
		} catch {
			console.warn(`[skip] ${appSnap.id}: hydrate failed`);
			continue;
		}

		const appPlans: RenamePlan[] = [];
		for (const moduleUuid of hydrated.moduleOrder ?? []) {
			const mod = hydrated.modules[moduleUuid];
			if (!mod) continue;
			for (const formUuid of hydrated.formOrder[moduleUuid] ?? []) {
				const form = hydrated.forms[formUuid];
				if (!form) continue;
				const { plans, skips: formSkips } = planRenamesForForm(
					hydrated,
					formUuid,
					mod.caseType,
					mod.name ?? "<unnamed module>",
					form.name ?? "<unnamed form>",
					appSnap.id,
					ownerEmail,
				);
				appPlans.push(...plans);
				skips.push(...formSkips);
			}
		}

		if (appPlans.length === 0) continue;
		appsWithPlans += 1;
		totalPlans += appPlans.length;

		const errorsBefore = runValidation(hydrated).filter(
			(e) => e.code === "CHILD_CASE_NO_NAME_FIELD",
		).length;

		applyRenames(hydrated, appPlans);

		const errorsAfter = runValidation(hydrated).filter(
			(e) => e.code === "CHILD_CASE_NO_NAME_FIELD",
		).length;

		if (errorsAfter >= errorsBefore) {
			throw new Error(
				`app ${appSnap.id}: rename plan executed but CHILD_CASE_NO_NAME_FIELD count did not decrease (before=${errorsBefore} after=${errorsAfter}). Programming bug — the bucket / rename mapping is off.`,
			);
		}

		const verb = options.apply ? "APPLY" : "PLAN ";
		console.log(
			`[${verb}] ${appSnap.id} (${ownerEmail || "<no email>"}) — ${appPlans.length} rename(s); CHILD_CASE_NO_NAME_FIELD ${errorsBefore} → ${errorsAfter}`,
		);
		for (const p of appPlans) {
			const scope = p.bucketRepeatAncestorId
				? `inside repeat "${p.bucketRepeatAncestorId}"`
				: "at form root";
			console.log(
				`    ${p.moduleName} / ${p.formName} :: bucket ${p.bucketCaseType} ${scope}: rename "${p.oldId}" → "case_name"`,
			);
		}

		if (options.apply) {
			// Strip the derived `fieldParent` reverse index — the persisted
			// shape does not carry it, and Firestore would otherwise store it
			// as inert data.
			const { fieldParent: _drop, ...persisted } = hydrated as BlueprintDoc & {
				fieldParent?: unknown;
			};
			await appSnap.ref.set(
				{
					blueprint: persisted,
					updated_at: FieldValue.serverTimestamp(),
				},
				{ merge: true },
			);
			totalApplied += appPlans.length;
		}
	}

	for (const s of skips) {
		const scope = s.bucketRepeatAncestorId
			? `inside repeat "${s.bucketRepeatAncestorId}"`
			: "at form root";
		console.warn(
			`[SKIP ] ${s.appId} (${s.ownerEmail || "<no email>"}) — ${s.moduleName} / ${s.formName} :: bucket ${s.bucketCaseType} ${scope}: ${s.reason}`,
		);
	}

	console.error(
		`# scanned ${appsScanned} apps; ${appsWithPlans} app(s) had renamable buckets; ${totalPlans} plan(s) total; ${totalApplied} applied; ${skips.length} skip(s)`,
	);
	console.error(
		options.apply
			? "# --apply was set; writes committed"
			: "# dry-run (default); pass --apply to commit",
	);
}

/**
 * Resolve owner email from Better Auth's `auth_users` collection,
 * memoized — one read per distinct owner across the run.
 */
function makeOwnerEmailResolver(): (ownerId: string) => Promise<string> {
	const cache = new Map<string, string>();
	return async (ownerId: string): Promise<string> => {
		if (!ownerId) return "";
		const cached = cache.get(ownerId);
		if (cached !== undefined) return cached;
		let email = "";
		try {
			const snap = await db.collection("auth_users").doc(ownerId).get();
			const data = snap.data();
			email = data && typeof data.email === "string" ? data.email : "";
		} catch {
			email = "";
		}
		cache.set(ownerId, email);
		return email;
	};
}

const resolveOwnerEmail = makeOwnerEmailResolver();

runMain(main);
