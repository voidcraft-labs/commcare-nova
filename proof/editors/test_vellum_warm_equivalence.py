"""A form opened and saved on the warm Vellum host equals the same run on a fresh page at HQ's own load delay.

Contract: ``vellum.open_and_save`` reuses the driver's Vellum host page,
resetting it as Vellum's own tests reset their instance and starting Vellum
again at a load delay of 0 with the parse held for the data sources; for
every form that must give what a fresh page gives at HQ's own load delay
(``fresh_open_and_save``) over the same state: Vellum's record of the form
(its load failure or its parse errors, question messages, serialization
warnings, pre-save alerts, case references), the XML it creates, its save
bodies and HQ's answers, its state after the save, and the page's errors and
dialogs; and each page reads the epoch and its own seed's first draw as
Vellum starts. After a run that did not end clean (a form whose load fails)
the next form gets a fresh load of the host. The plausible failures: an earlier
form's instance, modal, hash or stored nudge reaching the next form (a
destroy that leaves listeners or state behind, a hash that selects a
question), a parse that no longer waits for the data sources at a delay of
0, and a warm host reused after a run that broke it.

The in-band audit (``PROOF_EDITOR_AUDIT``) reruns a form on a fresh page and
fails when the two runs end differently; it is checked to rerun what it
chose, to fail on a difference it is shown, and to keep a save HQ's view
raised on as the run's own failure (the failure proof 4 reports as the form
broken), not an audit failure.

The forms run one after another on the same warm host, from unrelated apps:
HQ's suite app's two forms, its advanced app's form, its two-language app
in its second language, and a form whose load Vellum refuses (a second
unnamed instance, ``parser.js::_getInstances``). Each warm run and its fresh
counterpart run in forks of the same state, so neither sees the other's
save.

Every instance's plugins write the mug types and property specs they add
into Vellum's mugs module, which all instances on a page share, and HQ
chooses the plugins per project (``commcareConnect`` only under
``COMMCARE_CONNECT``, ``views/formdesigner.py::_get_vellum_plugins``). A
form with a Connect learn module whose id Vellum refuses runs on the warm
host right after a form of a project without Connect, and the same module
runs again in a project without Connect right after. The plausible
failures: the question tree's root keeping the valid children the host's
first instance gave it, so the module is left out of the tree and never
validated (its error missing where a fresh page shows it), and the Connect
types an earlier instance added still parsing the module, out of the tree,
in a project whose Vellum has none.

A form whose question shows an image HQ holds has Vellum show a thumbnail
of it, which the page loads from HQ (``templates/multimedia_existing_image.html``);
a document shows an image it has loaded again without asking HQ, so a run
on a host that loaded it before would ask HQ less than a fresh page. The
plausible failure: a host kept after a run that loaded an image, so the
next run of the form asks HQ for no thumbnail and its record depends on
which runs the host served before it.
"""

from __future__ import annotations

from dataclasses import replace

import pytest
from lxml import etree

from proof.editors import pages, seeding, vellum
from proof.editors.conftest import ADVANCED_APP, SUITE_APP, first_draw, publish_hq_app, record_timing
from proof.editors.hq import HQAnswers, HQRefusedPageRequest
from proof.editors.units import CheckUnit
from proof.hq import operations
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration
from proof.hq.conftest import HQ_ROOT

CONFIGURATION = Configuration(privileges={"CLOUDCARE"})
XFORMS = "http://www.w3.org/2002/xforms"


def _with_second_unnamed_instance(state, app_id, form_id):
    """The form with a second unnamed instance in its model, which Vellum refuses to load."""
    app = operations.held_app(state, app_id)
    form = app.get_form(form_id)
    tree = etree.fromstring(form.source.encode("utf-8"))
    model = next(el for el in tree.iter() if etree.QName(el).localname == "model")
    instance = etree.SubElement(model, f"{{{XFORMS}}}instance")
    etree.SubElement(instance, "proof_second")
    form.source = etree.tostring(tree, encoding="unicode")
    app.save()


def _forms(state):
    """(app id, form id, lang, whether Vellum loads it) for each form the test runs, in the order it runs them."""
    from corehq.apps.app_manager.models import ConditionalCaseUpdate

    suite = publish_hq_app(state, SUITE_APP)
    # suite/app.json stores the follow-up form's unused open_case name as null, which HQ's form designer
    # cannot read (views/formdesigner.py::_get_base_vellum_options, get_case_mappings) and HQ's editor never
    # writes: a form it makes holds an empty ConditionalCaseUpdate there.
    app = operations.held_app(state, suite)
    app.modules[0].forms[1].actions.open_case.name_update = ConditionalCaseUpdate()
    app.save()
    advanced = publish_hq_app(state, ADVANCED_APP)
    bilingual = publish_hq_app(state, "yesno.json")
    broken = publish_hq_app(state, SUITE_APP)
    suite_forms = [form.unique_id for form in operations.held_app(state, suite).modules[0].forms]
    advanced_form = operations.held_app(state, advanced).modules[1].forms[0].unique_id
    bilingual_form = operations.held_app(state, bilingual).modules[0].forms[0].unique_id
    broken_form = operations.held_app(state, broken).modules[0].forms[0].unique_id
    _with_second_unnamed_instance(state, broken, broken_form)
    return [
        (suite, suite_forms[0], None, True),
        (advanced, advanced_form, None, True),
        (bilingual, bilingual_form, "es", True),
        (broken, broken_form, None, False),
        (suite, suite_forms[1], None, True),
        (suite, suite_forms[0], None, True),
    ]


