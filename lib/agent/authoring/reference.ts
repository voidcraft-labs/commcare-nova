import { fieldKinds, fieldRegistry } from "@/lib/domain";

const fields = () =>
	fieldKinds
		.map((kind) => {
			const description =
				kind === "repeat"
					? 'Repeated questions. Use repeat.mode "user_controlled" for rows the worker adds, "count_bound" with count for a fixed number, or "query_bound" with ids_query for one row per record. Counts and queries are fixed when that repeat instance opens.'
					: fieldRegistry[kind].saDocs;
			return `${kind}: ${description}`;
		})
		.join("\n");

export const AUTHORING_REFERENCE = {
	fields,
	formLogic:
		() => `Form expressions use XPath. #form/name reads an answer, with a full path for nested fields; #case/property reads the record selected for this form. Registration and survey forms have no selected record. #user/property reads worker information. #search/name reads a Search answer in a Search-first workflow.

Use relevant for visibility, required for an answer requirement, and validate: {expr, msg} for a rule and its explanation. In validation, . is the current answer. For example, . >= 0 rejects negative ages. Hidden fields can calculate a value as answers change or use default_value once at form load. Existing-record writers start with the saved value.

Wording is Markdown. {{name}} inserts an answer; {{#case/property}} inserts a saved value. Names bind to identities, so renames keep references intact. Escape a literal opening brace or backslash with a backslash.

Use the form's caseWrite destinations for ordinary record creation and updates. Advanced operations handle other records, related records, and repeated updates. A form's after-submit links run after its answers have left scope; save an answer to a record before using it there.`,
	recordQueries:
		() => `Record filters, Results columns, Search rules, and advanced operation values use expressions. #case/property reads the current record, #search/name reads a Search answer, and #user/property reads worker information. Quote literal text: 'active'. Numbers and true()/false() can be written directly.

Use =, !=, <, <=, >, >=, and, or, not(), and +, -, *, div, mod. div produces a decimal; quotient(a,b) preserves integer division. Common values include concat(...), coalesce(...), if(condition,yes,no), number(value), date(value), datetime(value), date-add(date,quantity,'days'), format-date(date,format), and id-of('earlier_operation').

Conditions include is-blank(value), in(value,'a','b'), between(value,lower,upper), and all(...)/any(...). unbounded() omits a range end; optional fourth and fifth arguments to between set inclusive ends. selected-any(value,'a','b') and selected-all(value,'a','b') test several choices.

Relationships are children('CaseType'), ancestor('parent'), related('CaseType'), and self(). exists(relationship,condition), missing(relationship,condition), and count(relationship,condition) evaluate the condition on related records. via(ancestor('parent'), #case/property) reads a parent property.

lookup('Table','column',condition) reads a data-table value. Within its condition, #row/column reads that table's row. Names must be unambiguous; stable IDs from reads work when labels collide.

Search supports when-provided(#search/name,condition), starts-with(#case/property,value), fuzzy(...), phonetic(...), and fuzzy-date(...). matches-pattern(value,'pattern') is available in Search required and validation rules. Conditions before record selection can use Search answers, worker information, and constants, but cannot read an unselected record.`,
	automations:
		() => `Automations describe conditional alerts and automatic record updates. They produce setup guidance for CommCare HQ; Preview does not run them. Read an existing automation before replacing it. Preserve identities for retained rules and nested items; omitted items are removed.

Messages are ordinary text with insertions such as {{#case/case_name}} and {{#recipient/first_name}}. Parent and host references require that relationship to exist. Host references require one extension; an ambiguous host cannot be used. Message references cannot use owner, host, or last_modified_by, which HQ reserves in its formatting context.

Recipient filters apply to recipients resolved as user accounts. A referenced filter property must be present on every triggering record. Email has one body: plain text or HTML. For a time read from a case property, provide a valid time beginning with H:MM or HH:MM; invalid or blank values fall back to noon. Registered IDs and setup-only instructions must match the target HQ project.

Nova checks representability before saving. Setup guidance names the remaining steps in HQ; saving an automation in Nova does not install or activate it there.`,
} as const;
