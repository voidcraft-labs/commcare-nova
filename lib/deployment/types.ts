// lib/deployment/types.ts
//
// The public shapes of a deployment: one app, published to one CommCare HQ
// project space, tracked over time.
//
// Kept import-light so client surfaces can bind against these without
// pulling the server-only HQ client or the persistence layer into a bundle.
//
// A deployment is durable TARGET state. It is not a second Blueprint, a
// draft document, or a release flag on the app: the app is always exactly
// one valid document, and this records what a particular HQ domain
// currently holds of it.

import { z } from "zod";
import {
	COMMCARE_SERVER_IDS,
	COMMCARE_SERVERS,
	type CommCareServer,
} from "@/lib/commcare/servers";

export type { CommCareServer } from "@/lib/commcare/servers";

/**
 * Every state a deployment can be in.
 *
 * The five progress states are ordered and each one means something a
 * person can check on CommCare HQ. `incomplete` is the refusal: it is
 * reachable from any progress state, and while a deployment sits there
 * Nova withholds both `released` and `runnable` rather than reporting a
 * partial success as a whole one.
 */
export const DEPLOYMENT_STATES = [
	"preflight",
	"resources",
	"uploaded",
	"built",
	"released",
	"runnable",
	"incomplete",
] as const;
export type DeploymentState = (typeof DEPLOYMENT_STATES)[number];

/**
 * The ordered states a deployment advances through. `incomplete` is
 * deliberately absent: it is a refusal, not a rung on the ladder, which is
 * why a failed deployment records the phase it must retry rather than
 * pretending to hold a position on this list.
 */
export const DEPLOYMENT_PROGRESS_STATES = [
	"preflight",
	"resources",
	"uploaded",
	"built",
	"released",
	"runnable",
] as const;
export type DeploymentProgressState =
	(typeof DEPLOYMENT_PROGRESS_STATES)[number];

/**
 * One independently retryable unit of work.
 *
 * Nova drives the first two and only observes the last three. That split
 * is forced by CommCare HQ, not chosen: `import_app_api` accepts an API
 * key (`app_import_api.py::import_app_api` passes
 * `login_decorator=api_auth()`), while making a build
 * (`views/releases.py::save_copy`) and releasing one
 * (`views/releases.py::release_build`) both go through
 * `require_can_edit_apps`, which is `require_permission(HqPermissions.edit_apps)`
 * with `login_and_domain_required`: a browser session and nothing else.
 * So a person makes the build and releases it in CommCare HQ, and Nova
 * reports what it can see.
 */
export const DEPLOYMENT_PHASES = [
	"preflight",
	"resources",
	"upload",
	"build",
	"release",
	"probe",
] as const;
export type DeploymentPhase = (typeof DEPLOYMENT_PHASES)[number];

/**
 * The phases a person's click actually DRIVES.
 *
 * Nova performs these; it only asks CommCare HQ about the rest. The
 * distinction is not cosmetic: a driven phase's failure belongs to the
 * attempt (this key, this draft, this moment) and must not rewrite what
 * the project space already holds, which is exactly the rule
 * `applyAttemptOutcome` enforces. An observed phase's answer is about the
 * target and folds unconditionally.
 */
export const DRIVEN_DEPLOYMENT_PHASES = [
	"preflight",
	"resources",
	"upload",
] as const;
export type DrivenDeploymentPhase = (typeof DRIVEN_DEPLOYMENT_PHASES)[number];

/** The state a phase runs from. */
export const DEPLOYMENT_PHASE_ENTRY_STATE: Readonly<
	Record<DeploymentPhase, DeploymentProgressState>
> = {
	preflight: "preflight",
	resources: "preflight",
	upload: "resources",
	build: "uploaded",
	release: "built",
	probe: "released",
};

/** The state a phase produces when it succeeds. */
export const DEPLOYMENT_PHASE_SUCCESS_STATE: Readonly<
	Record<DeploymentPhase, DeploymentProgressState>
