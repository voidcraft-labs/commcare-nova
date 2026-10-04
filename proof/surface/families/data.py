"""What an app reads from HQ's data surfaces: case search's CSQL, lookup tables, media and
the project-space settings publish confirms.

Keys:

- ``csql-fn:<name>``: each function HQ's case search compiler accepts in an
  ``_xpath_query`` (``case_search/xpath_functions/__init__.py``,
  ``XPATH_VALUE_FUNCTIONS`` and ``XPATH_QUERY_FUNCTIONS``, as HQ holds them
  after the boot), with its kind (``value`` or ``query``) and the
  implementation it names.
- ``csql-metadata:<key>``: each case metadata property the search index holds
  (``case_search/const.py::INDEXED_METADATA_BY_KEY``), with its case field and
  whether it is a date-time.
- ``csql-op:<operator>``: each operator of ``COMPARISON_OPERATORS`` and
  ``OPERATOR_MAPPING`` (range operators with their range name).
- ``csql-unit:<unit>``: each distance unit ``es/queries.py::DISTANCE_UNITS`` accepts.
- ``lookup-model:<Model>.<field>``: each field of the lookup table models
  (``fixtures/models.py``: the Django fields of ``LookupTable``,
  ``LookupTableRow`` and ``LookupTableRowOwner``, and the attrs fields of
  ``TypeField`` and ``Field``), ``lookup-model:<Model>.unique(<fields>)`` for
  each uniqueness constraint, and ``lookup-model:OwnerType.<name>`` for each
  owner type.
- ``lookup-workbook:<word>``: each key the workbook reader
  (``fixtures/upload/workbook.py``) reads from a sheet or row: subscripts,
  ``.get`` calls and ``in`` tests with a literal (or an imported constant)
  key, and the sheets it opens by name.
- ``lookup-code:<path>::<qualname>`` and ``media-code:<path>::<qualname>``:
  the functions that decide a lookup table's wire and a media file's
  classification and paths (``fixturegenerators.py::ItemListsProvider.to_xml``,
  ``utils.py::is_identifier_invalid``, ``upload/run_upload.py::_run_upload``
  with each table's ``delete_missing``, ``hqmedia/models.py::CommCareMultimedia.get_class_by_data``,
  ``suite_xml/generator.py::MediaSuiteGenerator.media_resources``,
  ``hqmedia/tasks.py::process_bulk_upload_zip`` and the rest), each with the
  calls and string literals its syntax tree holds; and
  ``lookup-code:<path>::<CONSTANT>`` for each upload constant whose value
  decides what an upload accepts (``upload/const.py::MAX_FIXTURE_ROWS``), with
  its value and the functions that read it.
- ``media-class:<Class>``: each media document class (``CommCareMultimedia.get_doc_types``
  and ``CommCareMultimedia``), with the base MIME type ``get_class_by_data``
  maps to it and the suite descriptor type ``media_resources`` writes for it.
- ``project-setting:<Model>.<field>``: the project-space settings publish
  confirms: every field of ``CaseSearchConfig`` and
  ``LocationFixtureConfiguration`` and ``Domain.commtrack_enabled``, with its
  type and default.

In each of these families, whitespace and ``%`` in a name are percent-encoded,
so a key never holds whitespace (``lookup-workbook:field%20{i%20+%201}``).
"""

from __future__ import annotations

import ast
import inspect
from pathlib import Path
from urllib.parse import quote

from proof.surface import pyast
from proof.surface.model import Item, Sources, SurfaceError, canonical, item

