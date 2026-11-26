import "server-only";

import {
	isValidDomainSlug,
	probeHqProjectSpaceCompatibility,
} from "@/lib/commcare/client";
import { hqNestedSelectionFindings } from "@/lib/commcare/hqNestedSelection";
import { planLanguageWire } from "@/lib/commcare/languageWire";
import { projectSpaceCompatibilityProbePlan } from "@/lib/commcare/projectSpaceCompatibility";
import type { RuntimeTarget } from "@/lib/commcare/runtimeTarget";
import type { CommCareServer } from "@/lib/commcare/servers";
import type { TargetFacts } from "@/lib/commcare/targetFacts";
import {
	targetWireIdentity,
	type WireIdentity,
} from "@/lib/commcare/wireIdentity";
import { getHqCredentials } from "@/lib/db/settings";
import { userFacingError } from "@/lib/doc/userFacingErrors";
import {
	type BlueprintDoc,
	declaresAndroid,
	effectiveAppLocalization,
} from "@/lib/domain";
import type { MediaAssetId } from "@/lib/domain/multimedia";
import { projectSearchDependencies } from "@/lib/domain/projectSearches";
import type { Uuid } from "@/lib/domain/uuid";
import type {
	AttachmentTargetState,
	KeptAdvisoryFacts,
} from "@/lib/publish/exportAdvisories";
import type { ProjectSpaceCompatibilityReport } from "@/lib/publish/projectSpaceCompatibility";
import {
	type AttachmentUrlTarget,
	attachmentUrlTarget,
} from "./attachmentTarget";
import { exportTargetRevision } from "./exportTargetRevision";
import {
	type CczUnavailable,
	cczUnavailableRefusal,
	chooseDownloadTarget,
	type DownloadTargetRefusal,
	type ReachedDeploymentTarget,
	workersSentElsewhere,
} from "./runtimeTarget";
import {
	type DeploymentReadSnapshot,
	type DeploymentScope,
	type DeploymentTargetKey,
	type HeldTargetFacts,
	holdTargetFacts,
	readReachedDeploymentTargets,
	readTargetIdentity,
	targetFactsOf,
	withDeploymentReadSnapshot,
} from "./store";
import { keptAdvisoryFacts } from "./targetFacts";
import { exportIdentityOf, sameTargetIdentity } from "./targetIdentity";

/**
 * What a download is made for, read from the app's deployments.
 *
 * Its own module rather than a member of `service.ts`, as `previewSpace.ts`
 * is: the compile routes and the publish dialog's action ask one question
 * of the ledger and should not take the publish lifecycle's expander, media
 * bundler and HQ client into their import graph to do it.
 */
export type DownloadTarget = { readonly targetRevision?: string } & (
	| {
			readonly format: "ccz";
			/** The deployment the archive is made for. */
			readonly target: ReachedDeploymentTarget;
			readonly runtimeTarget: RuntimeTarget;
			/** That deployment's overrides over the derivation. */
			readonly identity: WireIdentity;
			/**
			 * The path CommCare HQ keeps each media file under on that project
			 * space, by asset; empty where it holds none, so every file takes
			 * Nova's own path.
			 */
			readonly mediaPaths: ReadonlyMap<MediaAssetId, string>;
			/**
			 * The id prefix each keyed create's cases stand under there, by
			 * operation, for the operations that still create that type; empty
			 * where it holds none.
			 */
			readonly keyedCaseIdPrefixes: ReadonlyMap<Uuid, string>;
			readonly attachmentTarget: AttachmentUrlTarget;
			readonly reached: readonly ReachedDeploymentTarget[];
			/**
			 * What that project space keeps of the values Nova leaves to
			 * CommCare HQ, read from the deployment's baseline; null where
			 * there is none to read.
			 */
			readonly targetFacts: TargetFacts | null;
	  }
	| {
			readonly format: "json";
			readonly identity?: WireIdentity;
			readonly attachmentTarget: AttachmentUrlTarget | null;
			/** The reached deployments on the chosen server, or all of them. */
			readonly reached: readonly ReachedDeploymentTarget[];
	  }
) & { readonly compatibility?: ProjectSpaceCompatibilityReport };

