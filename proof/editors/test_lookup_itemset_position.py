"""A literal row predicate selects a fixture row. A scalar argument to position fails at runtime."""

from lxml import etree

from proof.editors.conftest import corpus_document
from proof.editors import vellum
from proof.editors.conftest import write_evidence
from proof.formplayer import apps, hq as formplayer
from proof.formplayer.test_lookup_tags import _opened, _questions
from proof.formplayer.walk import screen_kind
from proof.hq import operations
from proof.hq.check import hq_check
from proof.matrix.authoring import Authoring
from proof.observe import publish
from proof.observe.hqside import _patched


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


def _worker(unit, app_id, runner, document, label):
    with formplayer.serve(unit, document, app_id, runner=runner, label=label) as served, served.run(label):
        return _opened(apps.web(runner, served))


def _village_choices(screen):
    assert screen_kind(screen) == "form", screen
    village, = [node for node in _questions(screen["tree"]) if node.get("binding") == "/data/village"]
    return village["choices"]


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

        root, itemset = _itemset(run.stored_source)
        itemset.set("nodeset", after["nodeset"].replace("[position(3) < 3]", "[2]"))
        _patched(unit, app_id, form.unique_id, etree.tostring(root, encoding="unicode"), "literal row position control")
        good = _worker(unit, app_id, formplayer_runner, document, "second-fixture-row")
        choices = _village_choices(good)

    write_evidence("lookup-itemset-scalar-position", {
        "sourceBefore": before, "sourceAfter": after,
        "runtimeBefore": bad_before, "runtimeAfter": bad_after, "literalSecond": choices,
    })
    assert choices == ["Mbeya"]
    assert screen_kind(bad_before) != "form", bad_before
    assert screen_kind(bad_after) != "form", bad_after