WORKBOOK = "corehq/apps/fixtures/upload/workbook.py"
LOOKUP_CODE = (
    ("corehq/apps/fixtures/fixturegenerators.py", "ItemListsProvider.to_xml"),
    ("corehq/apps/fixtures/fixturegenerators.py", "ItemListsProvider._get_schema_element"),
    ("corehq/apps/fixtures/utils.py", "is_identifier_invalid"),
    ("corehq/apps/fixtures/utils.py", "clean_fixture_field_name"),
    ("corehq/apps/fixtures/upload/run_upload.py", "_run_upload"),
)
# Constants of the lookup upload whose value decides what an upload accepts, with the directory whose
# functions read them.
LOOKUP_CONSTANTS = (("corehq/apps/fixtures/upload/const.py", "MAX_FIXTURE_ROWS", "corehq/apps/fixtures/upload"),)
MEDIA_CODE = (
    ("corehq/apps/hqmedia/models.py", "CommCareMultimedia.get_class_by_data"),
    ("corehq/apps/hqmedia/models.py", "CommCareMultimedia.get_base_mime_type"),
    ("corehq/apps/hqmedia/models.py", "CommCareMultimedia.get_mime_type"),
    ("corehq/apps/hqmedia/models.py", "CommCareMultimedia.get_form_path"),
    ("corehq/apps/app_manager/suite_xml/generator.py", "MediaSuiteGenerator.media_resources"),
    ("corehq/apps/hqmedia/views.py", "iter_media_files"),
    ("corehq/apps/hqmedia/tasks.py", "process_bulk_upload_zip"),
)


def name(text: str) -> str:
    """A key name: the text with whitespace and ``%`` percent-encoded."""
    return quote(text, safe="".join(chr(c) for c in range(33, 127) if chr(c) != "%"))


def extract(sources: Sources) -> list[Item]:
    return [*csql(sources), *lookup_tables(sources), *media(sources), *project_space(sources)]


def csql(sources: Sources) -> list[Item]:
    from corehq.apps.case_search import const
    from corehq.apps.case_search import xpath_functions as functions
    from corehq.apps.es import queries

    items = []
    for kind, table, symbol in (
        ("value", functions.XPATH_VALUE_FUNCTIONS, "XPATH_VALUE_FUNCTIONS"),
        ("query", functions.XPATH_QUERY_FUNCTIONS, "XPATH_QUERY_FUNCTIONS"),
    ):
        where = f"{sources.relative(inspect.getsourcefile(functions))}::{symbol}"
        for function_name, implementation in sorted(table.items()):
            items.append(
                item(
                    f"csql-fn:{name(function_name)}",
                    where,
                    kind=kind,
                    implementation=f"{implementation.__module__}.{implementation.__qualname__}",
                )
            )
    const_path = sources.relative(inspect.getsourcefile(const))
    for key, meta in sorted(const.INDEXED_METADATA_BY_KEY.items()):
        items.append(
            item(
                f"csql-metadata:{name(key)}",
                f"{const_path}::INDEXED_METADATA_BY_KEY",
                systemName=meta.system_name,
                isDatetime=bool(meta.is_datetime),
                esField=meta.es_field_name,
                computedValue=meta._value_getter is not None,
            )
        )
    for operator in const.COMPARISON_OPERATORS:
        facts = {"kind": "comparison"}
        if operator in const.RANGE_OP_MAPPING:
            facts["range"] = const.RANGE_OP_MAPPING[operator]
        items.append(item(f"csql-op:{name(operator)}", f"{const_path}::COMPARISON_OPERATORS", **facts))
    for operator in sorted(const.OPERATOR_MAPPING):
        items.append(item(f"csql-op:{name(operator)}", f"{const_path}::OPERATOR_MAPPING", kind="boolean"))
    units_path = sources.relative(inspect.getsourcefile(queries))
    for unit in queries.DISTANCE_UNITS:
        items.append(item(f"csql-unit:{name(unit)}", f"{units_path}::DISTANCE_UNITS"))
    return items


