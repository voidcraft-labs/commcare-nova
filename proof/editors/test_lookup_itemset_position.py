"""Fixture row ordinals and invalid scalar position arguments in Vellum and Formplayer."""

from lxml import etree

from proof.editors import vellum
from proof.editors.conftest import corpus_document, write_evidence
from proof.formplayer import apps, hq as formplayer
from proof.formplayer.test_lookup_tags import _opened, _questions
from proof.formplayer.walk import screen_kind
from proof.hq import operations
from proof.hq.check import hq_check
from proof.matrix import ops
from proof.matrix.authoring import Authoring
from proof.observe import publish


def _itemset(source):
    root = etree.fromstring(source.encode())
    itemset, = root.xpath("//*[local-name()='select1' and @ref='/data/village']/*[local-name()='itemset']")
    return root, itemset


def _state(source):
    root, itemset = _itemset(source)
    data, = root.xpath("//*[local-name()='model']/*[local-name()='instance' and not(@src)]/*[1]")
    return {
        "namespace": etree.QName(data).namespace,
        "nodeset": itemset.get("nodeset"),
        "value": itemset.xpath("./*[local-name()='value']/@ref"),
        "label": itemset.xpath("./*[local-name()='label']/@ref"),
    }


def _replace_village_filter(authoring, app_id, filter_text, label):
    def change(root, _form):
        itemset, = root.xpath("//*[local-name()='select1' and @ref='/data/village']/*[local-name()='itemset']")
        for key, text in itemset.attrib.items():
            if key == "nodeset" or key.endswith("}nodeset"):
                itemset.set(key, text.partition("[")[0] + filter_text)

    ops.set_form_source(authoring, app_id, 0, 0, change, what=label)


def _worker(unit, app_id, runner, document, label):
    with formplayer.serve(unit, document, app_id, runner=runner, label=label) as served, served.run(label):
        return _opened(apps.web(runner, served))


def _village_choices(unit, app_id, runner, document, label, *, submit=False):
    with formplayer.serve(unit, document, app_id, runner=runner, label=label) as served, served.run(label):
        web = apps.web(runner, served)
        screen = _opened(web)
        assert screen_kind(screen) == "form", (label, screen)
        village, = [q for q in _questions(screen["tree"]) if q.get("binding") == "/data/village"]
        result = {"choices": village.get("choices") or []}
        if submit:
            assert len(result["choices"]) == 1, (label, screen)
            start = len(served.hq.submissions)
            reply = web.submit(screen["session_id"], {village["ix"]: "1"})
            assert reply.get("status") == "success", (label, reply)
            submission, = served.hq.submissions[start:]
            result["submitted"] = etree.fromstring(submission.instance).findtext("{*}village")
        return result


def _submit_second_row(unit, app_id, runner, document):
    observed = _village_choices(unit, app_id, runner, document, "second-fixture-row", submit=True)
    assert observed == {"choices": ["Mbeya"], "submitted": "v2"}
    return observed


def test_vellum_preserves_the_invalid_scalar_position_and_formplayer_refuses_it(
    hq, core_runner, editor_driver, formplayer_runner,
):
    from proof.matrix.registry import named_change

    document = corpus_document("hq-lookups")
    with hq_check(document.exports["minimum"].configuration.hq()) as (unit, _):
        with unit.operation("itemset-position:source", b"hq-lookups"):
            app_id, refusal, _ = publish.create_authored(unit, document)
            assert refusal is None
        authoring = Authoring(unit, {}, base=document.id, operation=unit.operation)
        named_change("itemset_filter_position_of_scalar")(authoring, app_id)
        form = operations.held_app(unit, app_id).modules[0].forms[0]
        before = _state(form.source)
        assert "villages[position(3) < 3]" in before["nodeset"]
        assert before["value"] == ["id"] and before["label"] == ["name"]

        bad_before = _worker(unit, app_id, formplayer_runner, document, "scalar-before-save")
        run = vellum.fresh_open_and_save(editor_driver, unit, app_id, form.unique_id)
        assert run.loaded and run.saved, (run.load_error, run.save_refusal)
        after = _state(run.stored_source)
        assert after == before
        bad_after = _worker(unit, app_id, formplayer_runner, document, "scalar-after-save")

        named_change("itemset_filter_numeric_row_index")(authoring, app_id)
        form = operations.held_app(unit, app_id).modules[0].forms[0]
        literal = _state(form.source)
        assert literal == {**before, "nodeset": before["nodeset"].replace("[position(3) < 3]", "[2]")}
        run = vellum.fresh_open_and_save(editor_driver, unit, app_id, form.unique_id)
        assert run.loaded and run.saved, (run.load_error, run.save_refusal)
        assert _state(run.stored_source) == literal
        accepted = _submit_second_row(unit, app_id, formplayer_runner, document)

    write_evidence("lookup-itemset-scalar-position", {
        "sourceBefore": before, "sourceAfter": after, "literalSource": literal,
        "runtimeBefore": bad_before, "runtimeAfter": bad_after, "literalSecond": accepted,
    })
    assert screen_kind(bad_before) != "form", bad_before
    assert screen_kind(bad_after) != "form", bad_after



