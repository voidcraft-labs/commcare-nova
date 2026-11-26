"""Case-property spelling and reserved names used by independent proof readers."""

import re

# The names a SaveToCase block's ``update`` row may hold that Nova reserves for a case's own facts or as a word in
# ``case-reserved-words.json`` (``lib/domain/standardCaseProperties.ts::FORBIDDEN_CASE_OPERATION_WRITE_PROPERTIES``,
# less the block's own rows ``case_type``, ``case_name`` and ``owner_id``); ``proof/ci/__tests__/manifestReaders.test.ts``
# holds it to that set.
SAVE_TO_CASE_RESERVED_UPDATE_KEYS = frozenset(
    {
        "actions",
        "case_id",
        "case_type_id",
        "closed",
        "closed_by",
        "closed_on",
        "commtrack",
        "computed_",
        "computed_modified_on_",
        "create",
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
        "name",
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
    }
)

# The keys of HQ's search index Nova reads as a record's own information
# (``lib/commcare/suite/case-search/requestOrder.ts::SERVER_ORDER_RECORD_KEYS``), and the names Nova reserves for a case's own facts
# or as CommCare HQ's reserved words (``lib/domain/standardCaseProperties.ts::FORBIDDEN_CASE_OPERATION_WRITE_PROPERTIES``:
# the SaveToCase set with the block's own action rows).
SERVER_ORDER_RECORD_KEYS = frozenset(
    {"@case_id", "@owner_id", "@case_type", "@status", "name", "case_name", "external_id", "date_opened", "last_modified"}
)
CASE_OPERATION_OWN_ROWS = frozenset({"case_type", "case_name", "owner_id"})
# SQL keeps this value apart from case_json, so the Search index lacks it.
SERVER_SEARCH_DEVICE_ONLY_KEYS = frozenset({"location_id"})


def order_key_reserved(key):
    return key not in SERVER_ORDER_RECORD_KEYS and (key in SAVE_TO_CASE_RESERVED_UPDATE_KEYS or key in CASE_OPERATION_OWN_ROWS)



def searchable_order_key(key):
    """A literal order key held by Nova's exact property grammar and server index policy."""
    if key in SERVER_ORDER_RECORD_KEYS:
        return True
    return (
        1 <= len(key) <= 255 and re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]*", key) is not None
        and key not in {"date-opened", "external-id"} and not order_key_reserved(key)
        and key not in SERVER_SEARCH_DEVICE_ONLY_KEYS
    )
