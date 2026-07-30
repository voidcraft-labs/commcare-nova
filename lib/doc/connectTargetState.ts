import type {
	BlueprintDoc,
	ConnectConfig,
	ConnectType,
	Uuid,
} from "@/lib/domain";
import {
	connectConfigSchema,
	isConnectLearnConfig,
	uuidSchema,
} from "@/lib/domain";
import type { Mutation } from "./types";

/**
 * One form participating in the complete requested Connect target state.
 *
 * The config is already a final domain value: tool-facing drafts finalize
 * their ids before they reach this planner, while the builder supplies the
 * complete values produced by its local editor.
 */
export interface ConnectTargetParticipant {
	readonly formUuid: string;
	readonly connect: ConnectConfig;
}

/** The one app-wide Connect authoring command. */
export type ConnectTargetState =
	| { readonly mode: null }
	| {
			readonly mode: ConnectType;
			readonly participants: readonly ConnectTargetParticipant[];
	  };

export type ConnectTargetPlan =
	| { readonly ok: true; readonly mutations: readonly Mutation[] }
	| { readonly ok: false; readonly messages: readonly string[] };

function jsonEqual(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true;
	if (
		typeof left !== "object" ||
		typeof right !== "object" ||
		left === null ||
		right === null
	) {
		return false;
	}
	if (Array.isArray(left) || Array.isArray(right)) {
		if (
			!Array.isArray(left) ||
			!Array.isArray(right) ||
			left.length !== right.length
		) {
			return false;
		}
		return left.every((value, index) => jsonEqual(value, right[index]));
	}
	const leftRecord = left as Record<string, unknown>;
	const rightRecord = right as Record<string, unknown>;
	const leftKeys = Object.keys(leftRecord);
	const rightKeys = Object.keys(rightRecord);
	return (
		leftKeys.length === rightKeys.length &&
		leftKeys.every(
			(key) =>
				Object.hasOwn(rightRecord, key) &&
				jsonEqual(leftRecord[key], rightRecord[key]),
		)
	);
}

function orderedFormUuids(doc: BlueprintDoc): Uuid[] {
	const forms: Uuid[] = [];
	for (const moduleUuid of doc.moduleOrder) {
		forms.push(...(doc.formOrder[moduleUuid] ?? []));
	}
	return forms;
}

function connectIds(config: ConnectConfig): string[] {
	if (isConnectLearnConfig(config)) {
		return [
			...(config.learn_module ? [config.learn_module.id] : []),
			...(config.assessment ? [config.assessment.id] : []),
		];
	}
	return [
		...(config.deliver_unit ? [config.deliver_unit.id] : []),
		...(config.task ? [config.task.id] : []),
	];
}

/**
 * Plan the exact app-wide Connect target as one mutation batch.
 *
 * A non-null target names every participating form. Anything unlisted is
 * auxiliary and has its old block cleared; a mode switch therefore cannot
 * leave a dormant block from the previous family. A null target clears both
 * the app mode and every form block. Invalid identities, duplicates, wrong
 * families, incomplete configs, and an empty participant set reject before a
 * mutation is constructed.
 */
export function planConnectTargetState(
	doc: BlueprintDoc,
	target: ConnectTargetState,
): ConnectTargetPlan {
	const formUuids = orderedFormUuids(doc);
	const liveForms = new Set<Uuid>(formUuids);
	const desired = new Map<Uuid, ConnectConfig>();
	const seenForms = new Set<Uuid>();
	const messages: string[] = [];
	const ids = new Map<string, Uuid>();

	if (target.mode !== null) {
		if (target.participants.length === 0) {
			messages.push(
				`Connect ${target.mode} requires at least one participating form.`,
			);
		}
		for (const participant of target.participants) {
			const parsedFormUuid = uuidSchema.safeParse(participant.formUuid);
			if (!parsedFormUuid.success) {
				messages.push(
					`Form UUID "${participant.formUuid}" is not a canonical authored UUID.`,
				);
				continue;
			}
			const formUuid = parsedFormUuid.data;
			if (seenForms.has(formUuid)) {
				messages.push(
					`Form UUID "${formUuid}" appears more than once in the Connect participant set.`,
				);
				continue;
			}
			seenForms.add(formUuid);
			if (!liveForms.has(formUuid) || doc.forms[formUuid] === undefined) {
				messages.push(`Form UUID "${formUuid}" is not a form in this app.`);
				continue;
			}
			const parsed = connectConfigSchema.safeParse(participant.connect);
			if (!parsed.success) {
				messages.push(
					`Form "${doc.forms[formUuid]?.name ?? formUuid}" has an incomplete Connect configuration.`,
				);
				continue;
			}
			const isLearn = isConnectLearnConfig(parsed.data);
			if ((target.mode === "learn") !== isLearn) {
				messages.push(
					`Form "${doc.forms[formUuid]?.name ?? formUuid}" has a Connect configuration for the wrong mode.`,
				);
				continue;
			}
			desired.set(formUuid, parsed.data);
			for (const id of connectIds(parsed.data)) {
				const prior = ids.get(id);
				if (prior !== undefined) {
					messages.push(
						`Connect ID "${id}" is used by both "${doc.forms[prior]?.name ?? prior}" and "${doc.forms[formUuid]?.name ?? formUuid}".`,
					);
				} else {
					ids.set(id, formUuid);
				}
			}
		}
	}

	if (messages.length > 0) return { ok: false, messages };

	const mutations: Mutation[] = [];
	if (doc.connectType !== target.mode) {
		mutations.push({ kind: "setConnectType", connectType: target.mode });
	}
	for (const formUuid of formUuids) {
		const current = doc.forms[formUuid]?.connect;
		const next = desired.get(formUuid);
		if (next === undefined) {
			if (current !== undefined) {
				mutations.push({
					kind: "updateForm",
					uuid: formUuid,
					patch: { connect: null },
				});
			}
			continue;
		}
		if (!jsonEqual(current, next)) {
			mutations.push({
				kind: "updateForm",
				uuid: formUuid,
				patch: { connect: structuredClone(next) },
			});
		}
	}
	return { ok: true, mutations };
}
