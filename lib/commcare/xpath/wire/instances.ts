/** Secondary-instance declarations for emitted wire roots.
 *
 * The arm chooses its declaration when it builds a root. The serializer
 * returns only declarations reached by that root's printed tree; no separate
 * domain walk or implication between instance ids adds dependencies.
 *
 * Sources: HQ's suite_xml/post_process/instances.py factories and Core's
 * CommCareInstanceInitializer.generateRoot. Lookup forms use the bare tag;
 * suites use the fixture id, and both resolve the same delivered fixture.
 */

import type { LookupTableId } from "@/lib/domain/lookupIds";
import { type LookupWireNaming, lookupFixtureSrc } from "../../lookup/naming";

export interface InstanceDecl {
	readonly id: string;
	readonly src: string;
	/** Present when Core builds this instance from its data alone, with no
	 * template (`CommCareInstanceInitializer.generateRoot`): a lookup table,
	 * the flat place list, the selected entities and the search answers. With
	 * no rows, a path through `row` is an invalid node-set
	 * (`XPathPathExpr.evalRaw` → `DataInstance.hasTemplatePath`), so the
	 * emitter guards its value reads by the rows' count (`emptyRows.ts`).
	 * `casedb` and `results:inline` read the case template and have none. */
	readonly rows?: InstanceRows;
}

/** The root element and the row element of an instance Core builds from
 * its data. Preview's instance builders (`lib/preview/engine/xpathInstances.ts`)
 * build their instances from these same names. */
export interface InstanceRows {
	readonly root: string;
	readonly row: string;
}

/** HQ's flat place fixture: `<locations><location …>` per place
 * (`corehq/apps/locations/fixtures.py::FlatLocationSerializer`). */
export const LOCATION_ROWS: InstanceRows = {
	root: "locations",
	row: "location",
};

/** `<input><field name="…">` per answered prompt
 * (`org/commcare/data/xml/VirtualInstances.java::SEARCH_INSTANCE_ROOT_NAME`,
 * `SEARCH_INSTANCE_NODE_NAME`). */
export const SEARCH_INPUT_ROWS: InstanceRows = { root: "input", row: "field" };

/** `<results><value>` per chosen case
 * (`org/commcare/data/xml/VirtualInstances.java::SELCTED_CASES_INSTANCE_ROOT_NAME`,
 * `SELCTED_CASES_INSTANCE_NODE_NAME`). */
export const SELECTED_ENTITY_ROWS: InstanceRows = {
	root: "results",
	row: "value",
};

export function caseDbInstance(): InstanceDecl {
	return { id: "casedb", src: "jr://instance/casedb" };
}

export function sessionInstance(): InstanceDecl {
	return { id: "commcaresession", src: "jr://instance/session" };
}

export function locationsInstance(): InstanceDecl {
	return {
		id: "locations",
		src: "jr://fixture/locations",
		rows: LOCATION_ROWS,
	};
}

export function resultsInstance(
	id: "results" | "results:inline",
): InstanceDecl {
	return { id, src: `jr://instance/remote/${id}` };
}

export function searchInputInstance(
	id: `search-input:${string}`,
): InstanceDecl {
	return {
		id,
		src: `jr://instance/search-input/${id.slice("search-input:".length)}`,
		rows: SEARCH_INPUT_ROWS,
	};
}

/** The caller holds the generated selection datum's exact id. No id-pattern
 * classifier reconstructs whether a string is a selected-entity instance. */
export function selectedCasesInstance(datumId: string): InstanceDecl {
	return {
		id: datumId,
		src: `jr://instance/selected-entities/${datumId}`,
		rows: SELECTED_ENTITY_ROWS,
	};
}

export function lookupInstance(
	tableId: LookupTableId,
	lookup: LookupWireNaming | undefined,
	target: "xform" | "suite",
): InstanceDecl {
	if (lookup === undefined) {
		throw new Error(
			"The emitter could not declare a lookup read because its validated table definitions were not supplied. Pass the Project lookup naming used by this compile boundary.",
		);
	}
	const table = lookup.tableFor(tableId);
	return {
		id: target === "xform" ? table.xformInstanceId : table.fixtureId,
		src: lookupFixtureSrc(table.fixtureId),
		rows: { root: table.listElementName, row: table.rowElementName },
	};
}

function instanceOrder(id: string): number {
	return id === "casedb" ? 0 : id === "commcaresession" ? 1 : 2;
}

/** One actual evaluation scope's union of printed dependencies. */
export class InstanceSink {
	readonly #byId = new Map<string, InstanceDecl>();

	constructor(initial: Iterable<InstanceDecl> = []) {
		this.add(initial);
	}

	add(declarations: Iterable<InstanceDecl>): void {
		for (const declaration of declarations) this.addOne(declaration);
	}

	addOne(declaration: InstanceDecl): void {
		const previous = this.#byId.get(declaration.id);
		if (previous !== undefined && previous.src !== declaration.src) {
			throw new Error(
				`The emitter declared instance '${declaration.id}' with two different sources ('${previous.src}' and '${declaration.src}'). Check the roots contributing to this evaluation scope.`,
			);
		}
		if (previous === undefined) this.#byId.set(declaration.id, declaration);
	}

	declarations(): readonly InstanceDecl[] {
		return [...this.#byId.values()].sort(
			(left, right) =>
				instanceOrder(left.id) - instanceOrder(right.id) ||
				(left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
		);
	}
}
