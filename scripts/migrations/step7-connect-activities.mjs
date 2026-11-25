/** Standalone converter for the deployed document dialect. Both the old
 * reader and this module are selected by digest before scanning or writing.
 * The same snapshot and app identity yield the same node UUIDs for a live
 * head, a certified older deployment, and an app awaiting restoration. */
import { createHash } from "node:crypto";

export const sourceRevision = "3e16e43f8cfa56e485860f3345c81f5f9a68aec9";

const namespace = Buffer.from("1d78273b7bed45ac9262ce5c70d56da3", "hex");
const username = {
	kind: "term",
	term: { kind: "session-user", field: "username", source: "worker-record" },
};
const entityId = {
	kind: "concat",
	parts: [
		username,
		{ kind: "term", term: { kind: "literal", value: "-" } },
		{ kind: "today" },
	],
};
const score = { kind: "term", term: { kind: "literal", value: 100 } };

/** The old schema had at most one of each kind per form. A rename still
 * identifies that same activity in the published and live documents. */
function activityUuid(appId, formUuid, kind) {
	const bytes = createHash("sha1")
		.update(namespace)
		.update(JSON.stringify([appId, formUuid, kind]))
		.digest();
	bytes[6] = (bytes[6] & 0x0f) | 0x50;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = bytes.subarray(0, 16).toString("hex");
	return [
		hex.slice(0, 8),
		hex.slice(8, 12),
		hex.slice(12, 16),
		hex.slice(16, 20),
		hex.slice(20),
	].join("-");
}

function activityOf(kind, old) {
	switch (kind) {
		case "learn_module":
			return {
				kind: "learning-module",
				name: old.name,
				description: old.description,
				estimatedHours: old.time_estimate,
			};
		case "assessment":
			return {
				kind: "assessment",
				score: old.user_score ?? structuredClone(score),
			};
		case "deliver_unit":
			return {
				kind: "delivery",
				name: old.name,
				entityId: old.entity_id ?? structuredClone(entityId),
				entityName: old.entity_name ?? structuredClone(username),
			};
		case "task":
			return {
				kind: "assigned-task",
				name: old.name,
				description: old.description,
			};
		default:
			throw new Error("Unrecognized Connect activity in a released document.");
	}
}

const priorKinds = new Map([
	["connect-learn", "learn_module"],
	["connect-assessment", "assessment"],
	["connect-delivery", "deliver_unit"],
	["connect-task", "task"],
]);

function convertCoordinates(value, identities) {
	if (value === null || typeof value !== "object") return;
	const coordinate = (old) => {
		const kind = priorKinds.get(old?.kind);
		if (kind === undefined) return undefined;
		const activity = identities.get(old.form)?.get(kind);
		if (!activity)
			throw new Error(
				"A saved expression names a Connect activity its form does not contain.",
			);
		return old.role === "block"
			? { kind: "field", uuid: activity }
			: { kind: old.kind, activity, role: old.role };
	};
	// The released expression schema stores coordinates only on a form-node
	// term or on a filtered path step. Preserve spelling, predicates and the
	// nesting of every expression, including text interpolation in translations.
	if (value.kind === "form-node") {
		const node = coordinate(value.node);
		if (node?.kind === "field") {
			delete value.node;
			Object.assign(value, node);
		} else if (node !== undefined) value.node = node;
	}
	if (Array.isArray(value.where) && value.step) {
		const step = coordinate(value.step);
		if (step !== undefined) value.step = step;
	}
	for (const child of Object.values(value))
		convertCoordinates(child, identities);
}

export function convert(snapshot, _settings, { appId }) {
	if (
		typeof appId !== "string" ||
		!appId ||
		!Object.hasOwn(snapshot, "connectType")
	)
		throw new Error(
			"Connect conversion requires its released document and app identity.",
		);
	const doc = structuredClone(snapshot);
	doc.connectRoles = doc.connectType === null ? [] : [doc.connectType];
	delete doc.connectType;
	// The released blueprint_entities primary key is (app_id, uuid) across
	// all entity kinds, including the six optional top-level collections.
	const occupied = new Set([
		...Object.keys(doc.modules),
		...Object.keys(doc.forms),
		...Object.keys(doc.fields),
		...Object.keys(doc.fieldOrder),
		...Object.keys(doc.userProperties ?? {}),
		...Object.keys(doc.userTypes ?? {}),
		...Object.keys(doc.personas ?? {}),
		...Object.keys(doc.organizationLevels ?? {}),
		...Object.keys(doc.locationProperties ?? {}),
		...Object.keys(doc.automations ?? {}),
	]);
	const identities = new Map();
	for (const [formUuid, form] of Object.entries(doc.forms)) {
		if (!Object.hasOwn(form, "connect")) continue;
		const config = form.connect;
		const formActivities = new Map();
		identities.set(formUuid, formActivities);
		doc.fieldOrder[formUuid] ??= [];
		const order = doc.fieldOrder[formUuid];
		// This is the released builder's data and bind order after its fields.
		for (const kind of ["learn_module", "assessment", "deliver_unit", "task"]) {
			if (!Object.hasOwn(config, kind)) continue;
			const old = config[kind];
			const uuid = activityUuid(appId, formUuid, kind);
			if (occupied.has(uuid))
				throw new Error(
					"An existing app entity holds the identity needed for a Connect activity.",
				);
			occupied.add(uuid);
			doc.fields[uuid] = {
				kind: "connect_activity",
				uuid,
				id: old.id,
				activity: activityOf(kind, old),
			};
			order.push(uuid);
			formActivities.set(kind, uuid);
		}
		delete form.connect;
	}
	convertCoordinates(doc, identities);
	return doc;
}
