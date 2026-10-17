"""The version floor's next step: a person raises the app's CommCare version on HQ's own settings page.

Contract: Nova's publish refuses an app below CommCare 2.57 and asks the
person to raise its version in HQ (``lib/deployment/preflight.ts``, the
``target-app`` check), whose settings page saves every setting it shows
(``views/settings.py::edit_commcare_settings``: the profile, then
``views/apps.py::edit_app_attr``). Nova's drift check then compares what
that save changed with what it compares, and the fill of an empty shell
takes no setting from the shell. The plausible failures: a save that
changes something the drift check compares (then every raised app stops at
the next publish with ``hq_changed``), a save that writes Nova's own
settings differently on an app that holds none of them (which the notice and
the dialog say the person will be shown), and a fill that keeps the values
the settings page wrote into a shell.

HQ's own app settings page, loaded in Chromium for an app at 2.53.0, has its
CommCare Version select changed to 2.57.0 and its Save clicked, with HQ's
source read before and after, over:

- a published app that holds Nova's seventeen profile properties
  (``prompt-widgets``): the paths that differ are the version, the save's
  time stamp, ``profile.features.users`` and six profile properties Nova does
  not write, none of which the drift check compares;
- the same app with no profile properties, as every app published before
  step 2 holds: the save also stores ``cc-show-saved`` and
  ``cc-show-incomplete``, which Nova writes;
- an empty shell: ``modules`` stays empty, and the update that fills it,
  which Nova builds over the shell's source with its profile properties
  emptied, leaves ``profile.properties`` exactly Nova's seventeen.
"""

from __future__ import annotations

import dataclasses
import json

from proof.editors import pages
from proof.editors.conftest import corpus_document, record_timing
from proof.hq import operations
from proof.hq.check import hq_check

DOCUMENT = "prompt-widgets"
BELOW, RAISED = "2.53.0", "2.57.0"
VERSION_SELECT = "#build_spec-input"
# A person's choice of the raised version in the CommCare Version select, by the label the page shows for it: the
# page binds each option to an object (``CommcareSettings.widgets.select``, no ``optionsValue``), so an option has no
# value of its own to choose by. The select's index set and its ``change`` dispatched, as a browser does when a
# person chooses, which Knockout's binding hears.
CHOOSE_BY_LABEL = """({selector, label}) => {
    const select = document.querySelector(selector);
    if (!(select instanceof HTMLSelectElement)) return {chosen: false, options: []};
    const options = [...select.options].map((option) => option.textContent.trim());
    const index = options.findIndex((text) => text === label || text === `* ${label}`);
    if (index < 0) return {chosen: false, options};
    select.focus();
    select.selectedIndex = index;
    select.dispatchEvent(new Event("input", {bubbles: true}));
    select.dispatchEvent(new Event("change", {bubbles: true}));
    return {chosen: true, options};
}"""
# The six profile properties HQ's settings page writes that Nova does not.
PAGE_ONLY_PROPERTIES = (
    "log_prop_daily",
    "log_prop_weekly",
    "loose_media",
    "purge-freq",
    "restore-tolerance",
    "user_reg_server",
)
# What the save changes on an app holding Nova's seventeen, by path of HQ's source.
RAISED_PATHS = sorted(
    [
        "build_spec.version",
        "last_modified",
        "profile.features.users",
        *(f"profile.properties.{name}" for name in PAGE_ONLY_PROPERTIES),
    ]
)
# The two settings Nova writes that the page stores on an app holding none (part of the seventeen).
NOVA_WRITTEN = ("cc-show-incomplete", "cc-show-saved")


def _paths(value, prefix=()):
    """Every leaf of a JSON value by its dotted path; a list, and an empty object, is a leaf."""
    if isinstance(value, dict) and value:
        found = {}
        for key, child in value.items():
            found.update(_paths(child, (*prefix, key)))
        return found
    return {".".join(prefix): value}


def _comparable(source):
    """HQ's source read with each form's id, which every read of the source mints afresh, and the attachment its
    form source is held under named by the form's place in the app instead."""
    source = json.loads(json.dumps(source))
    places = {}
    for module_index, module in enumerate(source.get("modules", [])):
        for form_index, form in enumerate(module.get("forms", [])):
            places[form["unique_id"]] = f"form-{module_index}-{form_index}"
            form["unique_id"] = places[form["unique_id"]]
    source["_attachments"] = {
        f"{places.get(name[: -len('.xml')], name[: -len('.xml')])}.xml": value
        for name, value in source.get("_attachments", {}).items()
    }
    return source


def _differing(before, after):
    left, right = _paths(_comparable(before)), _paths(_comparable(after))
    return sorted(path for path in set(left) | set(right) if left.get(path) != right.get(path))


def _with_raised_version_offered(state):
    """HQ's build configuration offering CommCare 2.57.0 beside the project space's default, as a server whose
    menu holds both does: the version select lists each menu build (``views/apps.py``, its ``options_map``)."""
    from corehq.apps.builds.models import BuildMenuItem, BuildSpec, CommCareBuildConfig

    with state.operation("build-menu", RAISED.encode()):
        config = CommCareBuildConfig.fetch()
        config.menu.append(BuildMenuItem(build=BuildSpec(version=RAISED, latest=True), label=f"CommCare {RAISED}"))
        config.save()
        CommCareBuildConfig.fetch.clear(CommCareBuildConfig)