> = {
	preflight: "preflight",
	resources: "resources",
	upload: "uploaded",
	build: "built",
	release: "released",
	probe: "runnable",
};

/**
 * The phase whose success PRODUCES each progress state: the inverse of
 * `DEPLOYMENT_PHASE_SUCCESS_STATE`. The ladder and the display predicate
 * both need it, and each keeping its own copy is how the two would drift.
 */
export const DEPLOYMENT_STATE_PRODUCING_PHASE: Readonly<
	Record<DeploymentProgressState, DeploymentPhase>
> = {
	preflight: "preflight",
	resources: "resources",
	uploaded: "upload",
	built: "build",
	released: "release",
	runnable: "probe",
};

/**
 * Why a phase stopped.
 *
 * Closed, because every arm has a distinct person-facing recovery and a
 * caller that guesses from a message string will get one of them wrong.
 */
export const DEPLOYMENT_FAILURE_CODES = [
	/** No CommCare HQ connection, or the stored key no longer works. */
	"hq_not_connected",
	/** The key cannot reach the project space this deployment targets. */
	"domain_not_authorized",
	/** The app itself has findings that must be fixed before it can go out. */
	"app_not_ready",
	/**
	 * CommCare HQ would not say what the target already holds, so Nova
	 * stopped rather than push over something it cannot account for.
	 */
	"hq_resource_state_unknown",
	/**
	 * The target already holds a resource under a name this app needs, and
	 * Nova did not create it. Nova never takes one over on its own.
	 */
	"hq_resource_conflict",
	/**
	 * The app's organization does not fit the levels the target defines,
	 * so CommCare HQ would refuse the places rather than hold them. Its
	 * own recovery: change the tree in Nova, or the levels over there.
	 */
	"hq_organization_mismatch",
	/** CommCare HQ refused one of the resources this app needs. */
	"hq_rejected_resource_push",
	/** CommCare HQ refused the upload. */
	"hq_rejected_upload",
	/** The app Nova published is no longer on the target project space. */
	"remote_app_missing",
	/** The released build did not serve the profile a device installs from. */
	"build_not_installable",
] as const;
export type DeploymentFailureCode = (typeof DEPLOYMENT_FAILURE_CODES)[number];

/**
 * A phase failure, written the way a person reads it: what Nova tried,
 * what went wrong, and what to look at. `details` carries the individual
 * app findings when the app itself is what stopped it.
 */
export interface DeploymentFailure {
	readonly code: DeploymentFailureCode;
	readonly message: string;
	readonly details: readonly string[];
}

/**
 * What happened the last time a phase ran.
 *
 * `pending` is a first-class answer, not a soft failure: "CommCare HQ has
 * no build of this app yet" is the normal state of a freshly uploaded app,
 * and recording it as a failure would put a deployment into `incomplete`
 * for doing exactly what it should.
 */
export type DeploymentPhaseOutcome =
	| { readonly status: "succeeded"; readonly at: string }
	| { readonly status: "pending"; readonly at: string; readonly reason: string }
	| {
			readonly status: "failed";
			readonly at: string;
			readonly failure: DeploymentFailure;
	  };

/** Per-phase history. A phase that has never run is `null`. */
export type DeploymentPhaseOutcomes = Readonly<
	Record<DeploymentPhase, DeploymentPhaseOutcome | null>
>;

/**
 * Why THIS publish attempt did not land.
 *
 * Deliberately separate from the record: the record describes the TARGET,
 * and an attempt a person's own expired key refused says nothing about
 * what the project space holds. Reading "which failure stopped me just
 * now" out of the durable phase history is how a stale failure from last
 * week ends up explaining today's refusal, so the attempt carries its own
 * answer instead.
 */