def test_warm_vellum_runs_equal_fresh_pages_at_hqs_load_delay(hq, core_runner, editor_driver):
    with hq_check(CONFIGURATION) as (state, _):
        unit = CheckUnit(state)
        runs = []
        for app_id, form_id, lang, loads in _forms(state):
            with unit.fork():
                warm = vellum.open_and_save(editor_driver, HQAnswers(state, unit), app_id, form_id, lang=lang)
            with unit.fork():
                fresh = vellum.fresh_open_and_save(editor_driver, HQAnswers(state, unit), app_id, form_id, lang=lang)
            record_timing("vellum_warm_run", warm.seconds["run"])
            assert warm.loaded is loads and fresh.loaded is loads, (warm.load_error, fresh.load_error)
            assert vellum.vellum_differences(warm, fresh) == [], form_id
            for run in (warm, fresh):
                assert (run.page_clock, run.page_draw) == (seeding.epoch_ms(), first_draw(run.seed["seed"]))
            if loads:
                assert warm.saved and warm.save_button == "saved", (warm.save_refusal, warm.modals)
                assert warm.created_xml
            runs.append(warm)

    # Each run after the first reused the host (the first may reuse one an earlier test left), or would have
    # but for the host's recycle period, except the run after the form whose load failed, which got a fresh
    # load of the host (the reset rule).
    assert [run.warm or run.recycled for run in runs[1:]] == [True, True, True, False, True]
    assert sum(run.warm for run in runs[1:]) >= 3
    assert "multiple unnamed instance elements" in runs[3].load_error


def test_the_vellum_audit_reruns_a_form_fresh_and_fails_on_a_difference(hq, core_runner, editor_driver, monkeypatch):
    with hq_check(CONFIGURATION) as (state, _):
        unit = CheckUnit(state)
        app_id = publish_hq_app(state, SUITE_APP)
        form_id = operations.held_app(state, app_id).modules[0].forms[0].unique_id
        fresh_run = vellum.fresh_open_and_save
        rerun = []

        def counted(*args, **kwargs):
            run = fresh_run(*args, **kwargs)
            rerun.append(run.form_unique_id)
            return run

        monkeypatch.setattr(vellum, "fresh_open_and_save", counted)
        monkeypatch.setenv(pages.AUDIT_ENVIRONMENT, "1")
        with unit.fork():
            vellum.open_and_save(editor_driver, HQAnswers(state, unit), app_id, form_id)
        assert rerun == [form_id]

        def different(*args, **kwargs):
            run = fresh_run(*args, **kwargs)
            run.page_errors = ["Error: a page error the warm run did not raise"]
            return run

        monkeypatch.setattr(vellum, "fresh_open_and_save", different)
        with unit.fork(), pytest.raises(vellum.VellumAuditMismatch, match="page errors"):
            vellum.open_and_save(editor_driver, HQAnswers(state, unit), app_id, form_id)


def test_the_vellum_audit_keeps_a_save_hqs_view_raised_on_as_the_runs_own_failure(
    hq, core_runner, editor_driver, monkeypatch
):
    from unittest import mock

    from corehq.apps.app_manager.views import forms

    with hq_check(CONFIGURATION) as (state, _):
        unit = CheckUnit(state)
        app_id = publish_hq_app(state, SUITE_APP)
        form_id = operations.held_app(state, app_id).modules[0].forms[0].unique_id
        fresh_run = vellum.fresh_open_and_save
        rerun = []

        def counted(*args, **kwargs):
            rerun.append(args[3])
            return fresh_run(*args, **kwargs)

        def get_app_failing(*args, **kwargs):
            raise RuntimeError("HQ could not read the app")

        monkeypatch.setattr(vellum, "fresh_open_and_save", counted)
        monkeypatch.setenv(pages.AUDIT_ENVIRONMENT, "1")
        # HQ's views that store Vellum's form (patch_xform, edit_form_attr) read the app through it, outside
        # what they catch, so they raise; the views Vellum loads from (formdesigner.py) do not read it.
        with (
            mock.patch.object(forms, "get_app", get_app_failing),
            unit.fork(),
            pytest.raises(HQRefusedPageRequest) as failed,
        ):
            vellum.open_and_save(editor_driver, HQAnswers(state, unit), app_id, form_id)
    assert rerun == [form_id]
    raised = {(exchange.url_name, exchange.raised) for exchange in failed.value.exchanges}
    assert raised and {name for name, _ in raised} <= {"patch_xform", "edit_form_attr"}, raised
    assert {error for _, error in raised} == {"builtins.RuntimeError"}, raised


