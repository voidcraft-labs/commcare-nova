"""HQ's regeneration of the expander documents ``ExpanderRuntimeTest`` runs (``expander`` family).

``expander.test.ts`` writes every document it admits (schema-parsed and
fully validated) with its manifest when ``NOVA_EXPANDER_EVIDENCE_DIR`` names
a directory (``lib/commcare/__tests__/expanderEvidence.ts``). For each
document its double-digit test expands (a case list column over eleven
options), HQ imports it and regenerates its suite (``<id>.hq-suite.xml``)
and its authored English app strings (``<id>.hq.app_strings.txt``), and the
step lists those documents, one id per line, in ``double-digit.txt``, which
``ExpanderRuntimeTest`` reads. That HQ publishes and builds every expander
document, and Core admits each build and each CCZ, is the corpus checks'
(``proof/checks/bar.py``); the step returns the ids it regenerated.
"""

import json

from proof.native.hq_support import (
    NOVA_SERVER_ORIGIN,
    hand_assembled_suite,
    import_source,
    known_app_strings,
    native_check,
)

DOMAIN = "nova-expander-evidence"


def expander_corpus(session):
    exports = session.family("expander")
    manifest = json.loads((exports / "manifest.json").read_text())
    regenerated = []
    flags = {"CASE_SEARCH_ADVANCED", "FOLLOWUP_FORMS_AS_CASE_LIST_FORM"}
    with native_check(DOMAIN, validate=session.validate_form, flags=flags, server_origin=NOVA_SERVER_ORIGIN):
        for record in manifest:
            if not any("double-digit" in test for test in record["tests"]):
                continue
            source = exports / (record["id"] + ".json")
            app = import_source(source.read_bytes(), DOMAIN)
            app._id = "expander-evidence"
            app.version = 1
            app.custom_base_url = NOVA_SERVER_ORIGIN
            source.with_suffix(".hq-suite.xml").write_bytes(hand_assembled_suite(app))
            (exports / (record["id"] + ".hq.app_strings.txt")).write_text(known_app_strings(app, "en"))
            regenerated.append(record["id"])
    (exports / "double-digit.txt").write_text("".join(f"{document}\n" for document in regenerated))
    return regenerated