export interface DeploymentAttemptRefusal {
	/** The phase this attempt stopped in. Publishing drives only these three. */
	readonly phase: DrivenDeploymentPhase;
	readonly failure: DeploymentFailure;
	/**
	 * The resources this attempt refused to write over, when that is why it
	 * stopped. Empty every other time.
	 *
	 * Structured rather than folded into `failure.details`, because both
	 * moves a caller has need the ids: a person picks the exact resources to
	 * take over and the caller sends those ids back in `adoptResourceIds`,
	 * while the display needs the author's own name for each one beside the
	 * name CommCare HQ shows.
	 */
	readonly resourceConflicts: readonly DeploymentResourceConflict[];
}

/**
 * A remote resource the target already holds under the name this app's
 * resource needs, which Nova did not create.
 *
 * Naming one back through `adoptResourceIds` is the ONLY way it is ever
 * taken over. See `DEPLOYMENT_RESOURCE_OWNERSHIPS` for why a name match is
 * never enough on its own.
 */
export interface DeploymentResourceConflict {
	readonly kind: DeploymentResourceKind;
	/** The Nova id to name in `adoptResourceIds` to take this one over. */
	readonly novaResourceId: string;
	/** What the author calls it in Nova. */
	readonly name: string;
	/**
	 * What CommCare HQ shows it as: a table's tag, a place's site code, or
	 * a worker's full username.
	 */
	readonly identity: string;
	/** CommCare HQ's own id for the resource already sitting there. */
	readonly remoteId: string;
}

/** Every phase, never run. */
export const NO_DEPLOYMENT_PHASE_OUTCOMES: DeploymentPhaseOutcomes = {
	preflight: null,
	resources: null,
	upload: null,
	build: null,
	release: null,
	probe: null,
};

/**
 * How Nova came to hold a remote resource.
 *
 * `nova-created` is the ordinary way: Nova made it, so Nova may keep
 * pointing at it. `adopted` is the only other way, and it is never
 * inferred — a person is shown the exact resource already sitting on the
 * target under the name this app needs, and says to take it over. There
 * is deliberately no arm for "matched by name": two project spaces can
 * hold two unrelated tables called `districts`, and picking one on a name
 * match would silently attach a deployment to somebody else's work.
 *
 * An adoption is attributed. `DeploymentResource.adoptedAt` / `adoptedBy`
 * are set together with it and never on their own, which the ledger
 * enforces rather than trusting every writer to remember.
 */
export const DEPLOYMENT_RESOURCE_OWNERSHIPS = [
	"nova-created",
	"adopted",
] as const;
export type DeploymentResourceOwnership =
	(typeof DEPLOYMENT_RESOURCE_OWNERSHIPS)[number];

/**
 * Which kind of remote thing a mapping names.
 *
 * All four share one mapping shape rather than a table each, because they
 * answer the same four questions: which Nova thing, which CommCare HQ
 * thing, under what claim, and by what name over there. A worker's
 * `novaResourceId` is its PERSONA — a design actor, which is why one
 * persona can hold a different username on each project space and why the
 * username lives in `pushedIdentity` rather than in the blueprint.
 */
export const DEPLOYMENT_RESOURCE_KINDS = [
	"app",
	"lookup-table",
	"location",
	"worker",
] as const;
export type DeploymentResourceKind = (typeof DEPLOYMENT_RESOURCE_KINDS)[number];

/**
 * One Nova resource, and the CommCare HQ resource it corresponds to.
 *
 * `novaResourceId` is the Nova side of the pair. For an `app` it is the
 * Nova app id; for the later kinds it is the authored UUID of the table,
 * place, or worker. It is deliberately plain text rather than a Nova
 * `Uuid`, because an app id is an opaque storage identity and not an
 * authored entity address.
 *
 * A superseded mapping is kept rather than deleted. An ordinary republish
 * updates the mapped app in place and supersedes nothing; a mapping is
 * replaced only when a publish had to start fresh — the mapped app was
 * deleted on CommCare HQ, or the row predates in-place updates, whose
 * every publish made a new app beside the old one. The author needs to be
 * told what an earlier publish may have left sitting on their project
 * space, which is only possible if Nova remembers it.
 */