VELLUM = "http://commcarehq.org/xforms/vellum"
CONNECT_LEARN = "http://commcareconnect.com/data/v1/learn"


def _with_connect_learn_module(state, app_id, form_id, module_id):
    """The form with a Connect learn module (``commcareConnect.js``'s ``ConnectLearnModule``) of id ``module_id``,
    as Vellum writes one: a data node naming its role, holding the module's own element, with a bind."""
    app = operations.held_app(state, app_id)
    form = app.get_form(form_id)
    tree = etree.fromstring(form.source.encode("utf-8"))
    model = next(el for el in tree.iter() if etree.QName(el).localname == "model")
    instance = next(el for el in model if etree.QName(el).localname == "instance")
    data = instance[0]
    # Vellum reads the role by its qualified name (parser.js::parseDataElement, ``vellum:role``).
    node = etree.SubElement(
        data,
        f"{{{etree.QName(data).namespace}}}{module_id}",
        {f"{{{VELLUM}}}role": "ConnectLearnModule"},
        nsmap={"vellum": VELLUM},
    )
    module = etree.SubElement(node, f"{{{CONNECT_LEARN}}}module", nsmap={None: CONNECT_LEARN}, id=module_id)
    for name, text in (("name", "Hand washing"), ("description", "Wash for twenty seconds."), ("time_estimate", "5")):
        etree.SubElement(module, f"{{{CONNECT_LEARN}}}{name}").text = text
    etree.SubElement(model, f"{{{XFORMS}}}bind", nodeset=f"/{etree.QName(data).localname}/{module_id}")
    form.source = etree.tostring(tree, encoding="unicode")
    app.save()


def _questions(run):
    """Each question Vellum holds in the run, by path: its type and its messages' keys."""
    return {
        question["path"]: (question["type"], [message["key"] for message in question["messages"]])
        for question in run.questions
    }


def test_a_warm_host_puts_back_the_mug_types_and_specs_earlier_instances_extended(hq, core_runner, editor_driver):
    """A Connect learn module run on the warm host after a form of a project without Connect, and run again in a
    project without Connect after it, gives what a fresh page gives each time: in the project with Connect, a
    ConnectLearnModule question, and in the one without, the same node as a hidden value, each carrying Vellum's
    error for its id (``mugs/baseSpecs.js``'s nodeID check, made when the question enters the tree)."""
    without_connect = CONFIGURATION
    with_connect = Configuration(privileges={"CLOUDCARE"}, flags={"COMMCARE_CONNECT"})
    module_path = "/data/_lesson"
    runs = []
    with hq_check(without_connect) as (state, _):
        unit = CheckUnit(state)
        broken = publish_hq_app(state, SUITE_APP)
        broken_form = operations.held_app(state, broken).modules[0].forms[0].unique_id
        _with_second_unnamed_instance(state, broken, broken_form)
        plain = publish_hq_app(state, SUITE_APP)
        plain_form = operations.held_app(state, plain).modules[0].forms[0].unique_id
        # A form whose load fails leaves the host, so the plain form is the first instance on a fresh load of it.
        for app_id, form_id in ((broken, broken_form), (plain, plain_form)):
            with unit.fork():
                runs.append(vellum.open_and_save(editor_driver, HQAnswers(state, unit), app_id, form_id))
    assert [run.loaded for run in runs] == [False, True]
    assert runs[1].warm is False and runs[1].kept is True

    for configuration, expected in (
        (with_connect, ("ConnectLearnModule", ["mug-nodeID-error"])),
        (without_connect, ("DataBindOnly", ["mug-nodeID-error"])),
    ):
        with hq_check(configuration) as (state, _):
            unit = CheckUnit(state)
            app_id = publish_hq_app(state, SUITE_APP)
            form_id = operations.held_app(state, app_id).modules[0].forms[0].unique_id
            _with_connect_learn_module(state, app_id, form_id, module_path.rsplit("/", 1)[1])
            with unit.fork():
                warm = vellum.open_and_save(editor_driver, HQAnswers(state, unit), app_id, form_id)
            with unit.fork():
                fresh = vellum.fresh_open_and_save(editor_driver, HQAnswers(state, unit), app_id, form_id)
        assert warm.warm is True, (configuration, warm.recycled)
        assert _questions(fresh)[module_path] == expected, _questions(fresh)
        assert _questions(warm)[module_path] == expected, _questions(warm)
        assert vellum.vellum_differences(warm, fresh) == [], configuration
        # The reset found what the instance before had written into the shared types and specs, and put it back.
        assert warm.shared_at_reset > 0


