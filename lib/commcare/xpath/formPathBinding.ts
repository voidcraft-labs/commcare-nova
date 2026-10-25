import {
	activeRowScope,
	type CaseRowScope,
	type ExpressionContext,
	pushRowScope,
	type RowScope,
	withFormContextNode,
} from "@/lib/domain/expression/context";
import { expressionRowScope } from "@/lib/domain/expression/typeChecker";
import {
	datumRefKey,
	type Expression,
	type FieldSpelling,
	type FormNodeRef,
	type FormStepFilter,
	isTerm,
	SESSION_CONTEXT_FIELDS,
	type Term,
} from "@/lib/domain/expression/types";
import {
	locationPropertiesOf,
	organizationLevelsOf,
} from "@/lib/domain/organization";
import {
	CASE_NODE_ATTRIBUTE_PROPERTIES,
	isStandardCaseListProperty,
} from "@/lib/domain/standardCaseProperties";
import { asUuid } from "@/lib/domain/uuid";
import {
	entryDatumIds,
	formLinkProjectionContext,
} from "../formLinkProjection";
import { CASE_LIST_SEARCH_TEXT_DATA_NAME } from "../sessionContext";
import type { FormNodeProjection } from "./formNodeProjection";
import { refuse } from "./formParseIssues";
import type { FormParseScope } from "./formParseScope";
import type { FormSyntax } from "./formSyntax";

export interface FormPathBinder {
	readonly scope: FormParseScope;
	readonly projection?: FormNodeProjection;
	bind(node: FormSyntax, context: ExpressionContext): Expression;
	term(value: Term, node: FormSyntax): Expression;
	remember<T extends Expression | Term>(
		value: T,
		node: { readonly from: number; readonly to: number },
	): T;
	hint(node: FormSyntax): Expression | Term | undefined;
	worker(slug: string, source?: "worker-record"): Term;
}
interface Step {
	node: FormSyntax;
	where: FormSyntax[];
}
interface ReadPath {
	root?: FormSyntax;
	steps: Step[];
}
function flatten(node: FormSyntax): ReadPath {
	if (node.kind === "child") {
		if (node.descendant)
			refuse(
				"axis",
				node,
				"This path skips over unnamed steps. You can write each step, such as ../group/question.",
			);
		const path =
			node.left === undefined
				? {
						root: {
							kind: "root",
							from: node.from,
							to: node.from + 1,
						} as FormSyntax,
						steps: [],
					}
				: flatten(node.left);
		const right = flatten(node.step);
		if (right.root !== undefined)
			path.steps.push({ node: right.root, where: [] });
		path.steps.push(...right.steps);
		return path;
	}
	if (node.kind === "filter") {
		const path = flatten(node.base);
		const last = path.steps.at(-1);
		if (
			last === undefined ||
			["self", "parent", "group", "call"].includes(last.node.kind)
		)
			refuse(
				"filter-root",
				node,
				"This filter needs a named question, record list or data table step. You can move the [ ] onto that step.",
			);
		last.where.push(node.where);
		return path;
	}
	if (node.kind === "root" || node.kind === "call" || node.kind === "group")
		return { root: node, steps: [] };
	return { steps: [{ node, where: [] }] };
}
function name(
	node: FormSyntax,
): { name: string; attribute: boolean } | undefined {
	if (node.kind === "axis") {
		if (node.axis !== "attribute" && node.axis !== "child")
			refuse(
				"axis",
				node,
				`The ${node.axis} axis isn't available here. You can write each named step directly.`,
			);
		const result = name(node.value);
		return result === undefined
			? undefined
			: { name: result.name, attribute: node.axis === "attribute" };
	}
	if (node.kind !== "name") return undefined;
	if (node.wildcard)
		refuse(
			"wildcard",
			node,
			"A * step reads whatever happens to be there, so a new question or a rename could change what it means. You can name the question or property you mean.",
		);
	return { name: node.name, attribute: false };
}
function plain(step: Step | undefined, expected: string): boolean {
	if (step === undefined || step.where.length > 0) return false;
	const named = name(step.node);
	return named?.name === expected && !named.attribute;
}
function expressionTerm(
	value: Expression | Term | undefined,
): Term | undefined {
	return value?.kind === "term"
		? value.term
		: value !== undefined && isTerm(value)
			? value
			: undefined;
}