export interface DeploymentResource {
	readonly deploymentId: string;
	readonly kind: DeploymentResourceKind;
	readonly novaResourceId: string;
	readonly remoteId: string;
	readonly ownership: DeploymentResourceOwnership;
	/**
	 * The external name the resource carries on CommCare HQ: a lookup
	 * table's tag, a place's site code, a worker's full username. Null for
	 * the `app` kind, whose remote id IS how CommCare HQ names it.
	 *
	 * A resource the app stops carrying is what makes this load-bearing.
	 * Whatever Nova pushed is still sitting on the project space under the
	 * name it was pushed under, and per the deployment contract Nova does
	 * not delete it — so that name is the only way anybody will find it
	 * there. A renamed lookup table, an archived place, and a deleted
	 * persona's worker all reach the left-behind report through this
	 * column.
	 */
	readonly pushedIdentity: string | null;
	/** When somebody took over a resource Nova did not create. */
	readonly adoptedAt: string | null;
	/** Who took it over. Set together with `adoptedAt`, never alone. */
	readonly adoptedBy: string | null;
	/** The Nova mutation sequence this remote resource was built from. */
	readonly pushedRevision: number | null;
	readonly pushedAt: string | null;
	/** CommCare HQ's own version number, as of the last observation. */
	readonly remoteRevision: number | null;
	readonly remoteObservedAt: string | null;
	/** Set once a newer mapping replaced this one. */
	readonly supersededAt: string | null;
}

/**
 * One app's deployment to one CommCare HQ project space.
 *
 * The key is `(app, Project, server, domain)`. The Project is part of it
 * because the same app moved to another Project is a different tenant's
 * publication, and the server is part of it because CommCare HQ runs three
 * independent deployments whose account databases do not share anything:
 * a key issued by the US server authenticates nowhere else.
 */
export interface DeploymentRecord {
	readonly id: string;
	readonly appId: string;
	readonly projectId: string;
	readonly server: CommCareServer;
	readonly domain: string;
	readonly state: DeploymentState;
	/**
	 * While `state` is `incomplete`, the phase a retry re-enters. Null in
	 * every other state. `DEPLOYMENT_PHASE_ENTRY_STATE` turns it back into
	 * the state the failure happened in, so the two facts cannot disagree.
	 */
	readonly resumePhase: DeploymentPhase | null;
	readonly phases: DeploymentPhaseOutcomes;
	readonly createdBy: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly lastObservedAt: string | null;
}

/** A deployment plus the resource mappings that belong to it. */
export interface DeploymentWithResources {
	readonly deployment: DeploymentRecord;
	/** The mapping currently in force for each Nova resource. */
	readonly active: readonly DeploymentResource[];
	/**
	 * Mappings a later publish replaced. These name real things still
	 * sitting on the target project space, so every surface that reports a
	 * deployment reports these too.
	 */
	readonly superseded: readonly DeploymentResource[];
}

// ── Wire schemas ────────────────────────────────────────────────────────
//
// These validate what crosses an HTTP, Server Action, or MCP boundary.
// The stored columns are typed independently in `lib/db/pg.ts`; this is
// the request/response contract, not a second storage shape.

export const deploymentStateSchema = z.enum(DEPLOYMENT_STATES);
export const deploymentPhaseSchema = z.enum(DEPLOYMENT_PHASES);
export const deploymentServerSchema = z.enum(COMMCARE_SERVER_IDS);
export const deploymentResourceKindSchema = z.enum(DEPLOYMENT_RESOURCE_KINDS);
export const deploymentResourceOwnershipSchema = z.enum(
	DEPLOYMENT_RESOURCE_OWNERSHIPS,
);

export const deploymentFailureSchema = z
	.object({
		code: z.enum(DEPLOYMENT_FAILURE_CODES),
		message: z.string().min(1),
		details: z.array(z.string()).readonly(),
	})
	.strict();