def test_positive_fixture_row_ordinal_and_predicate_position_offer_the_same_choices(
    hq, core_runner, editor_driver, formplayer_runner,
):
    document = corpus_document("hq-lookups")
    # Test each filter's local candidate list. With the district test first,
    # the third original row becomes the first candidate. With the tests
    # reversed, selecting the first original row before district yields none.
    controls = (
        ("second", "", 2, "", {"choices": ["Mbeya"], "submitted": "v2"}),
        ("out-of-range", "", 4, "", {"choices": []}),
        ("empty-candidates", "[district = 'missing']", 1, "", {"choices": []}),
        ("filter-then-ordinal", "[district = 'd2']", 1, "", {"choices": ["Rusumo"], "submitted": "v3"}),
        ("ordinal-then-filter", "", 1, "[district = 'd2']", {"choices": []}),
    )
    observed = {}
    with hq_check(document.exports["minimum"].configuration.hq()) as (unit, _):
        with unit.operation("fixture-ordinal:source", b"hq-lookups"):
            app_id, refusal, _ = publish.create_authored(unit, document)
            assert refusal is None
        authoring = Authoring(unit, {}, base=document.id, operation=unit.operation)
        for label, prefix, ordinal, suffix, expected in controls:
            for spelling, predicate in (("literal", str(ordinal)), ("position", f"position() = {ordinal}")):
                filter_text = f"{prefix}[{predicate}]{suffix}"
                arm = f"{label}-{spelling}"

                _replace_village_filter(authoring, app_id, filter_text, arm)
                form = operations.held_app(unit, app_id).modules[0].forms[0]
                nodeset = _state(form.source)["nodeset"]
                assert nodeset.endswith("villages" + filter_text), (arm, nodeset)
                if label == "second":
                    run = vellum.fresh_open_and_save(editor_driver, unit, app_id, form.unique_id)
                    assert run.loaded and run.saved, (arm, run.load_error, run.save_refusal)
                    assert _state(run.stored_source)["nodeset"] == nodeset
                actual = _village_choices(
                    unit, app_id, formplayer_runner, document, arm, submit="submitted" in expected,
                )
                assert actual == expected, (arm, actual)
                observed[arm] = {"nodeset": nodeset, **actual}

    write_evidence("lookup-itemset-ordinal-predicate-position", observed)


def test_fractional_fixture_row_index_truncates_after_vellum_reopens(
    hq, core_runner, editor_driver, formplayer_runner,
):
    document = corpus_document("hq-lookups")
    second = {"choices": ["Mbeya"], "submitted": "v2"}
    samples = (
        ("fractional", "2.5", second),
        ("integer", "2", second),
        ("explicit-position", "position() = 2", second),
        ("empty-fractional-position", "position() = 2.5", {"choices": []}),
        ("zero", "0", {"choices": []}),
        ("fractional-truncated-to-zero", "0.5", {"choices": []}),
        ("explicit-zero-position", "position() = 0", {"choices": []}),
    )
    observed = {}
    with hq_check(document.exports["minimum"].configuration.hq()) as (unit, _):
        with unit.operation("fixture-fraction:source", b"hq-lookups"):
            app_id, refusal, _ = publish.create_authored(unit, document)
            assert refusal is None
        authoring = Authoring(unit, {}, base=document.id, operation=unit.operation)
        for kind, predicate, expected in samples:
            _replace_village_filter(authoring, app_id, f"[{predicate}]", f"fractional-ordinal-{kind}")
            form = operations.held_app(unit, app_id).get_module(0).get_form(0)
            before = _state(form.source)
            assert before["nodeset"].endswith(f"villages[{predicate}]")
            assert before["value"] == ["id"] and before["label"] == ["name"]
            label = f"Updated farmer question {kind}"
            changed = vellum.open_and_save(editor_driver, unit, app_id, form.unique_id, edit={
                "path": "/data/farmer_name", "label": label, "way": "builder-model",
            })
            reopened = vellum.fresh_open_and_save(editor_driver, unit, app_id, form.unique_id)
            for save in (changed, reopened):
                assert save.loaded and save.saved and save.stored_source, (kind, save.load_error, save.save_refusal)
                assert label in save.stored_source
                assert _state(save.stored_source) == before
            actual = _village_choices(unit, app_id, formplayer_runner, document, kind, submit="submitted" in expected)
            assert actual == expected, (kind, actual)
            observed[kind] = {"nodeset": before["nodeset"], **actual}
    write_evidence("lookup-itemset-fractional-row-index", observed)