def lookup_tables(sources: Sources) -> list[Item]:
    import attrs
    from corehq.apps.fixtures import models

    path = sources.relative(inspect.getsourcefile(models))
    items = []
    for model in (models.LookupTable, models.LookupTableRow, models.LookupTableRowOwner):
        for field in model._meta.concrete_fields:
            items.append(
                item(f"lookup-model:{model.__name__}.{field.name}", f"{path}::{model.__name__}", **_django_field(field))
            )
        for constraint in model._meta.unique_together:
            items.append(
                item(
                    f"lookup-model:{model.__name__}.unique({','.join(constraint)})",
                    f"{path}::{model.__name__}",
                )
            )
    for cls in (models.TypeField, models.Field):
        for attribute in attrs.fields(cls):
            facts = {"alias": attribute.alias}
            if attribute.default is not attrs.NOTHING:
                default = attribute.default
                if isinstance(default, attrs.Factory):
                    default = default.factory()
                facts["default"] = canonical(default, f"{cls.__name__}.{attribute.name}")
            items.append(item(f"lookup-model:{cls.__name__}.{attribute.name}", f"{path}::{cls.__name__}", **facts))
    for owner in models.OwnerType:
        items.append(item(f"lookup-model:OwnerType.{owner.name}", f"{path}::OwnerType", value=owner.value))
    items.extend(workbook_vocabulary(sources, sources.hq / WORKBOOK))
    for relative, qualname in LOOKUP_CODE:
        items.append(_code_item("lookup-code", sources, relative, qualname))
    for relative, constant, readers in LOOKUP_CONSTANTS:
        items.append(_constant_item("lookup-code", sources, relative, constant, readers))
    return items


def _constant_item(family: str, sources: Sources, relative: str, constant: str, readers: str) -> Item:
    """A module constant's value, read from the module's syntax tree, and every function under ``readers`` that
    reads the name."""
    path = sources.hq / relative
    constants = pyast.module_constants(pyast.parse(path))
    if constant not in constants:
        raise SurfaceError(f"The surface extractor found no constant {constant} bound to a literal in {path}.")
    read_by = set()
    for module in sorted((sources.hq / readers).rglob("*.py")):
        if "tests" in module.parts:
            continue
        for qualname, function in pyast.walk_functions(pyast.parse(module)):
            if any(isinstance(node, ast.Name) and node.id == constant for node in ast.walk(function)):
                read_by.add(f"{sources.relative(module)}::{qualname}")
    return item(
        f"{family}:{name(relative)}::{constant}",
        f"{sources.relative(path)}::{constant}",
        value=canonical(constants[constant], constant),
        readBy=sorted(read_by),
    )


def _django_field(field) -> dict:
    from django.db.models.fields import NOT_PROVIDED

    facts = {"type": type(field).__name__, "null": bool(field.null)}
    if getattr(field, "max_length", None) is not None:
        facts["maxLength"] = field.max_length
    if callable(field.default):
        # A computed default (a fresh id, the current time) is named, never called.
        default = field.default
        facts["defaultComputedBy"] = f"{default.__module__}.{default.__qualname__}"
    elif field.default is not NOT_PROVIDED:
        facts["default"] = canonical(field.default, field.name)
    if field.choices:
        facts["choices"] = canonical([value for value, _ in field.choices], field.name)
    return facts


def workbook_vocabulary(sources: Sources, path: Path) -> list[Item]:
    """Each key the workbook reader reads from a sheet or a row.

    A key is a string literal, a constant the module defines or imports, or a
    loop variable that runs over a literal list or a dict literal's keys; a
    read through a module-level or imported table (the failure messages) is
    not a workbook read.
    """
    tree = pyast.parse(path)
    constants = _imported_constants(sources, path, tree)
    module_names = _module_names(tree)
    arguments = _argument_values(tree, constants)
    words: dict[str, dict[str, set[str]]] = {}

    def add(word: str, how: str, where: str) -> None:
        entry = words.setdefault(word, {"access": set(), "readers": set()})
        entry["access"].add(how)
        entry["readers"].add(where)

    for scope, function in pyast.walk_functions(tree):
        loops = _loop_values(function)
        for parameter, passed in arguments.get(function.name, {}).items():
            loops.setdefault(parameter, set()).update(passed)

        def values(node: ast.AST, loops: dict[str, set[str]] = loops) -> list[str]:
            text = pyast.string(node)
            if text is not None:
                return [text]
            if isinstance(node, ast.Name):
                if isinstance(constants.get(node.id), str):
                    return [constants[node.id]]
                return sorted(loops.get(node.id, ()))
            if isinstance(node, ast.JoinedStr):
                return [_pattern(node)]
            return []

        def row_like(node: ast.AST) -> bool:
            return not (isinstance(node, ast.Name) and node.id in module_names)

        for node in _own_nodes(function):
            if isinstance(node, ast.Subscript) and isinstance(node.ctx, ast.Load) and row_like(node.value):
                for word in values(node.slice):
                    add(word, "subscript", scope)
            elif isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.args:
                if node.func.attr == "get" and row_like(node.func.value):
                    for word in values(node.args[0]):
                        add(word, "get", scope)
                elif node.func.attr in ("get_data_sheet", "get_worksheet"):
                    for word in values(node.args[0]):
                        add(word, "sheet", scope)
            elif isinstance(node, ast.Compare) and any(isinstance(op, (ast.In, ast.NotIn)) for op in node.ops):
                if all(row_like(comparator) for comparator in node.comparators):
                    for word in values(node.left):
                        add(word, "contains", scope)
    relative = sources.relative(path)
    return [
        item(
            f"lookup-workbook:{name(word)}",
            [f"{relative}::{reader}" for reader in entry["readers"]],
            access=sorted(entry["access"]),
        )
        for word, entry in sorted(words.items())
    ]


