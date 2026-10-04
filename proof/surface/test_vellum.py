"""HQ's vendored Vellum: the feature keys it reads, and its question types and menus.

Contracts and the failures they catch:
- Every feature key the vendored build reads is an item, including keys read
  only through a function parameter: ``custom_intents`` and
  ``templated_intents`` reach Vellum's ``function N(e){return!e.custom_intents
  &&!e.templated_intents}`` as an argument, so a syntactic ``features.<key>``
  pass misses both. The test holds the syntax-tree pass against Vellum run
  headless: each of those keys alone changes the advanced question menu
  (``AndroidIntent``), as ``face_capture`` and ``support_document_upload``
  change the media menu, which the headless read observed on its own.
- A reader planted behind a parameter alias in a temporary copy of the build
  is found; the unplanted build does not have it.
- The registry read covers every feature key alone and every plugin HQ may
  pass, and a plugin's question types exist only where it is passed.
- What Vellum's parser asks of its own markup while it loads a form is an
  item per element and name: the ``vellum:`` shadows of a bind's expressions,
  a setvalue's, an output's and a counted repeat's, the data nodes' role and
  comment, and the hashtag elements of the head, the last read only while
  Vellum's data sources are still loading (``parser.js::parseXForm``), which
  the probe holds open. Vellum asks for a shadow only where the names before
  it are missing (a control's ``vellum:nodeset`` only without a ``ref``, its
  ``vellum:bind`` only without either, a bind's ``vellum:ref`` only without a
  ``nodeset``), so a probe that names every node one way misses the others:
  the probe holds each way, and without its alternatives they are not read.
- The registry is read on the editor build's Vellum host page, the page the
  editor driver opens forms on; without that page the family refuses and
  names it rather than reading Vellum on a page of its own.
"""

from __future__ import annotations

import dataclasses

import pytest

from proof.surface.families.vellum import (
    FORM_DESIGNER,
    MARKUP_PROBE,
    VELLUM_DIR,
    _hq_plugins,
    feature_keys,
    markup,
    mugs,
)
from proof.surface.model import SurfaceError


def test_feature_keys_include_those_read_through_parameters(items):
    keys = {key.split(":", 1)[1] for key in items if key.startswith("vellum-feature:")}
    assert {"custom_intents", "templated_intents", "face_capture", "support_document_upload"} <= keys
    assert items["vellum-feature:custom_intents"]["hqSets"] == "domain_has_privilege(domain, privileges.CUSTOM_INTENTS)"
    assert items["vellum-feature:printing"]["hqToggle"] == "VELLUM_PRINTING"
    configurations = {key.split(":", 1)[1] for key in items if key.startswith("vellum-configuration:")}
    assert {f"feature:{key}" for key in keys} <= configurations


def test_the_headless_registry_shows_the_parameter_read_keys_at_work(items):
    intent = items["mug:AndroidIntent"]
    offered_somewhere = set(intent["menuGroups"])
    assert offered_somewhere == {"Geopoint"}
    # Registered everywhere, offered only where an intents feature is on.
    assert "feature:custom_intents" not in intent["notOfferedIn"]
    assert "feature:templated_intents" not in intent["notOfferedIn"]
    assert "plugins:all" in intent["notOfferedIn"]
    assert "feature:face_capture" not in items["mug:FaceCapture"]["notOfferedIn"]
    assert "plugins:all" in items["mug:FaceCapture"]["notOfferedIn"]
    assert "feature:support_document_upload" not in items["mug:Document"]["notOfferedIn"]


def test_plugin_question_types_follow_their_plugin(items):
    plugins = {key.split(":", 1)[1]: facts for key, facts in items.items() if key.startswith("vellum-plugin:")}
    conditional = {name for name, facts in plugins.items() if facts["condition"] is not None}
    assert {"commtrack", "saveToCase", "commcareConnect"} <= conditional
    assert "plugins:base" in items["mug:SaveToCase"]["notRegisteredIn"]
    assert "plugin:saveToCase" not in items["mug:SaveToCase"]["notRegisteredIn"]
    assert "plugin:commtrack" not in items["mug:Balance"]["notRegisteredIn"]
    assert items["mug:Text"]["notRegisteredIn"] == [] and items["mug:Choice"]["auxiliary"] is True


