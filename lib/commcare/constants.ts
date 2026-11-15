/** CommCare platform constants — single source of truth. */

import { captureFieldKinds } from "@/lib/domain";
import { MAX_SUBMITTED_CAPTURE_COUNT } from "@/lib/domain/captureFormats";
import { CASE_TYPE_PATTERN } from "@/lib/domain/expression/types";

/**
 * Case property names Nova refuses in update_case / case_preload blocks: the
 * entries of commcare-hq/corehq/apps/app_manager/static/app_manager/json/case-reserved-words.json
 * (`HQ_CASE_RESERVED_WORDS`), which HQ rejects there, but its two hyphenated
 * spellings `date-opened` and `external-id`, which Nova's property name
 * grammar refuses on its own (`lib/domain/casePropertyName.ts`), plus
 * `owner_id`, which HQ's wire accepts in an update block and Nova reserves by
 * its own rule: a case's owner is authored as the owner of a case write,
 * never as a property.
 * CCHQ's alternate standard-property spellings are rejected by the domain
 * schema and deliberately do not survive as a live compatibility table here.
 */
export const RESERVED_CASE_PROPERTIES: ReadonlySet<string> = new Set([
	// From case-reserved-words.json
	"actions",
	"case_id",
	"case_name",
	"case_type",
	"case_type_id",
	"closed",
	"closed_by",
	"closed_on",
	"commtrack",
	"create",
	"computed_",
	"computed_modified_on_",
	"date",
	"date_modified",
	"date_opened",
	"doc_type",
	"domain",
	"index",
	"indices",
	"initial_processing_complete",
	"last_modified",
	"modified_by",
	"modified_on",
	"opened_by",
	"opened_on",
	"parent",
	"referrals",
	"server_modified_on",
	"server_opened_on",
	"status",
	"type",
	"user_id",
	"userid",
	"version",
	"xform_id",
	"xform_ids",
	// Nova's own rule: a case's owner is authored as the owner of a case write.
	"owner_id",
]);

/**
 * CommCare HQ's own reserved case property words, exactly its
 * `case-reserved-words.json` (`helpers/validators.py::load_case_reserved_words`):
 * HQ's build refuses a form that writes or preloads one
 * (`IndexedFormBaseValidator.check_case_properties`, on the last step of a
 * path). The reader judges HQ's apps by it; `owner_id` is none of HQ's.
 */
export const HQ_CASE_RESERVED_WORDS: ReadonlySet<string> = new Set([
	...[...RESERVED_CASE_PROPERTIES].filter((word) => word !== "owner_id"),
	"date-opened",
	"external-id",
]);

/** Safe rename targets for reserved property names the LLM might generate. */
export const RESERVED_RENAME_MAP: Readonly<Record<string, string>> = {
	date: "visit_date",
	status: "case_status",
	type: "case_category",
	parent: "parent_case",
	index: "case_index",
	version: "form_version",
	domain: "case_domain",
	closed: "is_closed",
	actions: "case_actions",
	create: "create_info",
};

/**
 * Field kinds whose answer is an attachment rather than a value — they
 * cannot be saved as case properties on this path.
 *
 * Derived from the domain's `captureFieldKinds` so the two cannot drift:
 * a kind that is a capture in the vocabulary is a capture at the case
 * boundary too.
 */
export const MEDIA_FIELD_KINDS: ReadonlySet<string> = new Set(
	captureFieldKinds,
);

/**
 * The most attachments one form submission may carry.
 *
 * Formplayer counts this at SUBMIT time, over the session's media
 * directory rather than over the surviving answers:
 * `FormSubmissionHelper::getMultiPartFormBody` lists the directory and
 * throws `form.upload.attachments.limit.exceeded` when
 * `files.length > maxAttachmentsPerForm`, injected from
 * `formplayer.form.submit.max_attachments=50` in Formplayer's
 * `application.properties` (unset in both override files). The whole
 * submission aborts, and the worker has no way to remove a file no live
 * question references.
 *
 * Nova bounds what it can bound exactly — a form's non-repeating capture
 * fields — at the commit gate. Captures inside a repeat are unbounded at
 * authoring time because the worker chooses the iteration count, and no
 * authoring-time check closes that.
 */
export const MAX_FORM_ATTACHMENTS = MAX_SUBMITTED_CAPTURE_COUNT;

/** Standard create-block properties (not user case properties). */
export const STANDARD_CREATE_PROPS: ReadonlySet<string> = new Set([
	"case_type",
	"case_name",
	"owner_id",
]);

/** Valid case property name: starts with a letter, then letters/digits/underscores/hyphens. */
export const CASE_PROPERTY_REGEX = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

/** A case type: CommCare HQ's case type grammar, held in the domain. */
export const CASE_TYPE_REGEX = CASE_TYPE_PATTERN;

/** Nova's XForm element names: an ASCII letter or underscore, then letters, digits,
 * underscores or hyphens. XML itself permits more; this is Nova's vocabulary. */
export const XML_ELEMENT_NAME_REGEX = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;

/** Maximum length for case type names (CommCare Core CaseXmlParser constraint). */
export const MAX_CASE_TYPE_LENGTH = 255;

/** Maximum length of a case-index identifier (HQ database column constraint). */
export const MAX_CASE_INDEX_IDENTIFIER_LENGTH = 255;

/** Maximum length for case property names (CommCare Core CaseXmlParser constraint). */
export const MAX_CASE_PROPERTY_LENGTH = 255;