def _pattern(node: ast.JoinedStr) -> str:
    """An f-string as the pattern it builds: its text, with each replacement field in braces."""
    return "".join(
        part.value if isinstance(part, ast.Constant) else "{" + ast.unparse(part.value) + "}" for part in node.values
    )


def _argument_values(tree: ast.Module, constants: dict[str, object]) -> dict[str, dict[str, set[str]]]:
    """For each function of the module called by name, the literal strings or f-string patterns
    each call passes to each of its parameters."""
    functions = {function.name: function for _, function in pyast.walk_functions(tree)}
    found: dict[str, dict[str, set[str]]] = {}
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in functions):
            continue
        parameters = [argument.arg for argument in functions[node.func.id].args.args]
        for parameter, argument in zip(parameters, node.args, strict=False):
            text = pyast.string(argument)
            if text is None and isinstance(argument, ast.JoinedStr):
                text = _pattern(argument)
            if text is None and isinstance(argument, ast.Name) and isinstance(constants.get(argument.id), str):
                text = constants[argument.id]
            if text is not None:
                found.setdefault(node.func.id, {}).setdefault(parameter, set()).add(text)
    return found


def _module_names(tree: ast.Module) -> set[str]:
    names = set()
    for statement in tree.body:
        if isinstance(statement, (ast.Import, ast.ImportFrom)):
            names |= {(alias.asname or alias.name).split(".")[0] for alias in statement.names}
        elif isinstance(statement, ast.Assign):
            names |= {target.id for target in statement.targets if isinstance(target, ast.Name)}
    return names


def _own_nodes(function: ast.AST):
    """The nodes of a function's body, not those of the functions nested in it (they are walked on their own)."""
    stack = list(function.body)
    while stack:
        node = stack.pop()
        yield node
        for child in ast.iter_child_nodes(node):
            if not isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                stack.append(child)


def _loop_values(function: ast.AST) -> dict[str, set[str]]:
    """Loop variables of the function that run over literal strings: ``for k in ['a', 'b']`` and
    ``for k, v in d.items()`` where ``d`` is bound to a dict literal with string keys."""
    dicts: dict[str, list[str]] = {}
    for node in _own_nodes(function):
        if isinstance(node, ast.Assign) and isinstance(node.value, ast.Dict):
            keys = [pyast.string(key) for key in node.value.keys if key is not None]
            if keys and None not in keys:
                for target in node.targets:
                    if isinstance(target, ast.Name):
                        dicts[target.id] = keys
    found: dict[str, set[str]] = {}
    for node in _own_nodes(function):
        if not isinstance(node, (ast.For, ast.comprehension)):
            continue
        iterable, target = node.iter, node.target
        literals: list[str] = []
        if isinstance(iterable, (ast.List, ast.Tuple, ast.Set)):
            literals = [pyast.string(element) for element in iterable.elts]
        elif (
            isinstance(iterable, ast.Call)
            and isinstance(iterable.func, ast.Attribute)
            and iterable.func.attr in ("items", "keys")
            and isinstance(iterable.func.value, ast.Name)
            and iterable.func.value.id in dicts
        ):
            literals = dicts[iterable.func.value.id]
            if iterable.func.attr == "items" and isinstance(target, ast.Tuple):
                target = target.elts[0]
        if literals and None not in literals and isinstance(target, ast.Name):
            found.setdefault(target.id, set()).update(literals)
    return found


