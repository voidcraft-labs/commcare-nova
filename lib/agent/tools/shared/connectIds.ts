/**
 * Connect-id source enforcement for the agent's write tools.
 *
 * The "force correct at the source" boundary for the agent path (the SA
 * sets ids as bare strings via `z.string()`, bypassing the UI's commit
 * guard). The app-wide configure tool and the existing-participant edit path
 * run every authored block through here:
 *  - an OMITTED id is autofilled with a valid, unique, name-derived id
 *    (`deriveConnectId`) — stored on the doc so the SA sees it immediately;
 *  - an EXPLICIT id is validated (grammar + length via `connectIdError`,
 *    which offers an id free among the app's others, uniqueness via
 *    `connectIdConflictError`) and, if invalid, FAILS the
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
	connectIdRootFieldConflictError,
	deriveConnectId,
} from "@/lib/commcare/connectSlugs";
import {
	type BlueprintDoc,
	type ConnectConfig,
	connectConfigSchema,
} from "@/lib/domain";
import type { ConnectConfigDraft } from "./connectInput";

/** Human-readable label per connect kind for error messages. */
const KIND_LABEL = {
	learn_module: "learn-module",
	assessment: "assessment",
	deliver_unit: "deliver-unit",
	task: "task",
} as const;

type ConnectKind = keyof typeof KIND_LABEL;
export type ConnectIdDraft = Partial<
	Record<ConnectKind, { readonly id?: string }>
>;
export type ConnectIdPlan = Partial<
	Record<ConnectKind, { readonly id: string }>
>;

function explicitIdEntries(
	config: ConnectIdDraft,
): readonly { readonly kind: ConnectKind; readonly id: string }[] {
	const entries: Array<{ kind: ConnectKind; id: string }> = [];
	if (config.learn_module?.id !== undefined) {
		entries.push({ kind: "learn_module", id: config.learn_module.id });
	}
	if (config.assessment?.id !== undefined) {
		entries.push({ kind: "assessment", id: config.assessment.id });
	}
	if (config.deliver_unit?.id !== undefined) {
		entries.push({ kind: "deliver_unit", id: config.deliver_unit.id });
	}
	if (config.task?.id !== undefined) {
		entries.push({ kind: "task", id: config.task.id });
	}
	return entries;
}

/** Every already-present id in one draft/final config, in wire block order. */
export function connectIdsInConfig(config: ConnectIdDraft): readonly string[] {
	return explicitIdEntries(config).map(({ id }) => id);
}

/**
 * Validate and reserve every already-present id before any omitted id derives.
 *
 * Exact-target authoring uses this across the complete canonical participant
 * set. That makes an explicit or previously established identity win its own
 * spelling regardless of caller array order; only genuinely new omitted ids
 * compete for derived suffixes afterward.
 */
export function reserveExplicitConnectIds(
	config: ConnectIdDraft,
	taken: Set<string>,
	rootFieldIds: ReadonlySet<string> = new Set(),
): readonly string[] {
	const errors: string[] = [];
	for (const { kind, id } of explicitIdEntries(config)) {
		const reason =
			connectIdError(id, new Set([...taken, ...rootFieldIds])) ??
			connectIdRootFieldConflictError(id, rootFieldIds) ??
			connectIdConflictError(id, taken);
		if (reason) {
			errors.push(`${KIND_LABEL[kind]} id "${id}": ${reason}`);
		} else {
			taken.add(id);
		}
	}
	return errors;
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
 * The finalizer is deliberately two-pass: every present explicit or
 * previously established id validates and reserves first, then genuinely
 * omitted ids derive in wire-block order. An omitted earlier kind therefore
 * cannot steal the spelling of an unchanged later kind.
 */
export function planConnectIds(
	config: ConnectIdDraft,
	connectType: BlueprintDoc["connectType"],
	moduleName: string,
	formName: string,
	existingIds: Set<string>,
	rootFieldIds: ReadonlySet<string> = new Set(),
): { ok: true; config: ConnectIdPlan } | { ok: false; error: string } {
	if (connectType === null) {
		return {
			ok: false,
			error:
				"Connect configuration cannot be authored until the app has a Connect mode.",
		};
	}
	const hasLearn =
		config.learn_module !== undefined || config.assessment !== undefined;
	const hasDeliver =
		config.deliver_unit !== undefined || config.task !== undefined;
	if (
		(connectType === "learn" && (!hasLearn || hasDeliver)) ||
		(connectType === "deliver" && (!hasDeliver || hasLearn))
	) {
		return {
			ok: false,
			error: `Connect configuration must contain only ${connectType}-mode blocks and at least one such block.`,
		};
	}

	const out: ConnectIdDraft = { ...config };
	const pairName = `${moduleName} ${formName}`;

	const errors = [...reserveExplicitConnectIds(out, existingIds, rootFieldIds)];

	// Every explicit identity is already reserved. One arm per kind now derives
	// only an omission; the name differs (module vs module+form), but the shape
	// and deterministic wire-block order are uniform.
	const handle = <T extends { id?: string }>(
		sub: T | undefined,
		deriveName: string,
		assign: (next: T) => void,
	): void => {
		if (!sub) return;
		if (sub.id === undefined) {
			const id = deriveConnectId(
				deriveName,
				new Set([...existingIds, ...rootFieldIds]),
			);
			existingIds.add(id);
			assign({ ...sub, id });
		}
	};

	handle(out.learn_module, moduleName, (n) => {
		out.learn_module = n;
	});
	handle(out.assessment, pairName, (n) => {
		out.assessment = n;
	});
	handle(out.deliver_unit, moduleName, (n) => {
		out.deliver_unit = n;
	});
	handle(out.task, pairName, (n) => {
		out.task = n;
	});

	if (errors.length > 0) {
		return {
			ok: false,
			error: `Connect ${errors.join("; Connect ")}`,
		};
	}
	return { ok: true, config: out as ConnectIdPlan };
}

/** Final content validation consumes the same structural ID plan used before
 * authoring text is decoded. Prepared calls already carry every planned id. */
export function enforceConnectIds(
	config: ConnectConfigDraft,
	connectType: BlueprintDoc["connectType"],
	moduleName: string,
	formName: string,
	existingIds: Set<string>,
	rootFieldIds: ReadonlySet<string> = new Set(),
): EnforceConnectIdsResult {
	const planned = planConnectIds(
		config,
		connectType,
		moduleName,
		formName,
		existingIds,
		rootFieldIds,
	);
	if (!planned.ok) return planned;
	const out: ConnectConfigDraft = { ...config };
	if (
		out.learn_module !== undefined &&
		planned.config.learn_module !== undefined
	)
		out.learn_module = {
			...out.learn_module,
			id: planned.config.learn_module.id,
		};
	if (out.assessment !== undefined && planned.config.assessment !== undefined)
		out.assessment = { ...out.assessment, id: planned.config.assessment.id };
	if (
		out.deliver_unit !== undefined &&
		planned.config.deliver_unit !== undefined
	)
		out.deliver_unit = {
			...out.deliver_unit,
			id: planned.config.deliver_unit.id,
		};
	if (out.task !== undefined && planned.config.task !== undefined)
		out.task = { ...out.task, id: planned.config.task.id };
	const final = connectConfigSchema.safeParse(out);
	if (!final.success)
		return {
			ok: false,
			error: `Connect configuration is incomplete: ${final.error.issues.map((issue) => issue.message).join("; ")}`,
		};
	return { ok: true, config: final.data };
}
