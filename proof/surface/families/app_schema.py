"""The app schema: every key HQ's app document classes declare or read.

Keys:

- ``schema:<Class>``: a document class an app can hold (``schema:ShadowModule``),
  with its HQ bases among the schema classes, the dispatchers that choose it by
  ``doc_type``, and whether it keeps keys it does not declare.
- ``schema:<Class>.<key>``: one JSON key of that class (``schema:Detail.display``):
  its property type, item type, choices, the default HQ writes, whether it is
  required or dropped when null, and each raw read of the key by a ``wrap``
  method or a descriptor. A key no property declares but a ``wrap`` or a
  descriptor reads (the legacy ``contents`` that
  ``models/forms.py::FormSource.__get__`` migrates) is an item with
  ``declared: false``. A key an HQ ``__init__`` of the class fills when a
  document leaves it empty records that constructor as ``defaultComputedBy``,
  with the expression it assigns and the conditions it assigns it under
  (``schema:ReportAppConfig.uuid``: a fresh ``uuid.uuid4().hex`` unless the
  document holds one), since the ``default`` its property declares is then
  not what HQ writes.
- ``schema:<Class>.<undeclared>``: any key the class does not declare, as
  jsonobject (``jsonobject/base.pyx``, ``JsonObjectBase.__init__`` and
  ``__setattr__``) wraps it: kept as a dynamic property when the class allows
  them (``_allow_dynamic_properties``) and the key names no data descriptor of
  the class and does not start with ``_``; refused otherwise.
- ``schema:<Class>.<attribute>`` with ``declared: false`` and a ``descriptor``:
  each data descriptor (a property, or HQ's own such as ``FormSource``) of the
  class whose name is not a declared key and does not start with ``_``. A
  document key naming one does not become a dynamic property: jsonobject sets
  the attribute, which a descriptor without a setter refuses
  (``WrappingAttributeError``) and a descriptor with one (``FormSource.__set__``,
  which stores a form's source as the ``<unique_id>.xml`` attachment) runs.
- ``schema:dispatch(<dispatcher>)``: each of the four dispatchers above, with
  the doc types it accepts and what it does with any other (the ``raise`` exits
  of the dispatcher and of the module's functions it calls).

Classes are found after the boot, by walking ``_properties_by_key`` from
``Application`` and the classes HQ's four dispatchers choose
(``models/modules.py::ModuleBase.wrap``, ``models/forms.py::FormBase.wrap``,
``util.py::get_correct_app_class`` through ``app_doc_types`` and
``models/report_app_config.py::ReportAppFilter.wrap`` through
``get_all_mobile_filter_configs``), following each object and container
property's item type and the subclass closure of every class reached. A class
defined in a test module is not app schema.
"""

from __future__ import annotations

import ast
import inspect
import json
from collections import defaultdict

from proof.surface import pyast
from proof.surface.hqboot import HQ_ROOTS
from proof.surface.model import Item, Sources, SurfaceError, canonical, item

FAMILY = "schema"


def extract(sources: Sources) -> list[Item]:
    from corehq.apps.app_manager import models
    from corehq.apps.app_manager.models import report_app_config
    from corehq.apps.app_manager.util import app_doc_types

    dispatch: dict[type, list[dict]] = defaultdict(list)
    for dispatcher in (models.ModuleBase, models.FormBase):
        for doc_type, chosen in _wrap_dispatch(sources, dispatcher):
            dispatch[chosen].append({"by": f"{dispatcher.__name__}.wrap", "docType": doc_type})
    for doc_type, chosen in app_doc_types().items():
        dispatch[chosen].append({"by": "get_correct_app_class", "docType": doc_type})
    for config in report_app_config.get_all_mobile_filter_configs():
        dispatch[config.filter_class].append({"by": "ReportAppFilter.wrap", "docType": config.doc_type})

    classes = _reach([models.Application, *dispatch])
    by_name: dict[str, type] = {}
    for cls in classes:
        if cls.__name__ in by_name:
            raise SurfaceError(
                f"Two app schema classes are named {cls.__name__} ({by_name[cls.__name__].__module__} and "
                f"{cls.__module__}), so `schema:{cls.__name__}` would name both. The schema grammar needs a "
                "qualified spelling for them."
            )
        by_name[cls.__name__] = cls

    items = []
    for name, cls in sorted(by_name.items()):
        source = _source(sources, cls)
        raw = _raw_accesses(sources, cls)
        filled = _filled_by_init(sources, cls)
        bases = [base.__name__ for base in cls.__mro__[1:] if base in classes]
        items.append(
            item(
                f"{FAMILY}:{name}",
                source,
                bases=bases,
                dispatch=sorted(dispatch.get(cls, []), key=lambda d: (d["by"], d["docType"])),
                keepsUndeclaredKeys=bool(cls._allow_dynamic_properties),
            )
        )
        declared = cls._properties_by_key
        for key, prop in sorted(declared.items()):
            facts = _property_facts(cls, key, prop)
            if key in raw:
                facts["rawReads"] = raw[key]
            if key in filled:
                facts.update(filled[key])
            items.append(item(f"{FAMILY}:{name}.{key}", source, declared=True, **facts))
        for key in sorted(set(raw) - set(declared)):
            items.append(item(f"{FAMILY}:{name}.{key}", source, declared=False, rawReads=raw[key]))
        items.append(item(f"{FAMILY}:{name}.<undeclared>", source, **_undeclared(cls)))
        taken = set(declared) | set(raw) | {"<undeclared>"}
        for attribute, facts in sorted(_descriptors(sources, cls).items()):
            if attribute not in taken:
                at = facts.pop("at")
                items.append(item(f"{FAMILY}:{name}.{attribute}", [source, *at], declared=False, **facts))
    items.extend(_dispatchers(sources, dispatch))
    return items


