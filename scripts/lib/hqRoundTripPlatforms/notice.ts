/**
 * The platforms cutover's notice entries (part 09 §12), from one app's
 * changes and its live deployments: step 4, `deployment-lines`, which writes
 * nothing and selects the lines each deployment gets, and the cut every
 * stored name takes.
 *
 * Names and details are authored content: they reach the notice row and the
 * plan's digest, never the report.
 */

import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { formEntrySyncReasons } from "@/lib/commcare/planPrivileges";
import { deploymentServerSchema } from "@/lib/deployment/types";
import { baselineWebApps } from "@/lib/deployment/webApps";
import type { BlueprintDoc } from "@/lib/domain";
import { entryPointInventory } from "@/lib/domain/entryPoints";
import { declaresWebApps } from "@/lib/domain/platforms";
import { asUuid } from "@/lib/domain/uuid";
import {
	type DeploymentNoticeEntry,
	type MigrationNoticeEntry,
	migrationNoticeEntriesSchema,
	NOTICE_TEXT_MAX,
} from "@/lib/notices/migrationNotice";

/**
 * A stored name cut to the length an entry keeps, between code points, with a
 * lone surrogate replaced so the row's JSON stays valid.
 */
export function noticeText(value: unknown): string {
	const text = typeof value === "string" ? value : "";
	let cut = "";
	for (const point of text) {
		const code = point.codePointAt(0) ?? 0;
		const whole = code >= 0xd800 && code <= 0xdfff ? "�" : point;
		if (cut.length + whole.length > NOTICE_TEXT_MAX) break;
		cut += whole;
	}
	return cut;
}

/** One app deployment's stored app baseline, as the fleet read selects it. */
export interface SourceBaseline {
	readonly origin: string;
	readonly sourceGzip: Buffer | null;
	readonly sourceDigest: string | null;
}

/** One deployment of an app with a live `app` mapping. */
export interface SourceDeployment {
	readonly deploymentId: string;
	readonly server: string;
	readonly domain: string;
	/** Null where the deployment holds no app baseline. */
	readonly baseline: SourceBaseline | null;
}

/**
 * The Web App setting a baseline says CommCare HQ holds, or undefined where
 * the baseline says nothing about it: an origin other than `push` or
 * `cutover` (a `create` baseline holds no content of Nova's, and an `unread`
 * one none at all), or a source that does not gunzip, verify or parse.
 */
export function heldWebApps(
	baseline: SourceBaseline | null,
): boolean | undefined {
	if (baseline === null) return undefined;
	if (baseline.origin !== "push" && baseline.origin !== "cutover")
		return undefined;
	if (baseline.sourceGzip === null || baseline.sourceDigest === null)
		return undefined;
	let text: Buffer;
	try {
		text = gunzipSync(baseline.sourceGzip);
	} catch {
		return undefined;
	}
	if (createHash("sha256").update(text).digest("hex") !== baseline.sourceDigest)
		return undefined;
	let source: unknown;
	try {
		source = JSON.parse(text.toString("utf8"));
	} catch {
		return undefined;
	}
	return baselineWebApps(source);
}

/**
 * Step 4, `deployment-lines`: the lines each live deployment of an app gets,
 * in deployment order, each deployment's lines in the order a publish meets
 * them. `changed` says whether the cutover writes the app, which moves its
 * sequence and so every entry point link's manifest.
 */
export function deploymentLines(
	target: BlueprintDoc,
	deployments: readonly SourceDeployment[],
	changed: boolean,
): DeploymentNoticeEntry[] {
	const webApps = declaresWebApps(target);
	const formEntrySync = formEntrySyncReasons(target).length > 0;
	const entryPoints = changed && entryPointInventory(target).length > 0;
	const entries: DeploymentNoticeEntry[] = [];
	for (const deployment of deployments) {
		const ref = {
			deploymentId: asUuid(deployment.deploymentId),
			server: deploymentServerSchema.parse(deployment.server),
			domain: deployment.domain,
		};
		if (entryPoints) {
			entries.push({
				kind: "deployment",
				reason: "deep-links-need-republish",
				deployment: ref,
			});
		}
		const held = heldWebApps(deployment.baseline);
		if (held !== undefined && held !== webApps) {
			entries.push({
				kind: "deployment",
				reason: "next-publish-asks-web-apps",
				deployment: ref,
				detail: { to: webApps ? "on" : "off" },
			});
		}
		if (webApps || formEntrySync) {
			entries.push({
				kind: "deployment",
				reason: "next-publish-asks-more",
				deployment: ref,
				detail: {
					...(webApps && { planFeatures: "web-apps" }),
					...(formEntrySync && { settings: "form-entry-sync-off" }),
				},
			});
		}
	}
	return entries;
}

/**
 * One app's notice entries as the writer stores them: its deployment lines,
 * then its document lines in step order, parsed by the row's own schema.
 * Empty where the app gets no notice row. Every surface orders a notice's
 * entries again by the reason lists when it shows them.
 */
export function appNoticeEntries(
	deployments: readonly DeploymentNoticeEntry[],
	documents: readonly MigrationNoticeEntry[],
): readonly MigrationNoticeEntry[] {
	const entries = [...deployments, ...documents];
	if (entries.length === 0) return [];
	return migrationNoticeEntriesSchema.parse(entries);
}