function rowValue(
	binder: FormPathBinder,
	steps: readonly Step[],
	context: ExpressionContext,
	whole: FormSyntax,
): Term {
	const row = activeRowScope(context);
	const first = steps[0];
	if (row === undefined || first === undefined)
		refuse(
			"row-step-after-value",
			whole,
			"This path needs one property of the selected row.",
		);
	if (steps.some((step) => step.where.length > 0))
		refuse(
			"filter-root",
			whole,
			"This filter belongs on the row before its property. You can move the [ ] onto that row.",
		);
	if (first.node.kind === "parent")
		refuse(
			"row-leaves-record",
			whole,
			"Inside a row query, .. leaves the row. You can write current()/.. to start from this question, or #form/ to name an answer.",
		);
	const named = name(first.node);
	if (named === undefined)
		refuse(
			"row-step-after-value",
			whole,
			"This path needs the name of one property of the selected row.",
		);
	const tail = steps.slice(1);
	if (row.kind === "case") {
		if (named.attribute && !CASE_NODE_ATTRIBUTE_PROPERTIES.has(named.name))
			refuse(
				"case-row-attribute",
				first.node,
				`A record's @case_id, @case_type, @owner_id and @status can be read here, and @${named.name} can't. If ${named.name} is a property, you can read it without the @.`,
			);
		if (named.attribute && named.name === "case_type" && tail.length === 0)
			return { kind: "case-row-type" };
		if (!named.attribute && named.name === "index" && tail.length === 1) {
			const identifier = name(tail[0].node);
			if (identifier !== undefined && !identifier.attribute)
				return {
					kind: "case-index",
					identifier: identifier.name,
					...(row.caseType === undefined ? {} : { caseType: row.caseType }),
				};
		}
		if (tail.length > 0)
			refuse(
				"row-step-after-value",
				whole,
				`${named.name} is a single value, so this path can't go past it. You can read the related record with its own query.`,
			);
		const property =
			!named.attribute && named.name === "name" ? "case_name" : named.name;
		let caseType = row.caseType;
		if (caseType === undefined && !isStandardCaseListProperty(property)) {
			const declares = (type: string) =>
				context.facts.caseTypes.some(
					(candidate) =>
						candidate.name === type &&
						candidate.properties.some((value) => value.name === property),
				);
			const hint = expressionTerm(binder.hint(whole));
			if (
				hint?.kind === "prop" &&
				hint.property === property &&
				hint.caseType !== undefined &&
				declares(hint.caseType)
			)
				caseType = hint.caseType;
			else {
				const matches = context.facts.caseTypes.filter((type) =>
					type.properties.some((value) => value.name === property),
				);
				if (matches.length !== 1)
					refuse(
						"case-query-untyped",
						whole,
						`You can add [@case_type = '${matches[0]?.name ?? "visit"}'] so this query knows which records to read.`,
					);
				caseType = matches[0].name;
			}
		}
		return {
			kind: "prop",
			property,
			...(caseType === undefined ? {} : { caseType }),
		};
	}
	if (row.kind === "table") {
		if (binder.scope.lookup === "unavailable")
			refuse(
				"lookup-unavailable",
				whole,
				"Project data is still loading, so this table read can't be checked yet. You can try again in a moment.",
			);
		const table = binder.scope.lookup.get(row.tableId);
		const column =
			!named.attribute && tail.length === 0
				? table?.columns.find((column) => column.wireName === named.name)
				: undefined;
		if (column === undefined)
			refuse(
				"unknown-column",
				whole,
				`The ${table?.name ?? "selected"} table has no column ${named.name}. You can use one of its columns: ${table?.columns.map((column) => column.wireName).join(", ") ?? "none"}.`,
			);
		return { kind: "table-column", tableId: row.tableId, columnId: column.id };
	}
	if (row.kind === "location") {
		if (
			!named.attribute &&
			named.name === "location_data" &&
			tail.length === 1
		) {
			const property = name(tail[0].node);
			const matches =
				property === undefined || property.attribute
					? []
					: Object.values(locationPropertiesOf(binder.scope.doc)).filter(
							(value) => value.slug === property.name,
						);
			if (matches.length !== 1)
				refuse(
					"unknown-location-property",
					whole,
					`Places have no property ${property?.name ?? "at this path"}. You can check the place properties in App setup, Organization.`,
				);
			return { kind: "location-field", field: { property: matches[0].uuid } };
		}
		if (tail.length > 0)
			refuse(
				"row-step-after-value",
				whole,
				`${named.name} is a single value, so this path can't go past it.`,
			);
		if (named.attribute && (named.name === "id" || named.name === "type"))
			return { kind: "location-field", field: named.name };
		if (named.attribute && named.name.endsWith("_id")) {
			const code = named.name.slice(0, -3);
			const levels = Object.values(
				organizationLevelsOf(binder.scope.doc),
			).filter((level) => level.code === code);
			if (levels.length !== 1)
				refuse(
					"unknown-level",
					whole,
					`There's no organization level with the code ${code}. You can check the level codes in App setup, Organization.`,
				);
			return { kind: "location-field", field: { level: levels[0].uuid } };
		}
		if (
			!named.attribute &&
			["name", "site_code", "external_id", "latitude", "longitude"].includes(
				named.name,
			)
		)
			return {
				kind: "location-field",
				field: named.name as
					| "name"
					| "site_code"
					| "external_id"
					| "latitude"
					| "longitude",
			};
		refuse(
			"unknown-location-property",
			whole,
			`Places have no property ${named.name}. You can check the place properties in App setup, Organization.`,
		);
	}
	refuse(
		"row-step-after-value",
		whole,
		"This path needs a property from its row.",
	);
}

