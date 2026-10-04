"""Items whose facts no upstream checkout the image holds can give: authored here, each with where it was settled.

The manifest checks hold every key Nova's exports use to a surface item
(``proof/checks/manifest_usage.py``). A few of those keys are Nova's own
vocabulary, which no upstream code reads, or are read only by a runtime the
image does not hold (Formplayer), so no family can read them from source. Each
is authored here, as ``media-format`` is beside the manifest's entries, with
``authored: true``, what Nova writes, what each upstream does with it, and
``source`` naming where each fact was settled (``<repository>/<path>::<symbol>``,
``commcare-nova`` for Nova's own emitter). They change only by a reviewed edit
of this file; the pins do not move them.

Keys:

- ``csql-fn:search-value-mixes-quote-marks``: the fail-closed arm of a
  free-text search input's quote cascade, the CSQL Nova sends when the value
  holds both quote marks. HQ's CSQL table has no such function, so HQ's search
  refuses the query. Web Apps sends it only on a default search: a search the
  person starts runs only when its prompts validate, while a default search
  runs whatever its prompts' errors, with the hidden ``_xpath_query``
  evaluated over the prompts' answers.
- ``profile-property:<key>`` (the key percent-encoded as the ``profile``
  family's are: ``profile-property:CommCare%20App%20Name``) for each
  property Nova's local profile
  (``profile.ccpr``) sets that HQ's profile does not write (the ``profile``
  family's): ``CommCare App Name``, ``cc-app-version`` and
  ``cc-content-version``, which Core's ``ProfileParser`` stores like any
  property and no code in Core, Android or Formplayer reads at the pins; and
  ``cc-index-case-search-results``, which Formplayer reads
  (``FormplayerPropertyManager.isIndexCaseSearchResults``) and HQ writes only
  as a custom property (``profile.xml``'s ``app_profile.custom_properties``,
  under ``toggles.CUSTOM_PROPERTIES``).
"""

from __future__ import annotations

from proof.surface.model import Item, Sources, item

PROFILE_PARSER = "commcare-core/src/main/java/org/commcare/xml/ProfileParser.java::ProfileParser.addPropertySetter"
COMPILER = "commcare-nova/lib/commcare/compiler.ts"
NO_READER = "no code in Core, Android or Formplayer reads this key at the pins"

AUTHORED = {
    "csql-fn:search-value-mixes-quote-marks": {
        "source": [
            "commcare-nova/lib/commcare/predicate/termEmitter.ts::CSQL_UNREPRESENTABLE_RUNTIME_STRING",
            "commcare-hq/corehq/apps/case_search/filter_dsl.py::build_filter_from_ast",
            "formplayer/src/main/java/org/commcare/formplayer/services/MenuSessionRunnerService.java"
            "::MenuSessionRunnerService.doQuery",
            "commcare-core/src/main/java/org/commcare/session/RemoteQuerySessionManager.java"
            "::RemoteQuerySessionManager.getRawQueryParams",
        ],
        "facts": {
            "kind": "nova-fail-closed",
            "novaWrites": "the whole CSQL string `search-value-mixes-quote-marks()`, for a free-text input whose"
            " value holds both quote marks",
            "hq": "refused: build_filter_from_ast raises \"'search-value-mixes-quote-marks' is not a valid standalone"
            ' function"',
            "webApps": "sent only on a default search: doQuery runs a search the person starts only when its prompts"
            " validate, and a default search whatever their errors (isDefaultSearch ||"
            " screen.getErrors().isEmpty()), its hidden values evaluated over the prompts' answers"
            " (getRawQueryParams); HQ then refuses it",
        },
    },
    "profile-property:CommCare%20App%20Name": {
        "source": [f"{COMPILER}::generateProfile", PROFILE_PARSER],
        "facts": {"novaWrites": "the app's name", "readBy": [], "hqWrites": False, "note": NO_READER},
    },
    "profile-property:cc-app-version": {
        "source": [f"{COMPILER}::generateProfile", PROFILE_PARSER],
        "facts": {
            "novaWrites": "1",
            "readBy": [],
            "hqWrites": False,
            "note": f"{NO_READER} (Android's HiddenPreferences reads cc-app-version-tag, another key)",
        },
    },
    "profile-property:cc-content-version": {
        "source": [f"{COMPILER}::generateProfile", PROFILE_PARSER],
        "facts": {
            "novaWrites": "the document's mutation sequence the archive was compiled at (1 without one)",
            "readBy": [],
            "hqWrites": False,
            "note": NO_READER,
        },
    },
    "profile-property:cc-index-case-search-results": {
        "source": [
            "commcare-nova/lib/commcare/derivedProfile.ts",
            "formplayer/src/main/java/org/commcare/formplayer/util/FormplayerPropertyManager.java"
            "::FormplayerPropertyManager.isIndexCaseSearchResults",
            "commcare-hq/corehq/apps/app_manager/templates/app_manager/profile.xml",
            "commcare-hq/corehq/apps/app_manager/models/applications.py::Application.create_profile",
        ],
        "facts": {
            "novaWrites": "yes",
            "readBy": ["formplayer"],
            "formplayer": "indexes a case search's results as a case template when yes (CaseSearchHelper)",
            "hqWrites": "only as a custom property: profile.xml writes every app_profile.custom_properties key,"
            " which create_profile fills when toggles.CUSTOM_PROPERTIES is on for the domain",
        },
    },
}


def extract(sources: Sources) -> list[Item]:
    return [item(key, held["source"], authored=True, **held["facts"]) for key, held in sorted(AUTHORED.items())]