IMAGE = "jr://file/commcare/image/proof.png"


def _media_upload(files):
    """A media upload as Nova's publish sends it (``bulk_upload_file``, a ZIP of ``files``: ``{path: bytes}``)."""
    import io
    import zipfile

    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w") as zipped:
        for path, content in files.items():
            zipped.writestr(path, content)
    boundary = "----proof-media-upload"
    body = (
        f'--{boundary}\r\nContent-Disposition: form-data; name="bulk_upload_file"; filename="multimedia.zip"\r\n'
        "Content-Type: application/zip\r\n\r\n".encode()
        + archive.getvalue()
        + f"\r\n--{boundary}--\r\n".encode()
    )
    return operations.Upload(body, f"multipart/form-data; boundary={boundary}")


def _with_label_image(state, app_id, form_id):
    """The form's first question's label shown with an image HQ holds: the image in the label's itext, and the
    image mapped into the app by HQ's processing of a media upload (``operations.apply_media_upload``)."""
    app = operations.held_app(state, app_id)
    form = app.get_form(form_id)
    tree = etree.fromstring(form.source.encode("utf-8"))
    label = next(text for text in tree.iter(f"{{{XFORMS}}}text") if text.get("id") == "plain-label")
    etree.SubElement(label, f"{{{XFORMS}}}value", form="image").text = IMAGE
    form.source = etree.tostring(tree, encoding="unicode")
    app.save()
    png = (HQ_ROOT / "corehq/apps/hqmedia/static/hqmedia/images/invalid_image.png").read_bytes()
    uploaded = operations.apply_media_upload(state, app_id, _media_upload({IMAGE.removeprefix("jr://file/"): png}))
    assert [info["path"] for info in uploaded.processing["matched_files"]["CommCareImage"]] == [IMAGE]


def _thumbnails(run):
    """The image requests the page had HQ answer (HQ's media view), in a fixed order."""
    return sorted(
        (exchange.path, exchange.query) for exchange in run.exchanges if exchange.url_name == "hqmedia_download"
    )


def test_a_run_whose_page_loaded_an_image_leaves_the_host_so_each_run_asks_hq_for_it(hq, core_runner, editor_driver):
    """The same form with an image opened twice on the host asks HQ for its thumbnail both times, as a fresh page
    does, with nothing a cached copy would make a request carry; each such run leaves the host, so the next form,
    one with no image, gets a fresh load of it, and the form after that reuses it again."""
    with hq_check(CONFIGURATION) as (state, _):
        unit = CheckUnit(state)
        imaged = publish_hq_app(state, SUITE_APP)
        imaged_form = operations.held_app(state, imaged).modules[0].forms[0].unique_id
        _with_label_image(state, imaged, imaged_form)
        plain = publish_hq_app(state, SUITE_APP)
        plain_form = operations.held_app(state, plain).modules[0].forms[0].unique_id
        runs = []
        for app_id, form_id in ((imaged, imaged_form), (imaged, imaged_form), (plain, plain_form), (plain, plain_form)):
            with unit.fork():
                runs.append(vellum.open_and_save(editor_driver, HQAnswers(state, unit), app_id, form_id))
        with unit.fork():
            fresh = vellum.fresh_open_and_save(editor_driver, HQAnswers(state, unit), imaged, imaged_form)

    assert _thumbnails(fresh), "Vellum asked HQ for no thumbnail of the form's image on a fresh page"
    assert _thumbnails(runs[0]) == _thumbnails(runs[1]) == _thumbnails(fresh)
    assert _thumbnails(runs[2]) == _thumbnails(runs[3]) == []
    for run in runs[:2]:
        assert vellum.vellum_differences(run, fresh) == []
    # A run shown the image without asking HQ is told apart from a fresh page's (the in-band audit's comparison).
    unasked = replace(runs[1], exchanges=[e for e in runs[1].exchanges if e.url_name != "hqmedia_download"])
    assert [found.split(" (")[0] for found in vellum.vellum_differences(unasked, fresh)] == ["the requests HQ answered"]
    asked = [
        exchange for run in (*runs[:2], fresh) for exchange in run.exchanges if exchange.url_name == "hqmedia_download"
    ]
    assert not [
        exchange.headers for exchange in asked if {"if-none-match", "if-modified-since"} & set(exchange.headers)
    ]
    assert [run.kept for run in runs] == [False, False, True, True]
    assert [run.warm for run in runs[1:3]] == [False, False]
    assert runs[3].warm or runs[3].recycled
