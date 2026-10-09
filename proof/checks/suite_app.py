"""A known identity change on HQ's own suite-test app, for the checks' own controls.

``identity_change`` publishes HQ's suite-test app (``proof.hq.conftest``) as
Nova publishes, builds it (A), applies an update that keeps every id HQ
holds but changes one select value and one case property a form writes,
builds that (B), and returns both states' identity records. The framework's
tests use it where they need real differences whose every member is known.
"""

from __future__ import annotations

from lxml import etree

from proof.hq import operations
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration
from proof.hq.conftest import hq_test_app, nova_shaped_upload
from proof.hq.seams import build_seams
from proof.observe.build import build_state
from proof.observe.identity import app_identity

CONFIGURATION = Configuration(privileges={"CLOUDCARE"})
XFORMS = "http://www.w3.org/2002/xforms"

# The identity differences the update makes: (artifact, structural path, concrete path, kind).
CHANGED = frozenset(
    {
        ("form:0.0", "/questions/*/options/*", "/questions/~1data~1enum/options/1", "changed"),
        ("form:0.0", "/case_updates/*/*", "/case_updates/suite_test/address", "removed"),
        ("form:0.0", "/case_updates/*/*", "/case_updates/suite_test/street", "added"),
        ("case_types", "/*/properties/*", "/suite_test/properties/address", "removed"),
        ("case_types", "/*/properties/*", "/suite_test/properties/street", "added"),
    }
)


def _update(app, held):
    """The suite app as an update keeping HQ's ids.

    Its first form's ``enum`` option b is now c, and it writes ``address`` as ``street``.
    """
    held_modules = [module.unique_id for module in held.get_modules()]
    held_forms = [form.unique_id for form in held.get_forms()]
    forms = [form for module in app["modules"] for form in module["forms"]]
    for module, unique_id in zip(app["modules"], held_modules, strict=True):
        module["unique_id"] = unique_id
    for index, (form, unique_id) in enumerate(zip(forms, held_forms, strict=True)):
        source = app["_attachments"].pop(f"{form['unique_id']}.xml")
        if index == 0:
            tree = etree.fromstring(source.encode())
            option = next(
                value
                for value in tree.iter(f"{{{XFORMS}}}value")
                if value.text == "b" and etree.QName(value.getparent()).localname == "item"
            )
            option.text = "c"
            source = etree.tostring(tree, encoding="unicode")
            update = form["actions"]["update_case"]["update"]
            update["street"] = update.pop("address")
        form["unique_id"] = unique_id
        app["_attachments"][f"{unique_id}.xml"] = source
    return app


def identity_change(core_runner):
    """(A's builds and identities, B's builds and identities) for the suite app and its identity-changing update."""
    with hq_check(CONFIGURATION) as (state, record):
        app_id, _ = operations.publish(state, [nova_shaped_upload(hq_test_app(), "Suite app")])
        a = operations.held_app(state, app_id)
        with build_seams(previous=None):
            built_a, hq_build = build_state(a, record, "A")
            identities_a = app_identity(a, built_a.files, state.domain)
        saved = hq_build.saved_build()
        upload = nova_shaped_upload(_update(hq_test_app(), a), "Suite app", app_id="captured")
        result = operations.apply_upload(state, operations.with_app_id(upload, app_id))
        assert result.status == 200, result.response
        b = operations.held_app(state, app_id)
        with build_seams(previous=saved):
            built_b, _ = build_state(b, record, "B")
            identities_b = app_identity(b, built_b.files, state.domain)
    return (built_a, identities_a), (built_b, identities_b)