/** The case type of the search whose results the slot's entry holds. */
function searchedCaseType(context: ExpressionContext): string | undefined {
	const searched = context.supplies.searchResults;
	return searched === undefined
		? undefined
		: context.facts.moduleCaseTypes.get(searched.module);
}

function instancePath(
	binder: FormPathBinder,
	path: ReadPath,
	context: ExpressionContext,
	whole: FormSyntax,
): Expression {
	const root = path.root;
	if (
		root?.kind !== "call" ||
		root.name !== "instance" ||
		root.args.length !== 1 ||
		root.args[0].kind !== "string"
	)
		refuse(
			"instance-argument",
			whole,
			"instance() needs the name of what it reads in quotes, such as instance('casedb').",
		);
	const id = root.args[0].value;
	const steps = path.steps;
	const form = context.form;
	const entryDatums = () =>
		form === undefined
			? []
			: entryDatumIds(
					binder.scope.doc,
					formLinkProjectionContext(binder.scope.doc, {
						entryMetadataOnly: true,
					}),
					form.moduleUuid,
					form.formUuid,
				);
	if (id === "commcaresession") {
		if (
			!plain(steps[0], "session") ||
			steps.length < 3 ||
			steps.some((step) => step.where.length > 0)
		)
			refuse(
				"unknown-datum",
				whole,
				"This session path doesn't name a value the form opens with. You can read a question or a case property instead.",
			);
		const branch = name(steps[1].node);
		const leaf = name(steps[steps.length - 1].node);
		if (leaf === undefined || leaf.attribute)
			refuse("unknown-datum", whole, "This session path needs a named value.");
		if (
			branch?.name === "user" &&
			steps.length === 4 &&
			plain(steps[2], "data")
		)
			return binder.term(binder.worker(leaf.name), whole);
		if (
			branch?.name === "context" &&
			steps.length === 3 &&
			SESSION_CONTEXT_FIELDS.includes(
				leaf.name as (typeof SESSION_CONTEXT_FIELDS)[number],
			)
		)
			return binder.term(
				{
					kind: "session-context",
					field: leaf.name as (typeof SESSION_CONTEXT_FIELDS)[number],
				},
				whole,
			);
		// Core adds `stringquery` beside the datums, from each frame step's
		// last case list search (`SessionInstanceBuilder.addUserQueryData`);
		// no Nova datum takes that id, so it shadows none.
		if (
			branch?.name === "data" &&
			steps.length === 3 &&
			leaf.name === CASE_LIST_SEARCH_TEXT_DATA_NAME
		)
			return binder.remember({ kind: "case-list-search-text" }, whole);
		if (branch?.name === "data" && steps.length === 3) {
			const datums = entryDatums();
			const datum = datums.find((datum) => datum.id === leaf.name);
			if (datum === undefined || datum.refs.length === 0)
				refuse(
					"unknown-datum",
					whole,
					`This form doesn't open with a session value named "${leaf.name}". ${
						datums.some((row) => row.refs.length > 0)
							? `Its session values are ${datums
									.filter((row) => row.refs.length > 0)
									.map((row) => row.id)
									.join(", ")}.`
							: "You can read a question or a case property instead."
					}`,
				);
			if (!datum.scalar)
				refuse(
					"multi-select-datum-value",
					whole,
					`${leaf.name} holds the chosen records as a list. You can read them as instance('${leaf.name}')/results/value.`,
					`instance('${leaf.name}')/results/value`,
				);
			const hint = expressionTerm(binder.hint(whole));
			const ref =
				hint?.kind === "session-datum" &&
				datum.refs.some((ref) => datumRefKey(ref) === datumRefKey(hint.datum))
					? hint.datum
					: datum.refs[0];
			return binder.term({ kind: "session-datum", datum: ref }, whole);
		}
		refuse(
			"unknown-datum",
			whole,
			`This form doesn't open with a session value at this path. You can read a question or a case property instead.`,
		);
	}
	if (id === "groups")
		refuse(
			"groups-held",
			whole,
			"Reading the worker's case-sharing groups isn't available yet. You can read the places the worker is assigned to with instance('locations') instead.",
		);
	if (id === "results") {
		const ownType =
			form === undefined
				? undefined
				: context.facts.moduleCaseTypes.get(form.moduleUuid);
		refuse(
			"search-results-remote",
			whole,
			`This form opens after the worker leaves the search, so its results are gone by then. You can read the case the worker chose${
				ownType === undefined ? "" : ` with #${ownType}/`
			} instead.`,
		);
	}
	if (id === "search-input:results" || id === "search-input:results:inline") {
		// Core builds this instance as <input><field name="…">answer</field>
		// …</input> (`VirtualInstances.java::buildSearchInputInstance`), so an
		// answer is read as /input/field[@name = '<name>'] with the name quoted.
		const field = steps[1];
		const named = field === undefined ? undefined : name(field.node);
		const predicate = field?.where.length === 1 ? field.where[0] : undefined;
		const keyed =
			predicate?.kind === "binary" &&
			predicate.op === "=" &&
			predicate.right.kind === "string"
				? { key: name(predicate.left), value: predicate.right.value }
				: undefined;
		if (
			steps.length !== 2 ||
			!plain(steps[0], "input") ||
			named?.name !== "field" ||
			named.attribute ||
			keyed?.key?.name !== "name" ||
			!keyed.key.attribute
		)
			refuse(
				"unknown-search-input",
				whole,
				`This search answer path needs one of the menu's search fields, read as instance('${id}')/input/field[@name = 'field name'].`,
			);
		const input = form?.searchInputs.find(
			(input) => input.name === keyed.value,
		);
		if (input === undefined)
			refuse(
				"unknown-search-input",
				whole,
				`This menu's search has no field called ${keyed.value}.`,
			);
		return binder.term({ kind: "input", searchInputUuid: input.uuid }, whole);
	}
	if (
		plain(steps[0], "results") &&
		plain(steps[1], "value") &&
		steps.length === 2
	) {
		const chosen = entryDatums().find((row) => !row.scalar && row.id === id);
		const ref = chosen?.refs.find((ref) => ref.kind === "selected-case");
		if (ref !== undefined && ref.kind === "selected-case")
			return binder.remember(
				{ kind: "selected-cases", module: ref.module },
				whole,
			);
	}
	let base: Extract<Expression, { kind: "cases" | "table-rows" | "locations" }>;
	let row: RowScope;
	let predicates: readonly FormSyntax[];
	const consumed = 2;
	const rowsStep = steps[1];
	if (id === "casedb" || id === "results:inline") {
		if (
			!plain(steps[0], id === "casedb" ? "casedb" : "results") ||
			rowsStep === undefined ||
			name(rowsStep.node)?.name !== "case"
		)
			refuse(
				"instance-unknown",
				whole,
				`The records in ${id} are at instance('${id}')/${id === "casedb" ? "casedb" : "results"}/case.`,
			);
		predicates = rowsStep.where;
		if (id === "results:inline") {
			const guard = predicates[0];
			const expected =
				guard?.kind === "call" &&
				guard.name === "not" &&
				guard.args.length === 1
					? guard.args[0]
					: undefined;
			const excluded =
				expected?.kind === "binary" &&
				expected.op === "=" &&
				expected.left.kind === "name" &&
				expected.left.name === "commcare_is_related_case" &&
				expected.right.kind === "call" &&
				expected.right.name === "true" &&
				expected.right.args.length === 0;
			if (!excluded)
				refuse(
					"search-results-unexcluded",
					whole,
					"Search results also hold cases CommCare adds to show related details. You can read the cases the search found with instance('results:inline')/results/case[not(commcare_is_related_case = true())].",
				);
			predicates = predicates.slice(1);
		}
		base = {
			kind: "cases",
			source: id === "casedb" ? "casedb" : "search-results",
			where: [],
		};
		// First bind only the predicates that establish a row identity. The
		// checker owns the same inference used when admitting the final tree.
		const neutral = pushRowScope(context, {
			kind: "case",
			root: id === "casedb" ? "casedb" : "results:inline",
		});
		const identityPredicates: Expression[] = [];
		const collect = (node: FormSyntax): void => {
			if (node.kind === "group") {
				collect(node.value);
				return;
			}
			if (node.kind === "binary" && node.op === "and") {
				collect(node.left);
				collect(node.right);
				return;
			}
			if (node.kind !== "binary" || node.op !== "=") return;
			for (const [target, value] of [
				[node.left, node.right],
				[node.right, node.left],
			] as const) {
				const n = name(target);
				if (!n?.attribute || (n.name !== "case_type" && n.name !== "case_id"))
					continue;
				if (n.name === "case_type" && value.kind !== "string") continue;
				identityPredicates.push(binder.bind(node, neutral));
				return;
			}
		};
		predicates.forEach(collect);
		const inferred = expressionRowScope(
			{ ...base, where: identityPredicates },
			context,
		);
		const typed: CaseRowScope =
			inferred?.kind === "case"
				? inferred
				: { kind: "case", root: id === "casedb" ? "casedb" : "results:inline" };
		// A search's rows are the searched module's case type, so a custom
		// property binds to that type even where another type declares it too.
		const searched =
			id === "results:inline" && typed.caseType === undefined
				? searchedCaseType(context)
				: undefined;
		row = searched === undefined ? typed : { ...typed, caseType: searched };
	} else if (id === "locations") {
		if (
			!plain(steps[0], "locations") ||
			rowsStep === undefined ||
			name(rowsStep.node)?.name !== "location"
		)
			refuse(
				"instance-unknown",
				whole,
				"Places are at instance('locations')/locations/location.",
			);
		base = { kind: "locations", where: [] };
		row = { kind: "location", root: "locations" };
		predicates = rowsStep.where;
	} else {
		const tag = id.startsWith("item-list:")
			? id.slice("item-list:".length)
			: id;
		if (binder.scope.lookup === "unavailable")
			refuse(
				"lookup-unavailable",
				whole,
				`Project data is still loading, so this read of ${tag} can't be checked yet. You can try again in a moment.`,
			);
		const tables = [...binder.scope.lookup.values()].filter(
			(table) => table.tag === tag,
		);
		if (tables.length !== 1)
			refuse(
				"instance-unknown",
				whole,
				`This form can't read ${id}. A form can read records (casedb), the session (commcaresession), the Project's data tables by their tag, and places (locations).`,
			);
		const table = tables[0];
		if (
			!plain(steps[0], `${tag}_list`) ||
			rowsStep === undefined ||
			name(rowsStep.node)?.name !== tag
		)
			refuse(
				"table-path-mismatch",
				whole,
				`The rows of ${tag} are at instance('${tag}')/${tag}_list/${tag}.`,
			);
		base = { kind: "table-rows", tableId: table.id, where: [] };
		row = { kind: "table", root: "table", tableId: table.id };
		predicates = rowsStep.where;
	}
	const rowContext = pushRowScope(context, row);
	const projected = steps.slice(consumed);
	if (
		base.kind === "table-rows" &&
		predicates.length === 2 &&
		predicates[1].kind === "number" &&
		predicates[1].value === 1 &&
		projected.length === 1
	) {
		const value = rowValue(binder, projected, rowContext, whole);
		if (value.kind === "table-column")
			return binder.remember(
				{
					kind: "table-lookup",
					tableId: base.tableId,
					resultColumnId: value.columnId,
					where: binder.bind(predicates[0], rowContext),
				},
				whole,
			);
	}
	base = {
		...base,
		where: predicates.map((predicate) => binder.bind(predicate, rowContext)),
	};
	binder.remember(base, {
		from: root.from,
		to:
			projected[0]?.node.from === undefined
				? whole.to
				: (steps[consumed - 1]?.where.at(-1)?.to ??
					steps[consumed - 1].node.to),
	});
	if (projected.length === 0) return base;
	const value = binder.remember(
		rowValue(
			binder,
			projected,
			rowContext,
			projected.length === 1 ? projected[0].node : whole,
		),
		{ from: projected[0].node.from, to: whole.to },
	);
	return binder.remember({ kind: "project", of: base, value }, whole);
}