def test_the_feature_pass_follows_a_planted_parameter_alias(plant, sources, items):
    main = f"{VELLUM_DIR}/main.js"
    marker = "function N(e){return!e.custom_intents&&!e.templated_intents}"
    root = plant(
        sources.hq,
        [main],
        {
            main: (
                marker,
                marker + "function plantedReader(q){var r=q;return r.planted_feature}"
                "function plantedCaller(){return plantedReader(this.opts().features)}",
            )
        },
    )
    assert "planted_feature" in feature_keys(root / main)
    assert "vellum-feature:planted_feature" not in items


def test_the_registry_is_read_on_the_editor_builds_host_page(tmp_path, sources, hq):
    assert (sources.editors / "static/vellum/host.html").is_file()
    with pytest.raises(SurfaceError, match="static/vellum/host.html"):
        mugs(dataclasses.replace(sources, editors=tmp_path), [], [("modeliteration", None)])


MARKUP = {
    "vellum-markup:bind@vellum:nodeset": ["popAttr"],
    "vellum-markup:bind@vellum:relevant": ["popAttr"],
    "vellum-markup:bind@vellum:calculate": ["popAttr"],
    "vellum-markup:bind@vellum:constraint": ["popAttr"],
    "vellum-markup:bind@vellum:requiredCondition": ["popAttr"],
    "vellum-markup:setvalue@vellum:ref": ["xmlAttr"],
    "vellum-markup:setvalue@vellum:value": ["xmlAttr"],
    "vellum-markup:output@vellum:value": ["xmlAttr"],
    "vellum-markup:repeat@vellum:jr__count": ["popAttr"],
    "vellum-markup:input@vellum:nodeset": ["popAttr"],
    "vellum-markup:input@vellum:bind": ["popAttr"],
    "vellum-markup:bind@vellum:ref": ["popAttr"],
    "vellum-markup:model/instance//*@vellum:comment": ["popAttr"],
    "vellum-markup:model/instance//*@vellum:case_type": ["xmlAttr"],
    "vellum-markup:h:html@vellum:ignore": ["xmlAttr"],
    "vellum-markup:h:head/vellum:hashtags": ["children"],
    "vellum-markup:h:head/vellum:hashtagTransforms": ["children"],
}


def test_vellums_parser_asks_for_its_own_markup_on_each_element(items):
    assert {key: items[key]["via"] for key in MARKUP if key in items} == MARKUP
    assert items["vellum-markup:h:head/vellum:hashtags"]["selectors"] == ["vellum\\:hashtags, hashtags"]
    # Vellum renames a form's root h:xdoc to parse it; the key names the root as the form does.
    assert not [key for key in items if key.startswith("vellum-markup:h:xdoc")]


def test_vellum_asks_a_shadow_only_where_the_names_before_it_are_missing(sources, hq, items):
    """``parser.js::getPathFromControlElement`` reads a control's ``ref``, else its ``nodeset``, else its
    ``bind``, and ``parseBindList`` a bind's ``nodeset``, else its ``ref``, each through ``parseVellumAttrs``
    (the ``vellum:`` shadow, then the name): the probe's input by nodeset, input by bind and bind by ref are
    the only reason Vellum asks for those shadows."""
    alternatives = {
        "vellum-markup:input@vellum:nodeset",
        "vellum-markup:input@vellum:bind",
        "vellum-markup:bind@vellum:ref",
    }
    assert alternatives <= set(items)
    without = MARKUP_PROBE
    for element in (
        """<input vellum:nodeset="#form/bynodeset" nodeset="/data/bynodeset">"""
        """<label ref="jr:itext('bynodeset-label')"/></input>""",
        """<input bind="bybind"><label ref="jr:itext('bybind-label')"/></input>""",
        """<bind vellum:ref="#form/byref" ref="/data/byref" type="xsd:string"/>""",
        """<input vellum:ref="#form/byref" ref="/data/byref"><label ref="jr:itext('byref-label')"/></input>""",
    ):
        assert element in without, element
        without = without.replace(element, "")
    keys = feature_keys(sources.hq / VELLUM_DIR / "main.js")
    read = {one.key for one in markup(sources, keys, _hq_plugins(sources.hq / FORM_DESIGNER), form=without)}
    assert {"vellum-markup:bind@vellum:nodeset", "vellum-markup:input@vellum:ref"} <= read
    assert not alternatives & read