export type { DownloadTargetRefusal };

/**
 * Whether the download's attachment links name a project space, and if not
 * why: no project space holds the app on the chosen server, or several do.
 */
export function downloadAttachmentState(
	download: DownloadTarget,
): AttachmentTargetState {
	if (download.attachmentTarget !== null) return "known";
	return download.reached.length > 1 ? "ambiguous" : "none";
}

/** One line per selection of `doc` that CommCare HQ cannot take, in the builder's words. */
export function selectionsHeldFromHq(doc: BlueprintDoc): string[] {
	/* Called without lookup naming, so the answer reads which menu's
	 * selection feeds which and never a table's name or rows. */
	return hqNestedSelectionFindings(doc, "hq-upload").map(userFacingError);
}

/** Whether a `.ccz` can be made for one project space this app is published to. */
export interface CczStanding {
	/**
	 * What that project space keeps of the values Nova leaves to CommCare HQ,
	 * read from the deployment's baseline; null where there is none to read.
	 */
	readonly targetFacts: TargetFacts | null;
	/** Why it has no `.ccz`; null where one can be made. */
	readonly unavailable: CczUnavailable | null;
}

/**
 * Whether a `.ccz` can be made for `target`, from what Nova holds of that
 * project space and nothing it asks CommCare HQ: the facts its baseline
 * keeps, read inside the caller's snapshot (`store.ts::holdTargetFacts`) and
 * projected here, once that snapshot has given its connection back. The one
 * answer both the download and the publish dialog's list read, so the list
 * never offers a space the download refuses. Where the baseline is absent or
 * unread there are no facts, the space is offered, and the download made
 * from it reads the facts again when it is made.
 */
export function cczStandingOf(
	target: DeploymentTargetKey,
	held: HeldTargetFacts,
): CczStanding {
	const targetFacts = targetFactsOf(held);
	return {
		targetFacts,
		unavailable: workersSentElsewhere(
			target,
			targetFacts?.customBaseUrl ?? null,
		),
	};
}

/**
 * Resolve the project space a download is made for.
 *
 * A read that faults throws rather than answering "no target": a download
 * that silently lost its target would send its forms nowhere and drop a
 * case write from its attachment links. An export is a deliberate action
 * the person can repeat, so failing it and saying so is the honest answer.
 *
 * Everything it reads of the app's deployments (the targets, the chosen
 * one's identity record and its facts' bytes) comes from one authorized
 * snapshot (`store.ts::withDeploymentReadSnapshot`), one statement after
 * another on one connection: a stop or a Project move that commits during a
 * download is wholly before it (not found, or no reached target) or wholly
 * after it, never the old HQ app with derived ids or another Project's
 * facts. The facts are projected from those bytes once the snapshot has
 * given its connection back, which reads nothing more.
 */
