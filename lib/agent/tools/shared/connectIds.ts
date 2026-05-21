/**
 * Connect-id source enforcement for the agent's write tools.
 *
 * The "force correct at the source" boundary for the agent path (the SA
 * sets ids as bare strings via `z.string()`, bypassing the UI's commit
 * guard). Every tool that creates or enables a connect block runs its ids
 * through here:
 *  - an OMITTED id is autofilled with a valid, unique, name-derived id
 *    (`deriveConnectId`) — stored on the doc so the SA sees it immediately;
 *  - an EXPLICIT id is validated (format + length via `connectIdError`,
 *    uniqueness via `connectIdConflictError`) and, if invalid, FAILS the
 *    tool call so nothing is written. The SA gets one diagnostic and
 *    re-issues with a fixed id — never a silent sanitize or rename.
 *
 * The four connect kinds are handled uniformly; `existingIds` is the set
 * of connect ids already in use elsewhere in the app so autofill stays
 * unique by construction and an explicit duplicate is rejected.
 */
import {
	connectIdConflictError,
	connectIdError,
	deriveConnectId,
} from "@/lib/commcare/connectSlugs";
import type { BlueprintDoc, ConnectConfig, Uuid } from "@/lib/domain";

/** Human-readable label per connect kind for error messages. */
const KIND_LABEL = {
	learn_module: "learn-module",
	assessment: "assessment",
	deliver_unit: "deliver-unit",
	task: "task",
} as const;

type ConnectKind = keyof typeof KIND_LABEL;

/**
 * Every connect id currently set anywhere in the doc EXCEPT the form being
 * edited (its own ids must not read as conflicts with themselves). Feeds
 * both autofill uniqueness and the explicit-duplicate rejection.
 */
export function collectConnectIdsExcept(
	doc: BlueprintDoc,
	exceptFormUuid: Uuid,
): Set<string> {
	const ids = new Set<string>();
	for (const formUuid of Object.keys(doc.forms) as Uuid[]) {
		if (formUuid === exceptFormUuid) continue;
		const c = doc.forms[formUuid]?.connect;
		if (!c) continue;
		for (const id of [
			c.learn_module?.id,
			c.assessment?.id,
			c.deliver_unit?.id,
			c.task?.id,
		]) {
			if (id) ids.add(id);
		}
	}
	return ids;
}

/** Outcome of {@link enforceConnectIds}: the finalized config (every
 *  present sub-config carries a valid, unique id) or a fail-the-call error. */
export type EnforceConnectIdsResult =
	| { ok: true; config: ConnectConfig }
	| { ok: false; error: string };

/**
 * Enforce connect-id correctness on a merged config before it's written.
 *
 * For each present sub-config: an explicit id is validated (collecting all
 * failures across kinds into one message); an omitted id is autofilled from
 * the kind's name (`moduleName` for learn_module / deliver_unit,
 * `<module> <form>` for assessment / task) via `deriveConnectId`. Returns
 * `{ ok: false, error }` if ANY explicit id is invalid (writes nothing), or
 * `{ ok: true, config }` with every id filled and valid.
 *
 * `existingIds` accumulates each autofilled id as it's minted, so two
 * id-less blocks on the same form can't derive the same slug.
 */
export function enforceConnectIds(
	config: ConnectConfig,
	moduleName: string,
	formName: string,
	existingIds: Set<string>,
): EnforceConnectIdsResult {
	const out: ConnectConfig = { ...config };
	const errors: string[] = [];
	const pairName = `${moduleName} ${formName}`;

	// Validate one explicit id; collect any format/length/conflict error.
	const checkExplicit = (kind: ConnectKind, id: string): void => {
		const reason =
			connectIdError(id) ?? connectIdConflictError(id, existingIds);
		if (reason) errors.push(`${KIND_LABEL[kind]} id ${reason}`);
		else existingIds.add(id);
	};

	// One arm per kind: validate-if-explicit, autofill-if-omitted. The
	// derive name differs (module vs module+form) but the shape is uniform.
	const handle = <T extends { id?: string }>(
		kind: ConnectKind,
		sub: T | undefined,
		deriveName: string,
		assign: (next: T) => void,
	): void => {
		if (!sub) return;
		if (sub.id === undefined) {
			const id = deriveConnectId(deriveName, existingIds);
			existingIds.add(id);
			assign({ ...sub, id });
		} else {
			checkExplicit(kind, sub.id);
			assign(sub);
		}
	};

	handle("learn_module", out.learn_module, moduleName, (n) => {
		out.learn_module = n;
	});
	handle("assessment", out.assessment, pairName, (n) => {
		out.assessment = n;
	});
	handle("deliver_unit", out.deliver_unit, moduleName, (n) => {
		out.deliver_unit = n;
	});
	handle("task", out.task, pairName, (n) => {
		out.task = n;
	});

	if (errors.length > 0) {
		return {
			ok: false,
			error: `Connect ${errors.join("; Connect ")}`,
		};
	}
	return { ok: true, config: out };
}

/** A scaffold-shaped slice: just the module/form structure carrying the
 *  per-form connect blocks `enforceScaffoldConnectIds` needs to walk. */
interface ScaffoldConnectShape {
	connect_type?: string | null;
	modules: ReadonlyArray<{
		name: string;
		forms: ReadonlyArray<{ name: string; connect?: ConnectConfig }>;
	}>;
}

/** Outcome of {@link enforceScaffoldConnectIds}: the scaffold with every
 *  connect id filled + valid, or a fail-the-call error. The returned
 *  scaffold preserves the caller's concrete type via the generic. */
export type EnforceScaffoldResult<S> =
	| { ok: true; scaffold: S }
	| { ok: false; error: string };

/**
 * Enforce connect-id correctness across an entire scaffold before any
 * mutation is built.
 *
 * Walks every form in document order, threading one app-wide `existingIds`
 * set so autofilled ids stay unique across the whole scaffold (mirrors the
 * incremental accumulation the validate-time pass does). Returns the
 * scaffold with each present connect block's ids autofilled/validated, or a
 * single error naming the first form whose explicit id is invalid (the
 * whole call fails and writes nothing — the SA fixes its input and re-issues).
 *
 * Non-Connect scaffolds (`connect_type` absent/`none`) pass through
 * unchanged — there are no connect blocks to enforce.
 */
export function enforceScaffoldConnectIds<S extends ScaffoldConnectShape>(
	scaffold: S,
): EnforceScaffoldResult<S> {
	if (
		scaffold.connect_type !== "learn" &&
		scaffold.connect_type !== "deliver"
	) {
		return { ok: true, scaffold };
	}

	// One app-wide set threaded through every form in document order so
	// autofilled ids stay unique across the whole scaffold.
	const existingIds = new Set<string>();
	const modules: ScaffoldConnectShape["modules"][number][] = [];

	for (const mod of scaffold.modules) {
		const forms: ScaffoldConnectShape["modules"][number]["forms"][number][] =
			[];
		for (const form of mod.forms) {
			if (!form.connect) {
				forms.push(form);
				continue;
			}
			const enforced = enforceConnectIds(
				form.connect,
				mod.name,
				form.name,
				existingIds,
			);
			if (!enforced.ok) {
				// First invalid explicit id fails the whole call — writes nothing.
				return {
					ok: false,
					error: `"${form.name}" in "${mod.name}": ${enforced.error}`,
				};
			}
			forms.push({ ...form, connect: enforced.config });
		}
		modules.push({ ...mod, forms });
	}

	return { ok: true, scaffold: { ...scaffold, modules } };
}
