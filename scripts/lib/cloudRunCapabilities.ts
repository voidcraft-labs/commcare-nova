/**
 * The Cloud Run half of the activation preflight: which revisions actually
 * receive traffic right now, and what capability each one declares.
 *
 * A compatibility floor is a linearizable cutoff for the whole fleet, so it may
 * only rise past revisions that can honor it. Everything here is therefore
 * fail-closed: an unlabeled, malformed, or unlisted revision reads as capability
 * v0 or throws rather than being assumed compatible.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
// Type-only: `rolloutCompatibility` carries the `server-only` marker, and this
// module loads under plain tsx.
import type { ReceivingRevisionCapability } from "@/lib/db/rolloutCompatibility";
import { parseRevisionCapabilityLabels } from "@/lib/runtimeCapabilities";

const execFileAsync = promisify(execFile);

/** gcloud's Knative-shaped projections, narrowed to the fields consumed here. */
interface ServiceDescription {
	readonly status?: {
		readonly latestReadyRevisionName?: unknown;
		readonly traffic?: unknown;
	};
}

interface RevisionDescription {
	readonly metadata?: {
		readonly name?: unknown;
		readonly labels?: unknown;
	};
}

export interface CloudRunTarget {
	readonly service: string;
	readonly region: string;
}

function requireArray(value: unknown, what: string): readonly unknown[] {
	if (!Array.isArray(value)) {
		throw new Error(`Cloud Run ${what} is missing or not a list.`);
	}
	return value;
}

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

/**
 * Resolve the traffic split to concrete revision names. A `latestRevision`
 * target names no revision of its own, so it resolves through the service's
 * latest READY revision — the one Cloud Run is actually serving.
 *
 * A tagged target is included even at zero percent: its tag URL serves real
 * requests, so its reader must survive the cutoff like any other.
 */
export function receivingRevisionNames(
	service: ServiceDescription,
): readonly string[] {
	const traffic = requireArray(service.status?.traffic, "traffic split");
	const latestReady = service.status?.latestReadyRevisionName;
	const names = new Set<string>();
	for (const entry of traffic) {
		const target = record(entry);
		const percent = typeof target.percent === "number" ? target.percent : 0;
		const tag = typeof target.tag === "string" ? target.tag : "";
		if (percent <= 0 && tag.length === 0) continue;

		const named =
			target.latestRevision === true
				? latestReady
				: (target.revisionName ?? latestReady);
		if (typeof named !== "string" || named.length === 0) {
			throw new Error(
				"A Cloud Run traffic target resolves to no revision name.",
			);
		}
		names.add(named);
	}
	if (names.size === 0) {
		throw new Error("Cloud Run reports no traffic-receiving revision.");
	}
	return [...names].sort();
}

/**
 * Join the traffic split to declared labels. Reading the revision list BEFORE
 * the split is deliberate: a revision that starts taking traffic between the
 * two reads is then absent from the list and throws, whereas the opposite
 * order would leave it silently unexamined.
 */
export function receivingRevisionCapabilities(
	revisions: readonly RevisionDescription[],
	service: ServiceDescription,
): readonly ReceivingRevisionCapability[] {
	const labelsByRevision = new Map<string, unknown>();
	for (const revision of revisions) {
		const name = revision.metadata?.name;
		if (typeof name === "string" && name.length > 0) {
			labelsByRevision.set(name, revision.metadata?.labels);
		}
	}

	return receivingRevisionNames(service).map((revision) => {
		if (!labelsByRevision.has(revision)) {
			throw new Error(
				`Cloud Run revision ${revision} receives traffic but was not listed; re-read the control plane.`,
			);
		}
		return {
			revision,
			runtimeReaderVersion: parseRevisionCapabilityLabels(
				labelsByRevision.get(revision),
			).runtimeReaderVersion,
		};
	});
}

async function gcloudJson(args: readonly string[]): Promise<unknown> {
	let stdout: string;
	try {
		({ stdout } = await execFileAsync("gcloud", [...args, "--format=json"], {
			maxBuffer: 32 * 1024 * 1024,
		}));
	} catch (error) {
		throw new Error(
			`gcloud ${args.join(" ")} failed. Cloud Run reads need a current CLI credential — run \`gcloud auth login\` and retry.`,
			{ cause: error },
		);
	}
	try {
		return JSON.parse(stdout);
	} catch (error) {
		throw new Error(`gcloud ${args.join(" ")} returned non-JSON output.`, {
			cause: error,
		});
	}
}

/**
 * A `ReadReceivingRevisionCapabilities` over the live control plane. Every call
 * performs its own pair of reads — the compatibility service invokes this only
 * after it owns the cutover gate, and a cached split would defeat that.
 */
export function readCloudRunCapabilities(
	target: CloudRunTarget,
): () => Promise<readonly ReceivingRevisionCapability[]> {
	return async () => {
		const revisions = requireArray(
			await gcloudJson([
				"run",
				"revisions",
				"list",
				`--service=${target.service}`,
				`--region=${target.region}`,
			]),
			"revision list",
		) as readonly RevisionDescription[];
		const service = (await gcloudJson([
			"run",
			"services",
			"describe",
			target.service,
			`--region=${target.region}`,
		])) as ServiceDescription;
		return receivingRevisionCapabilities(revisions, service);
	};
}
