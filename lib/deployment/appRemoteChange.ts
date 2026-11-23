/**
 * The app's drift verdict at preflight: CommCare HQ's read against the
 * baseline, with the files the next import removes, as one
 * `DeploymentRemoteChange`. Server-side: it digests the read and the files
 * (`hqSourceBaseline.ts`), which `remoteChanges.ts`, the client-safe words
 * of every change, never imports as values.
 */

import type { DriftReference } from "@/lib/publish/driftReference";
import { REQUIRED_FIRST_PUBLISH_RECOVERY } from "@/lib/publish/hqChangesCopy";
import {
	type appConfirmationScope,
	diffHqAppSource,
	hqDiscardDigest,
	removedHqFileLine,
	removedHqFileReplaced,
	removedHqFiles,
	unapprovedHqFiles,
} from "./hqSourceBaseline";
import {
	boundedParts,
	describeAppChange,
	fileDisclosureTruncated,
} from "./remoteChanges";
import type {
	AppBaseline,
	DeploymentRemoteChange,
	RemoteChangeDiscard,
} from "./types";

/**
 * The app's change since its baseline, or null when nothing it writes
 * differs. Observed as the digest of the whole normalized read, so a person
 * confirms exactly the state Nova read, known baseline or not.
 */
export function appRemoteChange(input: {
	/** Whether this publish replaces Android requirements CommCare HQ holds that Nova's baseline does not own. */
	readonly replacesUnownedAndroidRequirements?: boolean;
	readonly authority: ReturnType<typeof appConfirmationScope>;
	/** The app's automatic-location line, when the target holds the other value
	 * and its baseline predates Nova owning that switch. */
	readonly locationChange?: string;
	/** A completed review may disclose a removal the shorter publish preview cannot show. */
	readonly discards?: readonly RemoteChangeDiscard[];
	readonly appName: string;
	readonly novaAppId: string;
	readonly remoteAppId: string;
	readonly current: { readonly normalized: unknown; readonly digest: string };
	readonly baseline:
		| (Pick<
				AppBaseline,
				| "mediaFiles"
				| "approvedFileRemovals"
				| "firstPublishReview"
				| "unverifiedNextChanges"
		  > &
				(
					| { readonly origin: "unread" }
					| Pick<
							Exclude<AppBaseline, { origin: "unread" }>,
							"origin" | "source" | "ownership"
					  >
				))
		| null;
	/** What the baseline is: a publish's read, or the read Nova brought the app in from. */
	readonly since: DriftReference;
	readonly languageNames: "nova" | "target";
	/** How many files this publish sends CommCare HQ holds another file in place of. */
	readonly mediaChanged: number;
	readonly published: readonly { readonly wirePath: string }[];
	/** Whether the deployment has a usable pair (`hqChanges/reference.ts::usablePair`). */
	readonly canBringIn: boolean;
}): DeploymentRemoteChange | null {
	const { baseline } = input;
	const files = {
		published: input.published,
		recorded: baseline?.mediaFiles ?? null,
	};
	const removed = unapprovedHqFiles(
		removedHqFiles(input.current.normalized, files),
		baseline?.approvedFileRemovals,
	);
	/* The reading the person last accepted, where Nova holds one. */
	const earlier =
		baseline !== null && baseline.origin !== "unread" ? baseline.source : null;
	const lines = removed.map((file) =>
		removedHqFileLine(file, removedHqFileReplaced(file, earlier)),
	);
	const change = (
		parts: readonly string[],
		baselineKnown: boolean,
	): DeploymentRemoteChange => {
		const full = [...lines, ...parts];
		const shown = boundedParts(full);
		const truncated = fileDisclosureTruncated(lines.length, parts.length);
		const complete = hqDiscardDigest(
			input.authority,
			input.current.digest,
			removed,
			"complete",
		);
		const reviewed = input.discards?.some(
			(discard) =>
				discard.kind === "app" &&
				discard.novaResourceId === input.novaAppId &&
				discard.observedDigest === complete,
		);
		const needsReview = truncated && !reviewed;
		return {
			kind: "app",
			novaResourceId: input.novaAppId,
			name: input.appName,
			identity: input.remoteAppId,
			parts: shown,
			...(needsReview && { requiresReview: true }),
			note: needsReview
				? input.canBringIn
					? "You can review the complete list of files before publishing here."
					: REQUIRED_FIRST_PUBLISH_RECOVERY
				: null,
			observedDigest: reviewed
				? complete
				: hqDiscardDigest(input.authority, input.current.digest, removed),
			baselineKnown,
			since: input.since,
			canBringIn: baselineKnown && input.canBringIn,
		};
	};
	if (baseline?.firstPublishReview === "required") {
		return {
			...change(
				[
					baseline.unverifiedNextChanges
						? "You can review what the next publish would change in this project space."
						: "You can review what the first publish would change in this project space.",
				],
				baseline.origin !== "unread",
			),
			requiresReview: true,
			note: input.canBringIn
				? "You can review changes from CommCare HQ before publishing here."
				: `Nova cannot verify the previous reading. ${REQUIRED_FIRST_PUBLISH_RECOVERY}`,
		};
	}
	if (baseline === null || baseline.origin === "unread") {
		return change(input.locationChange ? [input.locationChange] : [], false);
	}
	const parts = diffHqAppSource({
		baseline: baseline.source,
		current: input.current.normalized,
		ownership: baseline.ownership,
		shell: baseline.origin === "create",
		languageNames: input.languageNames,
		mediaChanged: input.mediaChanged,
	});
	const descriptions = parts.map(describeAppChange);
	if (
		!baseline.ownership.profileFeatures?.includes("dependencies") &&
		input.replacesUnownedAndroidRequirements
	) {
		descriptions.push("Required Android apps already selected in CommCare HQ");
	}
	if (input.locationChange !== undefined)
		descriptions.unshift(input.locationChange);
	return descriptions.length === 0 && removed.length === 0
		? null
		: change(descriptions, true);
}