export const deploymentPhaseOutcomeSchema = z.discriminatedUnion("status", [
	z.object({ status: z.literal("succeeded"), at: z.string().min(1) }).strict(),
	z
		.object({
			status: z.literal("pending"),
			at: z.string().min(1),
			reason: z.string().min(1),
		})
		.strict(),
	z
		.object({
			status: z.literal("failed"),
			at: z.string().min(1),
			failure: deploymentFailureSchema,
		})
		.strict(),
]);

/**
 * The stored `phases` column, reasserted on every read.
 *
 * A durable JSON carrier is validated coming back out, not only going in:
 * this column outlives the release that wrote it, and a shape change that
 * silently reads as something else would put a deployment in a state
 * nobody can act on. Every phase key is required and nullable, so "never
 * ran" is an explicit `null` rather than an absent key.
 */
export const deploymentPhaseOutcomesSchema = z
	.object({
		preflight: deploymentPhaseOutcomeSchema.nullable(),
		resources: deploymentPhaseOutcomeSchema.nullable(),
		upload: deploymentPhaseOutcomeSchema.nullable(),
		build: deploymentPhaseOutcomeSchema.nullable(),
		release: deploymentPhaseOutcomeSchema.nullable(),
		probe: deploymentPhaseOutcomeSchema.nullable(),
	})
	.strict();

/** An app id as a caller states it, before it is authorized. */
export const deploymentAppIdSchema = z.string().trim().min(1).max(255);

/** The (app, server, project space) triple every deployment call names. */
export const deploymentTargetSchema = z
	.object({
		appId: deploymentAppIdSchema,
		server: deploymentServerSchema,
		domain: z.string().trim().min(1).max(255),
	})
	.strict();
export type DeploymentTarget = z.infer<typeof deploymentTargetSchema>;

/**
 * How many workers one provisioning call may ask for.
 *
 * Not a CommCare HQ limit: an account is made one request at a time and
 * the whole call is one person's deliberate act, so the ceiling is about
 * how many credentials it is reasonable to hand somebody on one screen.
 * An app with more personas than this provisions them in batches, which
 * is also how anybody would want to hand them out.
 */
export const MAX_WORKERS_PER_PROVISION_CALL = 50;

/**
 * One provisioning call, as the browser and MCP both state it.
 *
 * The username lives HERE rather than on the persona, because a persona
 * is a design actor and the same one can be provisioned on several
 * project spaces under a different name on each. Omitting it takes Nova's
 * suggestion from the persona's name; the surfaces show that suggestion
 * in an editable box rather than deciding silently.
 */
export const provisionWorkersSchema = z
	.object({
		appId: deploymentAppIdSchema,
		server: deploymentServerSchema,
		domain: z.string().trim().min(1).max(255),
		workers: z
			.array(
				z
					.object({
						personaUuid: z.string().min(1),
						username: z.string().trim().min(1).max(128).optional(),
					})
					.strict(),
			)
			.min(1)
			.max(MAX_WORKERS_PER_PROVISION_CALL)
			.readonly(),
		/**
		 * The personas whose username already belongs to an account Nova did
		 * not create, and which the caller is choosing to take over. Nothing
		 * is ever adopted without being named here.
		 */
		adoptPersonaUuids: z.array(z.string().min(1)).readonly().optional(),
	})
	.strict();
export type ProvisionWorkersRequest = z.infer<typeof provisionWorkersSchema>;

/** Narrow an arbitrary string to a known CommCare server, or refuse. */
export function isDeploymentServer(value: string): value is CommCareServer {
	return (COMMCARE_SERVER_IDS as readonly string[]).includes(value);
}

/**
 * The server's short human label ("US", "India", "EU"), for surfaces that
 * must tell two same-named project spaces on different installations
 * apart. Re-exposed here because `lib/commcare` is import-restricted and
 * components reach deployment vocabulary through this package.
 */
export function deploymentServerLabel(server: CommCareServer): string {
	return COMMCARE_SERVERS[server].label;
}