def _imported_constants(sources: Sources, path: Path, tree: ast.Module) -> dict[str, object]:
    constants = dict(pyast.module_constants(tree))
    for statement in tree.body:
        if isinstance(statement, ast.ImportFrom) and statement.module and statement.level == 0:
            try:
                imported = pyast.module_constants(pyast.parse(pyast.module_path(statement.module)))
            except SurfaceError:
                continue
            for alias in statement.names:
                if alias.name in imported:
                    constants[alias.asname or alias.name] = imported[alias.name]
    return constants


def _code_item(family: str, sources: Sources, relative: str, qualname: str) -> Item:
    path = sources.hq / relative
    node = pyast.find_in(path, qualname)
    strings = sorted(
        {
            child.value
            for statement in node.body
            for child in ast.walk(statement)
            if isinstance(child, ast.Constant) and isinstance(child.value, str)
        }
        # A docstring describes the code; it is not what the code does.
        - _docstring(node)
    )
    return item(
        f"{family}:{name(relative)}::{qualname}",
        f"{sources.relative(path)}::{qualname}",
        calls=pyast.calls(node),
        strings=strings,
    )


def _docstring(node: ast.AST) -> set[str]:
    text = ast.get_docstring(node, clean=False)
    return {text} if text is not None else set()


def media(sources: Sources) -> list[Item]:
    from corehq.apps.hqmedia import models

    mime_by_class = _dict_literal_in(sources.hq / MEDIA_CODE[0][0], "CommCareMultimedia.get_class_by_data", invert=True)
    descriptors = _dict_literal_in(
        sources.hq / "corehq/apps/app_manager/suite_xml/generator.py", "MediaSuiteGenerator.media_resources"
    )
    path = sources.relative(inspect.getsourcefile(models))
    classes = sorted(set(models.CommCareMultimedia.get_doc_types()) | {"CommCareMultimedia"})
    items = [
        item(
            f"media-class:{cls}",
            f"{path}::{cls}",
            baseMimeType=mime_by_class.get(cls),
            suiteDescriptor=descriptors.get(cls),
            docType=getattr(models, cls)._doc_type if hasattr(getattr(models, cls), "_doc_type") else cls,
        )
        for cls in classes
    ]
    items.extend(_code_item("media-code", sources, relative, qualname) for relative, qualname in MEDIA_CODE)
    return items


def _dict_literal_in(path: Path, qualname: str, invert: bool = False) -> dict[str, str]:
    """The one dict literal of string or name values in a function, as {key: value}."""
    node = pyast.find_in(path, qualname)
    literals = [child for child in ast.walk(node) if isinstance(child, ast.Dict) and child.keys]
    for literal in literals:
        pairs = {}
        for key, value in zip(literal.keys, literal.values, strict=True):
            left = pyast.string(key) if key is not None else None
            right = pyast.string(value) or (value.id if isinstance(value, ast.Name) else None)
            if left is None or right is None:
                break
            pairs[left] = right
        else:
            return {right: left for left, right in pairs.items()} if invert else pairs
    raise SurfaceError(f"The surface extractor found no string-keyed dict literal in {path}::{qualname}.")


def project_space(sources: Sources) -> list[Item]:
    from corehq.apps.case_search.models import CaseSearchConfig
    from corehq.apps.domain.models import Domain
    from corehq.apps.locations.models import LocationFixtureConfiguration

    items = []
    for model in (CaseSearchConfig, LocationFixtureConfiguration):
        path = sources.relative(inspect.getsourcefile(model))
        for field in model._meta.concrete_fields:
            facts = _django_field(field)
            if field.is_relation:
                facts["relatedModel"] = field.related_model.__name__
            items.append(item(f"project-setting:{model.__name__}.{field.name}", f"{path}::{model.__name__}", **facts))
    prop = Domain._properties_by_key["commtrack_enabled"]
    items.append(
        item(
            "project-setting:Domain.commtrack_enabled",
            f"{sources.relative(inspect.getsourcefile(Domain))}::Domain",
            type=type(prop).__name__,
            default=prop.default(),
        )
    )
    return items