export async function resolveDownloadTarget(
	scope: DeploymentScope,
	input: {
		readonly format: "ccz" | "json";
		readonly server?: CommCareServer;
		readonly domain?: string;
		readonly assignmentDestination?: DeploymentTargetKey;
		readonly compiledAtSeq?: number;
		readonly doc: BlueprintDoc;
	},
): Promise<DownloadTarget | DownloadTargetRefusal> {
	const searches = projectSearchDependencies(input.doc);
	const readDestination = (requireCurrentHead: boolean) =>
		withDeploymentReadSnapshot(scope, "view", async (snapshot) => {
			if (requireCurrentHead) {
				const head = await snapshot.db
					.selectFrom("apps")
					.select("mutation_seq")
					.where("id", "=", scope.appId)
					.where("project_id", "=", scope.projectId)
					.executeTakeFirstOrThrow();
				if (head.mutation_seq !== input.compiledAtSeq) return null;
			}
			return {
				read: await resolveDownloadTargetIn(snapshot, input, searches.size > 0),
				targetRevision: await exportTargetRevision(
					snapshot.db,
					scope.projectId,
					scope.appId,
				),
			};
		});
	const snapshot = await readDestination(false);
	if (snapshot === null)
		throw new Error("Expected a download destination snapshot.");
	let { read } = snapshot;
	const { targetRevision } = snapshot;
	if ("kind" in read) return read;
	let compatibility: ProjectSpaceCompatibilityReport | undefined;
	if (searches.size) {
		if (!("targetIdentity" in read))
			throw new Error("The search has no destination.");
		const original = read;
		const refusal = (message: string): DownloadTargetRefusal => ({
			kind: "refused",
			reason: "project-search-target",
			message,
			reached: original.reached,
			heldFromHq: [],
		});
		if (input.compiledAtSeq === undefined)
			return refusal(
				"Reopen the current app before downloading it for this project space.",
			);
		const bound = new Set(
			read.targetIdentity.projectSearches?.map((row) => row.searchUuid),
		);
		const missing = Array.from(searches).filter(([uuid]) => !bound.has(uuid));
		if (missing.length)
			return refusal(
				`Choose the search ID in ${read.target.domain} for ${missing.map(([, name]) => `“${name}”`).join(", ")} before downloading this app.`,
			);
		const credentials = await getHqCredentials(
			scope.actorUserId,
			read.target.domain,
		);
		if (
			!credentials.ok ||
			credentials.creds.server !== read.target.server ||
			credentials.domain.name !== read.target.domain
		)
			return refusal(
				`Connect an account that can check searches in ${read.target.domain}, then download the file again.`,
			);
		const plan = projectSpaceCompatibilityProbePlan(input.doc);
		const checked = await probeHqProjectSpaceCompatibility(
			credentials.creds,
			read.target.domain,
			plan,
		);
		compatibility = checked.report;
		if (
			compatibility.required_capabilities.find(
				(row) => row.id === "project-search",
			)?.state !== "available"
		)
			return refusal(
				`Nova couldn't confirm that ${read.target.domain} supports searches supplied by the project space. Check access and search settings there, then try again.`,
			);
		const checkedSnapshot = await readDestination(true);
		const current = checkedSnapshot?.read;
		if (
			current === undefined ||
			checkedSnapshot?.targetRevision !== targetRevision ||
			!("targetIdentity" in current) ||
			!sameTargetIdentity(original.targetIdentity, current.targetIdentity) ||
			(!("jsonTarget" in original) &&
				("jsonTarget" in current ||
					original.target.hqAppId !== current.target.hqAppId))
		) {
			return refusal(
				"The app or its destination changed while Nova checked its searches. Review the connections and download again.",
			);
		}
		read = current;
	}
	if ("jsonTarget" in read)
		return {
			// The HQ file still installs a new copy. Only this service ID
			// belongs to the selected space. Menu/form IDs, media and case-key
			// prefixes keep the manual import contract.
			format: "json",
			identity: targetWireIdentity(
				[],
				[],
				read.targetIdentity.projectSearches ?? [],
			),
			attachmentTarget: attachmentUrlTarget(read.target),
			reached: read.reached,
			targetRevision,
			...(compatibility && { compatibility }),
		};
	if (!("held" in read)) return { ...read, targetRevision };
	const { target, reached, targetIdentity, held } = read;
	const standing = cczStandingOf(target, held);
	if (standing.unavailable !== null) {
		return cczUnavailableRefusal(target, standing.unavailable, reached);
	}
	/* What the publish prints under for this project space, so the archive
	 * names every form, keyed create and file as CommCare HQ keeps it there. */
	const exported = exportIdentityOf(input.doc, targetIdentity);
	return {
		format: "ccz",
		targetRevision,
		...(compatibility && { compatibility }),
		target,
		runtimeTarget: {
			server: target.server,
			domain: target.domain,
			appId: target.hqAppId,
		},
		identity: exported.identity,
		mediaPaths: exported.heldMediaPaths,
		keyedCaseIdPrefixes: exported.keyedCaseIdPrefixes,
		attachmentTarget: attachmentUrlTarget(target),
		reached,
		targetFacts: standing.targetFacts,
	};
}