def _undeclared(cls) -> dict:
    """What jsonobject does with a key the class does not declare."""
    allowed = bool(cls._allow_dynamic_properties)
    return {"declared": False, "kept": allowed, "refusedWith": None if allowed else "WrappingAttributeError"}


def _descriptors(sources: Sources, cls) -> dict[str, dict]:
    """Each data descriptor of the class (by its static attribute, so no descriptor runs) whose name a
    document key could take: not declared, not starting with ``_``."""
    found = {}
    for attribute in dir(cls):
        if attribute.startswith("_") or attribute in cls._properties_by_attr:
            continue
        value = None
        owner = None
        for base in cls.__mro__:
            if attribute in base.__dict__:
                value, owner = base.__dict__[attribute], base
                break
        if value is None or not inspect.isdatadescriptor(value) or _is_json_property(value):
            continue
        if isinstance(value, property):
            setter = value.fset is not None
            descriptor = "property"
        else:
            setter = "__set__" in type(value).__dict__ or any(
                "__set__" in vars(base) for base in type(value).__mro__[:-1]
            )
            descriptor = type(value).__name__
        in_hq = owner.__module__.startswith(HQ_ROOTS)
        found[attribute] = {
            "descriptor": descriptor,
            "definedIn": f"{owner.__module__}.{owner.__qualname__}",
            "setter": bool(setter),
            "keyHandling": "runs the setter" if setter else "refused (WrappingAttributeError)",
            "at": [f"{sources.relative(inspect.getsourcefile(owner))}::{owner.__qualname__}"] if in_hq else [],
        }
    return found


DISPATCHERS = (
    ("ModuleBase.wrap", "corehq/apps/app_manager/models/modules.py", "ModuleBase.wrap"),
    ("FormBase.wrap", "corehq/apps/app_manager/models/forms.py", "FormBase.wrap"),
    ("get_correct_app_class", "corehq/apps/app_manager/util.py", "get_correct_app_class"),
    ("ReportAppFilter.wrap", "corehq/apps/app_manager/models/report_app_config.py", "ReportAppFilter.wrap"),
)


def _dispatchers(sources: Sources, dispatch: dict) -> list[Item]:
    accepted: dict[str, list[str]] = defaultdict(list)
    for chosen in dispatch.values():
        for entry in chosen:
            accepted[entry["by"]].append(entry["docType"])
    items = []
    for by, relative, qualname in DISPATCHERS:
        path = sources.hq / relative
        function = pyast.find_function(path, qualname)
        tree = pyast.parse(path)
        module_functions = {name: node for name, node in pyast.walk_functions(tree) if "." not in name}
        raises = [exit for exit in pyast.exits(function) if exit["exit"].startswith("raise")]
        where = [f"{sources.relative(path)}::{qualname}"]
        for node in ast.walk(function):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in module_functions:
                callee = module_functions[node.func.id]
                for exit in pyast.exits(callee):
                    if exit["exit"].startswith("raise"):
                        raises.append({**exit, "in": node.func.id})
                where.append(f"{sources.relative(path)}::{node.func.id}")
        if by not in accepted:
            raise SurfaceError(f"The schema family found no doc type {by} chooses.")
        items.append(
            item(
                f"{FAMILY}:dispatch({by})",
                where,
                accepts=sorted(accepted[by]),
                otherwise=raises,
            )
        )
    return items


