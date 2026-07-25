/**
 * Emission bindings for a surface whose "current case" is a session
 * variable rather than the surrounding nodeset row.
 *
 * Case-list and search predicates evaluate with a candidate case as
 * `current()`, so their property reads emit relative. Two surfaces do
 * not: a form submission's case operations, and an end-of-form
 * navigation guard. Both evaluate against a case the session already
 * holds, so every read has to name it — and both need the SAME anchoring,
 * because an author writing "this client's district" expects one meaning
 * whether the rule decides a case write or where the form goes next.
 *
 * The anchor is parameterized because the two surfaces name different
 * session variables: the loaded case is `case_id`, while a registration
 * form's link condition reads the case that form just created, whose id
 * lives in `case_id_new_<type>_0`.
 *
 * Only ROOT reads anchor. A relation `where` clause is evaluated with its
 * destination case as `current()`, so those terms stay on the ordinary
 * relative path — anchoring them would silently re-point the clause at
 * the origin case.
 */

import type { PropertyRef } from "@/lib/domain/predicate/types";
import { emitCasePropertyWirePath } from "../casePropertyWire";
import { quoteLiteral } from "./stringQuoting";
import type { InstanceRoot, OnDeviceExpressionBindings } from "./termEmitter";

/** The loaded case's id — every case-loading form's session datum. */
export const SESSION_CASE_ID =
	"instance('commcaresession')/session/data/case_id";

/** The session variable holding the id of a case the form creates. */
export function newCaseSessionId(caseType: string, index = 0): string {
	return `instance('commcaresession')/session/data/case_id_new_${caseType}_${index}`;
}

/**
 * The `rootCaseId` + `caseProperty` bindings that anchor an on-device
 * predicate or expression on one concrete session case.
 *
 * `rootCaseId` covers relation presence and counts (the anchor builders
 * in `relationPresenceEmitter` take it as `originCaseId`); `caseProperty`
 * covers direct and relation-walked property reads.
 */
export function sessionCaseAnchorBindings(
	caseIdExpression: string,
	currentCaseType: string | undefined,
): Pick<OnDeviceExpressionBindings, "rootCaseId" | "caseProperty"> {
	return {
		rootCaseId: caseIdExpression,
		caseProperty: (property, root, scope) => {
			if (
				scope !== "root" ||
				currentCaseType === undefined ||
				property.caseType !== currentCaseType
			) {
				return undefined;
			}
			return emitAnchoredProperty(property, root, caseIdExpression);
		},
	};
}

function emitAnchoredProperty(
	property: PropertyRef,
	root: InstanceRoot,
	caseIdExpression: string,
): string {
	const leaf = emitCasePropertyWirePath(property.property);
	const base = `instance('${root}')/${root}/case[@case_id=${caseIdExpression}]`;
	const via = property.via;
	if (via === undefined || via.kind === "self") return `${base}/${leaf}`;
	if (via.kind === "ancestor") {
		let destination = base;
		for (const step of via.via) {
			destination = caseById(
				`${destination}/index/${step.identifier}`,
				step.throughCaseType,
				root,
			);
		}
		return `${destination}/${leaf}`;
	}
	const subcase = subcasesOf(base, via.identifier, via.ofCaseType, root);
	if (via.kind === "subcase") return `${subcase}/${leaf}`;
	const ancestor = caseById(
		`${base}/index/${via.identifier}`,
		via.ofCaseType,
		root,
	);
	return `(${ancestor}/${leaf} | ${subcase}/${leaf})`;
}

function caseById(
	id: string,
	caseType: string | undefined,
	root: InstanceRoot,
): string {
	const type =
		caseType === undefined
			? ""
			: ` and @case_type=${quoteLiteral(caseType, "case-list-filter")}`;
	return `instance('${root}')/${root}/case[@case_id=${id}${type}]`;
}

function subcasesOf(
	origin: string,
	identifier: string,
	caseType: string | undefined,
	root: InstanceRoot,
): string {
	const type =
		caseType === undefined
			? ""
			: ` and @case_type=${quoteLiteral(caseType, "case-list-filter")}`;
	return `instance('${root}')/${root}/case[index/${identifier}=${origin}/@case_id${type}]`;
}