export function bindFormPath(
	binder: FormPathBinder,
	whole: FormSyntax,
	context: ExpressionContext,
): Expression {
	const path = flatten(whole);
	if (path.root?.kind === "call" && path.root.name === "instance")
		return instancePath(binder, path, context, whole);
	if (
		path.root !== undefined &&
		path.root.kind !== "root" &&
		!(
			path.root.kind === "call" &&
			path.root.name === "current" &&
			path.root.args.length === 0
		)
	)
		refuse(
			"filter-root",
			whole,
			"This path needs to start at a question, a record list or a data table. You can name that path directly.",
		);
	const first = path.steps[0];
	const row = activeRowScope(context);
	if (
		path.root === undefined &&
		first?.node.kind !== "hashtag" &&
		row !== undefined &&
		row.kind !== "repeat"
	)
		return binder.term(rowValue(binder, path.steps, context, whole), whole);
	const form = context.form;
	const projection = binder.projection;
	if (form === undefined || projection === undefined)
		refuse(
			"relative-no-context",
			whole,
			"This expression runs after the form has closed, so it has no current question. You can read a record property or a session value instead.",
		);
	let spelling: FieldSpelling | undefined =
		path.root?.kind === "root"
			? "absolute"
			: path.root?.kind === "call"
				? "current"
				: "relative";
	let logical = spelling === "absolute";
	let logicalPath: readonly string[] = [];
	let current =
		spelling === "absolute"
			? projection.graph.root
			: spelling === "current"
				? context.sourceNode
				: context.contextNode;
	const filters: FormStepFilter[] = [];
	let hasName = false;
	let steps = path.steps;
	if (spelling === "absolute") {
		if (!plain(steps[0], "data"))
			refuse(
				"unknown-field",
				whole,
				"A form's absolute answer path starts at /data. You can also use #form/question.",
			);
		steps = steps.slice(1);
	}
	if (steps[0]?.node.kind === "hashtag") {
		const hashtag = steps[0].node;
		if (hashtag.namespace !== "form")
			refuse(
				"unknown-hashtag",
				hashtag,
				"This path needs a #form/<path> answer reference.",
			);
		const exact = binder.scope.authoring?.resolveFormExactName?.(
			hashtag.segments,
		);
		let uuid = exact === undefined ? undefined : asUuid(exact);
		if (uuid === undefined) {
			let parent = form.formUuid;
			for (const segment of hashtag.segments) {
				const matches = (form.fieldOrder.get(parent) ?? []).filter(
					(id) => form.fields.get(id)?.id === segment,
				);
				if (matches.length !== 1) {
					uuid = undefined;
					break;
				}
				uuid = matches[0];
				parent = uuid;
			}
		}
		const short =
			uuid === undefined
				? binder.scope.authoring?.resolveFormShortName(hashtag.segments)
				: undefined;
		if (short !== undefined) uuid = asUuid(short);
		if (uuid === undefined || !form.fields.has(uuid))
			refuse(
				"unknown-field",
				hashtag,
				`There's no question at #form/${hashtag.segments.join("/")} in this form. You can write its full path, such as #form/group/question.`,
			);
		current = { kind: "field", uuid };
		spelling = undefined;
		logical = true;
		logicalPath = hashtag.segments;
		hasName = true;
		const filterContext = {
			...withFormContextNode(context, current),
			rows: [],
		};
		if (steps[0].where.length > 0)
			filters.push({
				step: current,
				where: steps[0].where.map((predicate) =>
					binder.bind(predicate, filterContext),
				) as [Expression, ...Expression[]],
			});
		steps = steps.slice(1);
	}
	if (current === undefined)
		refuse(
			"relative-no-context",
			whole,
			"This expression has no current question. You can read a record property or a session value instead.",
		);
	for (const step of steps) {
		let node = step.node;
		if (
			node.kind === "axis" &&
			(node.axis === "self" || node.axis === "parent")
		) {
			if (
				node.value.kind !== "call" ||
				node.value.name !== "node" ||
				node.value.args.length !== 0
			)
				refuse(
					"axis",
					node,
					"This axis needs a direct named path. You can use . or .. instead.",
				);
			node = { ...node, kind: node.axis === "self" ? "self" : "parent" };
		}
		if (node.kind === "parent") {
			if (hasName)
				refuse(
					"parent-after-name",
					node,
					"This path goes down to a named step and back up again. You can write the path to its destination directly.",
				);
			const parent = projection.graph.parent(current);
			if (parent === undefined)
				refuse(
					"relative-above-form",
					node,
					"This path climbs above the form. You can start it at #form/ instead.",
				);
			current = parent;
		} else if (node.kind !== "self") {
			const named = name(node);
			if (named === undefined)
				refuse(
					"axis",
					node,
					"This path needs one named step at a time. You can write each step, such as ../group/question.",
				);
			let matches: FormNodeRef[];
			if (
				logical &&
				!named.attribute &&
				(current.kind === "field" || current.kind === "form-root")
			) {
				const parent = current.kind === "field" ? current.uuid : current.form;
				logicalPath = [...logicalPath, named.name];
				const alias =
					binder.scope.authoring?.resolveFormExactName?.(logicalPath);
				matches = (form.fieldOrder.get(parent) ?? [])
					.filter((id) =>
						alias === undefined
							? form.fields.get(id)?.id === named.name
							: id === alias,
					)
					.map((uuid) => ({ kind: "field", uuid }));
			} else
				matches = projection.graph.children(current).filter((candidate) => {
					const value = projection.step(candidate);
					return (
						value?.name === named.name &&
						Boolean(value.attribute) === named.attribute
					);
				});
			if (matches.length !== 1)
				refuse(
					spelling === undefined || spelling === "absolute"
						? "unknown-field"
						: "relative-unknown",
					node,
					`From this question, ${named.attribute ? "@" : ""}${named.name} doesn't reach an available value. If you meant text, you can put it in quotes.`,
				);
			current = matches[0];
			hasName = true;
		}
		if (step.where.length > 0) {
			if (
				current.kind === "form-root" ||
				node.kind === "self" ||
				node.kind === "parent"
			)
				refuse(
					"filter-root",
					step.node,
					"This filter needs a named step. You can move the [ ] onto the question or attribute name.",
				);
			const filterContext = {
				...withFormContextNode(context, current),
				rows: [],
			};
			filters.push({
				step: current,
				where: step.where.map((predicate) =>
					binder.bind(predicate, filterContext),
				) as [Expression, ...Expression[]],
			});
		}
	}
	if (current.kind === "form-root" && spelling === "absolute")
		refuse(
			"form-root",
			whole,
			"/data names the whole form. You can name the question or group whose answer you want to read.",
		);
	const filterProperty =
		filters.length === 0
			? {}
			: { filters: filters as [FormStepFilter, ...FormStepFilter[]] };
	if (current.kind === "field")
		return binder.term(
			{
				...current,
				...(spelling === undefined ? {} : { spelling }),
				...filterProperty,
			},
			whole,
		);
	if (current.kind === "repeat-row")
		return binder.term(
			{
				...current,
				...(spelling === undefined ? {} : { spelling }),
				...filterProperty,
			},
			whole,
		);
	if (spelling !== "relative" && spelling !== "current")
		refuse(
			"unknown-field",
			whole,
			"This generated value needs a relative path from the question that reads it.",
		);
	return binder.term(
		{ kind: "form-node", node: current, spelling, ...filterProperty },
		whole,
	);
}