/** A `.ccz`'s project space as the snapshot read it, its facts not yet projected. */
interface HeldCczTarget {
	readonly held: HeldTargetFacts;
	readonly target: ReachedDeploymentTarget;
	readonly reached: readonly ReachedDeploymentTarget[];
	readonly targetIdentity: Awaited<ReturnType<typeof readTargetIdentity>>;
}

interface TargetedImport {
	readonly jsonTarget: true;
	readonly target: DeploymentTargetKey;
	readonly reached: readonly ReachedDeploymentTarget[];
	readonly targetIdentity: Awaited<ReturnType<typeof readTargetIdentity>>;
}

async function resolveDownloadTargetIn(
	snapshot: DeploymentReadSnapshot,
	input: {
		readonly format: "ccz" | "json";
		readonly server?: CommCareServer;
		readonly domain?: string;
		readonly assignmentDestination?: DeploymentTargetKey;
		readonly doc: BlueprintDoc;
	},
	requiresProjectSearch: boolean,
): Promise<
	DownloadTarget | DownloadTargetRefusal | HeldCczTarget | TargetedImport
> {
	const { format, doc } = input;
	const server = input.assignmentDestination?.server ?? input.server;
	const domain = input.assignmentDestination?.domain ?? input.domain;
	const reached = await readReachedDeploymentTargets(snapshot);
	if (requiresProjectSearch) {
		if (
			server === undefined ||
			domain === undefined ||
			!isValidDomainSlug(domain)
		)
			return {
				kind: "refused",
				reason: "project-search-target",
				message:
					"Choose the server and project space whose searches this app will use.",
				reached,
				heldFromHq: [],
			};
		if (format === "json") {
			const target = { server, domain };
			return {
				jsonTarget: true,
				target,
				reached,
				targetIdentity: await readTargetIdentity(snapshot, target),
			};
		}
	}
	const heldFromHq =
		format === "ccz" && reached.length === 0 ? selectionsHeldFromHq(doc) : [];
	const choice = chooseDownloadTarget(reached, {
		format,
		...(server !== undefined && { server }),
		...(domain !== undefined && { domain }),
		heldFromHq,
		declaresAndroid: declaresAndroid(doc),
	});
	if (choice.kind === "refused") return choice;
	if (format === "json") {
		return {
			format,
			attachmentTarget: input.assignmentDestination
				? attachmentUrlTarget(input.assignmentDestination)
				: choice.kind === "project-space"
					? attachmentUrlTarget(choice.target)
					: null,
			reached: reached.filter(
				(target) => server === undefined || target.server === server,
			),
		};
	}
	if (choice.kind !== "project-space") {
		throw new Error(
			"A CCZ is always made for one project space, and the choice named none.",
		);
	}
	const { target } = choice;
	return {
		held: await holdTargetFacts(snapshot, target),
		target,
		reached,
		targetIdentity: await readTargetIdentity(snapshot, target),
	};
}

/**
 * What a download says it cannot follow of the values its project space
 * keeps: for a `.ccz` made for a project space whose baseline was read, its
 * facts over the app's languages, by the codes the archive writes, with the
 * wording and the settings the facts leave out because a file cannot carry
 * them as they are stored; for a
 * `.ccz` with none, the language names alone where Nova brought the app in
 * (CommCare HQ names its languages there, and the archive writes Nova's
 * names, having read none of HQ's); for any other `.ccz` with none, and for
 * the HQ import file, which is made for no project space, nothing.
 */
export function downloadKeptAdvisoryFacts(
	download: DownloadTarget,
	doc: BlueprintDoc,
): KeptAdvisoryFacts | null {
	if (download.format !== "ccz") return null;
	if (download.targetFacts === null) {
		return download.target.adopted
			? {
					uiTextFallsBack: false,
					uiTextNotCarried: false,
					profileNotCarried: false,
					androidLogos: false,
					practiceWorker: false,
					languageNames: true,
				}
			: null;
	}
	return keptAdvisoryFacts(
		download.targetFacts,
		planLanguageWire(effectiveAppLocalization(doc.localization)).languages,
	);
}