def _reach(seeds) -> set[type]:
    from jsonobject.base import JsonObjectMeta
    from jsonobject.base_properties import JsonContainerProperty
    from jsonobject.properties import ObjectProperty

    reached: set[type] = set()
    queue = list(seeds)
    while queue:
        cls = queue.pop()
        if cls in reached or not isinstance(cls, JsonObjectMeta) or _is_test(cls):
            continue
        reached.add(cls)
        for prop in cls._properties_by_key.values():
            if isinstance(prop, ObjectProperty):
                queue.append(prop.item_type)
            elif isinstance(prop, JsonContainerProperty) and isinstance(prop.item_wrapper, ObjectProperty):
                queue.append(prop.item_wrapper.item_type)
        queue.extend(cls.__subclasses__())
    return reached


def _is_test(cls) -> bool:
    parts = cls.__module__.split(".")
    return "tests" in parts or any(part.startswith("test_") for part in parts)


def _wrap_dispatch(sources: Sources, dispatcher) -> list[tuple[str, type]]:
    """The (doc_type, class) pairs a dispatcher's ``wrap`` chooses between, read from its syntax tree."""
    function = inspect.unwrap(dispatcher.__dict__["wrap"].__func__)
    path = pyast.in_checkout(sources.hq, inspect.getsourcefile(function))
    node = pyast.find_function(path, function.__qualname__)
    namespace = function.__globals__
    pairs = []
    for branch in ast.walk(node):
        if not isinstance(branch, ast.If) or not isinstance(branch.test, ast.Compare):
            continue
        test = branch.test
        if not (len(test.ops) == 1 and isinstance(test.ops[0], ast.Eq)):
            continue
        doc_type = pyast.string(test.comparators[0])
        if doc_type is None:
            continue
        for statement in branch.body:
            call = statement.value if isinstance(statement, ast.Return) else None
            if (
                isinstance(call, ast.Call)
                and isinstance(call.func, ast.Attribute)
                and call.func.attr == "wrap"
                and isinstance(call.func.value, ast.Name)
            ):
                pairs.append((doc_type, namespace[call.func.value.id]))
    if not pairs:
        raise SurfaceError(
            f"The surface extractor found no doc_type dispatch in {dispatcher.__name__}.wrap. HQ changed how "
            "it chooses a class by doc_type; the schema family must learn the new dispatch."
        )
    return pairs


def _source(sources: Sources, cls) -> str:
    return f"{sources.relative(inspect.getsourcefile(cls))}::{cls.__qualname__}"


def _property_facts(cls, key, prop) -> dict:
    from jsonobject.base_properties import JsonContainerProperty
    from jsonobject.properties import ObjectProperty

    facts: dict = {"type": type(prop).__name__}
    if isinstance(prop, ObjectProperty):
        facts["itemType"] = prop.item_type.__name__
    elif isinstance(prop, JsonContainerProperty):
        wrapper = prop.item_wrapper
        if isinstance(wrapper, ObjectProperty):
            facts["itemType"] = wrapper.item_type.__name__
        elif wrapper is not None:
            facts["itemType"] = type(wrapper).__name__
    if prop.choices:
        facts["choices"] = canonical(list(prop.choices), f"schema:{cls.__name__}.{key} choices")
    facts["required"] = bool(prop.required)
    facts["excludeIfNone"] = bool(prop.exclude_if_none)
    facts["default"] = _default(cls, key, prop)
    return facts


def _default(cls, key, prop):
    """The JSON HQ writes for the key when a document leaves it out."""
    try:
        value = prop.default()
    except TypeError:
        # couchdbkit's doc_type default reads the instance it fills.
        value = prop.default(object.__new__(cls))
    json_value = None if value is None else prop.unwrap(value)[1]
    try:
        return json.loads(json.dumps(json_value, sort_keys=True))
    except TypeError as error:
        raise SurfaceError(
            f"The default HQ writes for {cls.__name__}.{key} is not JSON ({error}), so the surface cannot record it."
        ) from error


