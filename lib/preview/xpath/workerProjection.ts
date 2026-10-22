/* Main-realm projections for the isolated XPath worker protocol. This module
 * must stay independent of workerRuntime/asyncEvaluator so preparing a request
 * never downloads the evaluator or the OpenJDK Pattern compatibility engine
 * into the Builder's JavaScript realm. */
import type { XPathInstance, XPathNode } from "./runtimeValues";
import { isXPathDate, XPathDate, type XPathValue } from "./types";
import type {
	SerializedXPathValue,
	XPathWorkerInstanceSnapshot,
	XPathWorkerNodeSnapshot,
} from "./workerProtocol";

export function serializeXPathWorkerValue(
	value: XPathValue,
): SerializedXPathValue {
	if (!isXPathDate(value)) return value;
	return {
		kind: "date",
		calendarDays: value.calendarDays,
		timeMilliseconds: value.timeMilliseconds,
	};
}

export function deserializeXPathWorkerValue(
	value: SerializedXPathValue,
): XPathValue {
	if (typeof value !== "object") return value;
	// The sent calendar day is kept, never re-read in this realm: host and
	// worker share one zone, and the value names the day it was built on.
	return XPathDate.fromParts(value.calendarDays, value.timeMilliseconds);
}

function snapshotNode(node: XPathNode): XPathWorkerNodeSnapshot {
	const children = node.children();
	const attributes = node.attributes();
	const templateChildren = (node.templateChildren?.() ?? []).filter(
		(template) => !children.some((child) => child.name === template.name),
	);
	const templateAttributes = (node.templateAttributes?.() ?? []).filter(
		(template) =>
			!attributes.some((attribute) => attribute.name === template.name),
	);
	return {
		name: node.name,
		path: node.path,
		kind: node.kind,
		multiplicity: node.multiplicity,
		value: serializeXPathWorkerValue(node.value()),
		relevant: node.isRelevant(),
		children: children.map(snapshotNode),
		attributes: attributes.map(snapshotNode),
		templateChildren: templateChildren.map(snapshotNode),
		templateAttributes: templateAttributes.map(snapshotNode),
		childTemplateNames: node.childTemplateNames?.(),
		attributeTemplateNames: node.attributeTemplateNames?.(),
	};
}

/** Project an existing Preview instance onto the structured-clone protocol. */
export function snapshotXPathWorkerInstance(
	instance: XPathInstance,
): XPathWorkerInstanceSnapshot {
	return { id: instance.id, root: snapshotNode(instance.root()) };
}