def _raised(driver, state, app_id):
    """HQ's settings page for the app, its CommCare Version changed to 2.57.0 and saved as a person saves it."""
    from django.urls import reverse

    from proof.editors.hq import HQAnswers, editor_build

    page = pages.APP_SETTINGS
    path = reverse(page.view, args=[state.domain, app_id])
    save = {"method": "POST", "pathname": reverse(page.save, args=[state.domain, app_id])}
    editor_build()
    answers = HQAnswers(state)
    run = driver.run(
        [
            {"goto": path},
            {"until": "pages/ready", "arg": {"bar": page.bar}},
            {"settle": True},
            {"eval": CHOOSE_BY_LABEL, "arg": {"selector": VERSION_SELECT, "label": f"CommCare {RAISED}"}},
            {"click": f"{page.bar} > .btn:not(.disabled)"},
            {"awaitRequest": save},
            {"until": "pages/saved", "arg": page.bar},
            {"settle": True},
            {"call": "pages/save_state", "arg": page.bar},
        ],
        answer=answers,
    )
    answers.check()
    chosen = run["outcomes"][3]["value"]
    assert chosen["chosen"], f"the CommCare Version select offers no CommCare {RAISED}: {chosen['options']}"
    saves = [e for e in answers.exchanges if e.method == "POST" and e.path == save["pathname"]]
    assert len(saves) == 1 and saves[0].status == 200, [(e.path, e.status) for e in saves]
    record_timing("page_save:version raise", run["seconds"])
    return run["outcomes"][-1]["value"]


def _source(state, app_id):
    return operations.app_source(state, app_id)


def _configuration(document):
    return dataclasses.replace(document.exports["minimum"].configuration.hq(), commcare_version=BELOW)


def _published_below(state, export):
    """The app as Nova's first publish leaves it, on a project space whose default build is below the floor: the
    shell, then the content Nova sent over it (built over a source at the floor, which an app published before the
    floor was not held to)."""
    app_id, (created,) = operations.publish(state, [export.create.upload()])
    assert created.status == 201
    filled = operations.apply_upload(state, operations.with_app_id(export.content.upload(), app_id))
    assert filled.status == 200, filled.response
    return app_id


def test_raising_the_version_changes_nothing_the_drift_check_compares_on_an_app_nova_published(
    hq, core_runner, editor_driver
):
    document = corpus_document(DOCUMENT)
    with hq_check(_configuration(document)) as (state, _):
        app_id = _published_below(state, document.exports["minimum"])
        _with_raised_version_offered(state)
        before = _source(state, app_id)
        assert before["build_spec"]["version"] == BELOW
        assert not set(PAGE_ONLY_PROPERTIES) & set(before["profile"]["properties"])
        _raised(editor_driver, state, app_id)
        after = _source(state, app_id)
    assert after["build_spec"]["version"] == RAISED
    assert _differing(before, after) == RAISED_PATHS, " ".join(_differing(before, after))


def test_raising_the_version_stores_novas_two_settings_on_an_app_that_holds_no_profile_properties(
    hq, core_runner, editor_driver
):
    document = corpus_document(DOCUMENT)
    with hq_check(_configuration(document)) as (state, _):
        app_id = _published_below(state, document.exports["minimum"])
        with state.operation("legacy-profile", b"no-profile-properties"):
            app = operations.held_app(state, app_id)
            app.profile = {**app.profile, "properties": {}}
            app.save()
        _with_raised_version_offered(state)
        before = _source(state, app_id)
        _raised(editor_driver, state, app_id)
        after = _source(state, app_id)
    differing = _differing(before, after)
    for name in NOVA_WRITTEN:
        assert f"profile.properties.{name}" in differing, differing
        assert after["profile"]["properties"][name] == "no", name
    assert set(RAISED_PATHS) <= set(differing), differing


def test_an_empty_shell_raised_in_hq_is_filled_with_novas_seventeen_settings(hq, core_runner, editor_driver):
    document = corpus_document(DOCUMENT)
    export = document.exports["minimum"]
    with hq_check(_configuration(document)) as (state, _):
        app_id, (created,) = operations.publish(state, [export.create.upload()])
        assert created.status == 201
        _with_raised_version_offered(state)
        _raised(editor_driver, state, app_id)
        raised = _source(state, app_id)
        assert raised["build_spec"]["version"] == RAISED and raised["modules"] == []
        assert raised["profile"].get("properties"), "the settings page wrote no profile properties into the shell"
        # Nova's fill of a shell is built over its source with the profile properties emptied, so it carries
        # Nova's seventeen alone: the captured content import, built over HQ's empty profile, is that update.
        content = json.loads(operations.upload_field(export.content.upload(), "app_file"))
        filled = operations.apply_upload(state, operations.with_app_id(export.content.upload(), app_id))
        assert filled.status == 200, filled.response
        after = _source(state, app_id)
    assert after["build_spec"]["version"] == RAISED
    assert after["profile"]["properties"] == content["profile"]["properties"]
    assert len(after["profile"]["properties"]) == 17