def _raw_accesses(sources: Sources, cls) -> dict[str, list[dict]]:
    """Each raw key a ``wrap`` in the class's HQ ancestry or one of its descriptors reads, by key."""
    found: dict[str, list[dict]] = defaultdict(list)
    readers = []
    for base in cls.__mro__:
        if not base.__module__.startswith(HQ_ROOTS):
            continue
        wrap = base.__dict__.get("wrap")
        if isinstance(wrap, classmethod):
            readers.append(inspect.unwrap(wrap.__func__))
        for value in base.__dict__.values():
            kind = type(value)
            if (
                kind.__module__.startswith(HQ_ROOTS)
                and not isinstance(value, (type, classmethod, staticmethod, property))
                and hasattr(kind, "__get__")
                and not _is_json_property(value)
            ):
                for method in ("__get__", "__set__", "__delete__"):
                    function = kind.__dict__.get(method)
                    if function is not None:
                        readers.append(function)
    for function in readers:
        path = pyast.in_checkout(sources.hq, inspect.getsourcefile(function))
        qualname = function.__qualname__
        node = pyast.find_function(path, qualname)
        where = f"{sources.relative(path)}::{qualname}"
        for key, access in sorted(_accesses(node).items()):
            entry = {"at": where, "access": sorted(access)}
            if entry not in found[key]:
                found[key].append(entry)
    return {key: sorted(entries, key=lambda e: e["at"]) for key, entries in found.items()}


def _filled_by_init(sources: Sources, cls) -> dict[str, dict]:
    """The declared keys an HQ ``__init__`` in the class's ancestry assigns (``self.<attribute> = ...``), each
    with the constructor, the expression and the conditions it is assigned under."""
    found: dict[str, dict] = {}
    by_attribute = {attribute: prop.name for attribute, prop in cls._properties_by_attr.items()}
    for base in reversed(cls.__mro__):
        init = base.__dict__.get("__init__")
        if not base.__module__.startswith(HQ_ROOTS) or not inspect.isfunction(init):
            continue
        path = pyast.in_checkout(sources.hq, inspect.getsourcefile(init))
        node = pyast.find_function(path, init.__qualname__)

        def assigns_self(statement):
            return isinstance(statement, ast.Assign) and any(
                isinstance(target, ast.Attribute)
                and isinstance(target.value, ast.Name)
                and target.value.id == "self"
                and target.attr in by_attribute
                for target in statement.targets
            )

        for statement, conditions in pyast.guarded(node.body, assigns_self):
            for target in statement.targets:
                if isinstance(target, ast.Attribute) and target.attr in by_attribute:
                    found[by_attribute[target.attr]] = {
                        "defaultComputedBy": f"{init.__module__}.{init.__qualname__}",
                        "defaultComputedAs": ast.unparse(statement.value),
                        "defaultComputedWhen": conditions,
                    }
    return found


def _is_json_property(value) -> bool:
    from jsonobject.base_properties import JsonProperty

    return isinstance(value, JsonProperty)


def _accesses(function: ast.FunctionDef) -> dict[str, set[str]]:
    """The literal keys the function reads from, writes to or removes from its document argument."""
    arguments = function.args.posonlyargs + function.args.args
    if len(arguments) < 2:
        return {}
    names = {arguments[1].arg}
    changed = True
    while changed:
        changed = False
        for node in ast.walk(function):
            # `data = data.copy()` keeps reading the same document.
            if (
                isinstance(node, ast.Assign)
                and isinstance(node.value, ast.Call)
                and isinstance(node.value.func, ast.Attribute)
                and node.value.func.attr == "copy"
                and isinstance(node.value.func.value, ast.Name)
                and node.value.func.value.id in names
            ):
                for target in node.targets:
                    if isinstance(target, ast.Name) and target.id not in names:
                        names.add(target.id)
                        changed = True
    accesses: dict[str, set[str]] = defaultdict(set)
    for node in ast.walk(function):
        if isinstance(node, ast.Subscript) and isinstance(node.value, ast.Name) and node.value.id in names:
            key = pyast.string(node.slice)
            if key is not None:
                accesses[key].add({ast.Load: "read", ast.Store: "write", ast.Del: "delete"}[type(node.ctx)])
        elif (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and isinstance(node.func.value, ast.Name)
            and node.func.value.id in names
            and node.func.attr in ("get", "pop", "setdefault")
            and node.args
        ):
            key = pyast.string(node.args[0])
            if key is not None:
                accesses[key].add(node.func.attr)
        elif (
            isinstance(node, ast.Compare)
            and len(node.ops) == 1
            and isinstance(node.ops[0], (ast.In, ast.NotIn))
            and isinstance(node.comparators[0], ast.Name)
            and node.comparators[0].id in names
        ):
            key = pyast.string(node.left)
            if key is not None:
                accesses[key].add("contains")
    return accesses
