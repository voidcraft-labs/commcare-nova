"""HQ's app-building registries: settings, add-ons and suite instances.

Keys:

- ``setting:<type>.<id>``: each CommCare setting HQ's own loader
  (``commcare_settings.py::_load_custom_commcare_settings``) reads from
  ``commcare-profile-settings.yml`` and ``commcare-app-settings.yml``, keyed
  as ``_load_commcare_settings_layout`` keys it (``setting:properties.cc-autoup-freq``).
  Every attribute the loader returns is recorded except the display text HQ
  translates (``PROFILE_SETTINGS_TO_TRANSLATE``), so ``since``, ``toggle``,
  ``toggles``, ``privilege``, ``disabled``, ``default``, ``force``,
  ``values`` and the rest are all facts, with the layout section that shows it.
- ``add-on:<slug>``: each add-on of ``add_ons.py::_ADD_ONS`` after the boot,
  with its privilege, whether it carries upgrade text, its layout section,
  whether ``_grandfathered`` lists it, whether a feature preview shares its
  slug, and the ``used_in_module`` / ``used_in_form`` tests as their syntax
  tree prints them.
- ``instance-scheme:<scheme>``: each scheme ``suite_xml/post_process/instances.py``
  registers a factory for (``_factory_map`` after the boot), with the factory,
  the preset instance it builds (``INSTANCE_KWARGS_BY_ID``) and the calls and
  toggles its body reads.
- ``instance-ignored:<src>``: each instance source ``InstancesHelper.IGNORED_INSTANCES``
  leaves out of a suite.
"""

from __future__ import annotations

import ast
import inspect

import yaml

from proof.surface import pyast
from proof.surface.model import Item, Sources, SurfaceError, canonical, item

SETTINGS_LOADER = "corehq/apps/app_manager/commcare_settings.py"
SETTINGS_DIR = "corehq/apps/app_manager/static/app_manager/json"
ADD_ONS = "corehq/apps/app_manager/add_ons.py"
INSTANCES = "corehq/apps/app_manager/suite_xml/post_process/instances.py"


def extract(sources: Sources) -> list[Item]:
    return [*settings(sources), *add_ons(sources), *instances(sources)]


def settings(sources: Sources) -> list[Item]:
    from corehq.apps.app_manager import commcare_settings
    from corehq.apps.app_manager.models import Application

    loaded = commcare_settings._load_custom_commcare_settings()
    sections = {}
    for section in commcare_settings._load_commcare_settings_layout(Application()):
        for setting in section["settings"]:
            sections[f"{setting['type']}.{setting['id']}"] = section["id"]
    text = set(commcare_settings.PROFILE_SETTINGS_TO_TRANSLATE)
    # Which of the two files lists each setting, read the way the loader reads them.
    origin = {}
    for name in ("commcare-profile-settings.yml", "commcare-app-settings.yml"):
        path = sources.hq / SETTINGS_DIR / name
        with open(path, encoding="utf-8") as stream:
            for setting in yaml.safe_load(stream):
                origin.setdefault(setting["id"], sources.relative(path))
    items = []
    for setting in loaded:
        key = f"{setting['type']}.{setting['id']}"
        facts = {name: value for name, value in setting.items() if name not in text and name != "id"}
        facts["section"] = sections.get(key)
        items.append(item(f"setting:{key}", f"{origin[setting['id']]}::{setting['id']}", **canonical(facts, key)))
    return items


def add_ons(sources: Sources) -> list[Item]:
    from corehq import feature_previews
    from corehq.apps.app_manager import add_ons as registry

    path = sources.hq / ADD_ONS
    tree = pyast.parse(path)
    calls = _add_on_calls(tree)
    grandfathered = _grandfathered_slugs(tree)
    sections = {slug: section["slug"] for section in registry._LAYOUT for slug in section["slugs"]}
    previews = {preview.slug for preview in feature_previews.all_previews()}
    items = []
    for slug, add_on in sorted(registry._ADD_ONS.items()):
        keywords = calls.get(slug)
        if keywords is None:
            raise SurfaceError(f"The add-on {slug} is not an AddOn(...) entry of the _ADD_ONS literal in {ADD_ONS}.")
        items.append(
            item(
                f"add-on:{slug}",
                f"{sources.relative(path)}::_ADD_ONS",
                privilege=add_on.privilege,
                upgradeText=add_on.upgrade_text is not None,
                section=sections.get(slug),
                grandfathered=slug in grandfathered,
                featurePreview=slug in previews,
                usedInModule=keywords.get("used_in_module"),
                usedInForm=keywords.get("used_in_form"),
            )
        )
    return items


def _add_on_calls(tree: ast.Module) -> dict[str, dict[str, str]]:
    for statement in tree.body:
        if (
            isinstance(statement, ast.Assign)
            and any(isinstance(t, ast.Name) and t.id == "_ADD_ONS" for t in statement.targets)
            and isinstance(statement.value, ast.Dict)
        ):
            found = {}
            for key, value in zip(statement.value.keys, statement.value.values, strict=True):
                slug = pyast.string(key)
                if slug is None or not isinstance(value, ast.Call):
                    continue
                found[slug] = {keyword.arg: ast.unparse(keyword.value) for keyword in value.keywords if keyword.arg}
            return found
    raise SurfaceError(f"The surface extractor found no `_ADD_ONS = {{...}}` literal in {ADD_ONS}.")


def _grandfathered_slugs(tree: ast.Module) -> set[str]:
    function = pyast.find(tree, "_grandfathered")
    slugs = set()
    for node in ast.walk(function):
        if isinstance(node, ast.Compare) and any(isinstance(op, (ast.In, ast.NotIn)) for op in node.ops):
            for comparator in node.comparators:
                if isinstance(comparator, (ast.List, ast.Tuple, ast.Set)):
                    slugs |= {pyast.string(element) for element in comparator.elts} - {None}
    if not slugs:
        raise SurfaceError(f"The surface extractor found no slug list in {ADD_ONS}::_grandfathered.")
    return slugs


def instances(sources: Sources) -> list[Item]:
    from corehq.apps.app_manager.suite_xml.post_process import instances as module

    path = sources.hq / INSTANCES
    relative = sources.relative(path)
    items = []
    for scheme, factory in sorted(module._factory_map.items()):
        function = inspect.unwrap(factory)
        qualname, node = pyast.function_starting_at(inspect.getsourcefile(function), function.__code__.co_firstlineno)
        facts = {
            "factory": qualname,
            "calls": pyast.calls(node),
            "toggles": sorted(
                {
                    chain.split(".")[1]
                    for chain in (pyast.dotted(n) for n in ast.walk(node) if isinstance(n, ast.Attribute))
                    if chain and chain.startswith("toggles.") and chain.count(".") >= 1
                }
            ),
        }
        if scheme in module.INSTANCE_KWARGS_BY_ID:
            facts["preset"] = dict(module.INSTANCE_KWARGS_BY_ID[scheme])
        items.append(item(f"instance-scheme:{scheme}", f"{relative}::{qualname}", **facts))
    for src in sorted(module.InstancesHelper.IGNORED_INSTANCES):
        items.append(item(f"instance-ignored:{src}", f"{relative}::InstancesHelper.IGNORED_INSTANCES"))
    return items
