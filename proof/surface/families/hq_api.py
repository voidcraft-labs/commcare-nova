"""The HQ views and resources Nova calls, as HQ serves them.

Nova calls these HQ endpoints today (``lib/commcare/client.ts``,
``lib/commcare/hq/*.ts``): the project-space list and its feature-flag filter
(``UserDomainsResource``), the case search probe (``ota/views.py::search``,
which hands every request to ``app_aware_search``), the app list
(``views/cli.py::list_apps``), the import API and its media upload and status
views (``views/app_import_api.py``), the case fixture view a suite's stack
``<query>`` requests (``ota/views.py::case_fixture``: HQ's own build points a
stack query of a search's results there,
``suite_xml/post_process/workflow.py::WorkflowQueryMeta.to_stack_datum``, and
Nova's local suites do the same), the app source (``views/apps.py::app_source``),
the current version (``views/releases.py::current_app_version``), the
application resource (``api/resources/v0_4.py::ApplicationResource``), a
build's files (``views/download.py::download_file``), the lookup table list
and upload (``fixtures/resources/v0_1.py::LookupTableResource``,
``fixtures/views.py::upload_fixture_api``), the location type and location
resources, and the mobile worker resources (``CommCareUserResource``,
``BulkUserResource``). ``fixtures/resources/v0_6.py::LookupTableItemResource``,
which the plan names for reading an HQ table's rows, is recorded beside them.

Keys:

- ``hq-api:<view or resource>`` (``hq-api:import_app_api``,
  ``hq-api:UserDomainsResource``): for a view, the routes Django's resolver
  serves it at after the boot, its decorators with their arguments as the
  syntax tree prints them (outermost first), where each decorator is defined,
  the request parameters it and the functions it hands the request to read,
  the module constants they use (so ``CASE_SEARCH_DISABLED_MSG``'s text is a
  fact), and each of those functions' body: every call it makes and every
  ``return``, ``raise``, ``continue`` and ``break`` with the conditions it runs
  under (so ``app_aware_search`` answering ``CASE_SEARCH_DISABLED_MSG`` with a
  404 unless ``case_search_enabled_for_domain(domain)`` is a fact). For a
  tastypie resource, its routes, its ``Meta`` options (the expressions its
  ``Meta`` classes assign, and the options tastypie resolved), its fields, its
  ``dehydrate_*`` and ``hydrate_*`` methods, the request and body keys its
  methods read, and each HQ method it defines or inherits with the class that
  defines it and the method's body, as for a view (so ``UserDomainsResource``'s
  refusal of a ``feature_flag`` outside ``toggles.all_toggle_slugs()`` and its
  filter through ``toggles.toggles_dict`` are facts).
- ``hq-api-decorator:<module>.<name>``: each HQ decorator those views apply,
  and each HQ function those decorators call, one level deep: how the name is
  bound (a function, or an assignment such as
  ``require_can_edit_apps = require_permission(HqPermissions.edit_apps)``) and
  every call its body makes, printed from its syntax tree (so
  ``require_mobile_access``'s permission is a fact).
- ``hq-api-support:<module>.<Class>``: each HQ class a resource's ``Meta``
  names (paginators, authentications, authorizations, serializers), with the
  calls and strings of each method it defines (so ``DoesNothingPaginator.page``'s
  response keys are facts).
- ``hq-api-permission:<name>``: each ``HqPermissions`` field those decorators
  require (``hq-api-permission:access_mobile_endpoints``), with the controls of
  HQ's role editor (``users/templates/users/edit_role.html``) bound to
  ``role.permissions.<name>``: each control's id, its ``<label for>`` text and
  the heading of the row holding it (``Mobile App Access``), which Nova's own
  copy names. The template is read with Django's template lexer (``{% trans %}``
  as the literal it translates) and Python's HTML parser. A permission the
  editor's script builds its own table row for (``edit_apps`` and ``edit_data``
  in ``users/js/edit_role.js``) has no such control, and its list is empty.
"""

from __future__ import annotations

import ast
import importlib
import inspect
from collections.abc import Iterator
from html.parser import HTMLParser
from pathlib import Path

from proof.surface import pyast
from proof.surface.hqboot import HQ_ROOTS
from proof.surface.model import Item, Sources, SurfaceError, canonical, item

VIEWS = (
    ("corehq.apps.app_manager.views.app_import_api", "import_app_api"),
    ("corehq.apps.app_manager.views.app_import_api", "upload_multimedia_api"),
    ("corehq.apps.app_manager.views.app_import_api", "multimedia_status_api"),
    ("corehq.apps.app_manager.views.cli", "list_apps"),
    ("corehq.apps.app_manager.views.apps", "app_source"),
    ("corehq.apps.app_manager.views.releases", "current_app_version"),
    ("corehq.apps.app_manager.views.download", "download_file"),
    ("corehq.apps.ota.views", "search"),
    ("corehq.apps.ota.views", "app_aware_search"),
    ("corehq.apps.ota.views", "case_fixture"),
    ("corehq.apps.fixtures.views", "upload_fixture_api"),
)
RESOURCES = (
    ("corehq.apps.api.resources.v0_5", "UserDomainsResource"),
    ("corehq.apps.api.resources.v0_4", "ApplicationResource"),
    ("corehq.apps.fixtures.resources.v0_1", "LookupTableResource"),
    ("corehq.apps.fixtures.resources.v0_6", "LookupTableItemResource"),
    ("corehq.apps.locations.resources.v0_5", "LocationTypeResource"),
    ("corehq.apps.locations.resources.v0_6", "LocationResource"),
    ("corehq.apps.api.resources.v0_5", "CommCareUserResource"),
    ("corehq.apps.api.resources.v0_5", "BulkUserResource"),
)
ROLE_EDITOR = "corehq/apps/users/templates/users/edit_role.html"
REQUEST_PARTS = ("GET", "POST", "FILES", "META", "COOKIES", "headers", "body")
META_OPTIONS = (
    "resource_name",
    "list_allowed_methods",
    "detail_allowed_methods",
    "allowed_methods",
    "always_return_data",
    "limit",
    "max_limit",
    "fields",
    "excludes",
    "include_resource_uri",
    "collection_name",
    "detail_uri_name",
)


class _Reader:
    """Where the family reads HQ's source: the checkout it is given, at the files the booted HQ imports."""

    def __init__(self, sources: Sources):
        self.sources = sources
        self.permissions: set[str] = set()

    def locate(self, module: str) -> Path:
        return pyast.in_checkout(self.sources.hq, pyast.module_path(module))

    def file(self, path: str | Path) -> Path:
        return pyast.in_checkout(self.sources.hq, path)

    def function(self, function) -> tuple[Path, str, ast.FunctionDef | ast.AsyncFunctionDef]:
        """The source file, qualname and syntax tree of a loaded function."""
        original = inspect.unwrap(function)
        path = self.file(inspect.getsourcefile(original))
        try:
            return path, original.__qualname__, pyast.find_function(path, original.__qualname__)
        except SurfaceError:
            # A function bound under another name (`get_x = helper`) is found where it starts.
            real = inspect.getsourcefile(original)
            qualname, node = pyast.function_starting_at(real, original.__code__.co_firstlineno)
            return Path(real), qualname, node


def extract(sources: Sources) -> list[Item]:
    reader = _Reader(sources)
    routes = _routes()
    decorators: dict[str, Item] = {}
    supports: dict[str, Item] = {}
    items = []
    for module_name, name in VIEWS:
        items.append(_view(reader, module_name, name, routes, decorators))
    for module_name, name in RESOURCES:
        items.append(_resource(reader, module_name, name, routes, supports))
    permissions = [_permission(reader, permission) for permission in sorted(reader.permissions)]
    return [*items, *decorators.values(), *supports.values(), *permissions]


# -- routes -------------------------------------------------------------------


def _routes() -> list[tuple[str, str | None, object]]:
    """Every URL pattern Django resolves after the boot, with its name and callback."""
    from django.urls import get_resolver

    found = []

    def join(prefix: str, pattern: str) -> str:
        # As Django joins a resolver's routes (URLResolver._join_route): an inner `^` anchors nothing.
        return prefix + (pattern[1:] if prefix and pattern.startswith("^") else pattern)

    def walk(patterns, prefix):
        for pattern in patterns:
            if hasattr(pattern, "url_patterns"):
                walk(pattern.url_patterns, join(prefix, str(pattern.pattern)))
            else:
                found.append((join(prefix, str(pattern.pattern)), pattern.name, pattern.callback))

    walk(get_resolver().url_patterns, "")
    return found


def _resource_of(callback):
    """The tastypie resource instance a resolved callback dispatches to, if any: found in the closures of the
    callback and of every function it wraps or closes over."""
    from tastypie.resources import Resource

    queue = [callback]
    seen = set()
    while queue:
        function = queue.pop()
        if id(function) in seen:
            continue
        seen.add(id(function))
        for cell in getattr(function, "__closure__", None) or ():
            try:
                value = cell.cell_contents
            except ValueError:
                continue
            if isinstance(value, Resource):
                return value
            if callable(value):
                queue.append(value)
        wrapped = getattr(function, "__wrapped__", None)
        if wrapped is not None:
            queue.append(wrapped)
    return None


# -- views --------------------------------------------------------------------


def _view(reader: _Reader, module_name, name, routes, decorators) -> Item:
    module = importlib.import_module(module_name)
    view = getattr(module, name)
    path = reader.locate(module_name)
    node = pyast.find_in(path, name)
    served = sorted(
        ({"pattern": pattern, "name": url_name} for pattern, url_name, callback in routes if callback is view),
        key=lambda route: (route["pattern"], route["name"] or ""),
    )
    if not served:
        raise SurfaceError(
            f"Django resolves no URL to {module_name}.{name} after the boot. Nova calls this view, so HQ "
            "moved or removed it; the hq-api family must follow."
        )
    applied = []
    for decorator in node.decorator_list:
        callee = decorator.func if isinstance(decorator, ast.Call) else decorator
        applied.append(
            {
                "decorator": ast.unparse(decorator),
                "definedAt": _decorator_key(reader, module_name, callee, decorators, 0),
            }
        )
    bodies: dict[str, dict] = {}
    reads, delegates, constants = _request_reads(reader, module_name, name, node, {name}, bodies)
    for decorator in node.decorator_list:
        constants.update(_constants_in(reader, module_name, decorator))
    return item(
        f"hq-api:{name}",
        f"{reader.sources.relative(path)}::{name}",
        kind="view",
        routes=served,
        decorators=applied,
        requestReads=sorted(reads),
        delegates=sorted(delegates),
        constants=canonical(dict(sorted(constants.items())), f"hq-api:{name} constants"),
        bodies=dict(sorted(bodies.items())),
    )


def _body(function: ast.FunctionDef | ast.AsyncFunctionDef) -> dict:
    return {"calls": pyast.calls(function), "exits": pyast.exits(function)}


def _decorator_key(reader: _Reader, module_name: str, callee: ast.AST, decorators: dict[str, Item], depth: int):
    """The key of the item recording where the decorator ``callee`` is defined, recording it first."""
    chain = pyast.dotted(callee)
    if chain is None:
        return None
    head, _, rest = chain.partition(".")
    bound = pyast.binding(module_name, head, HQ_ROOTS, reader.locate)
    if rest:
        # `toggles.SYNC_SEARCH_CASE_CLAIM.required_decorator`: the method on the object the chain reaches.
        target = _evaluate(module_name, chain)
        function = getattr(target, "__func__", target)
        if not callable(function) or not getattr(function, "__module__", "").startswith(HQ_ROOTS):
            return f"external:{getattr(function, '__module__', '?')}.{getattr(function, '__qualname__', chain)}"
        if getattr(inspect.unwrap(function), "__code__", None) is None:
            return None
        path, qualname, node = reader.function(function)
        key = f"hq-api-decorator:{function.__module__}.{qualname}"
        if key not in decorators:
            _note_permissions(reader, node)
            decorators[key] = item(
                key, f"{reader.sources.relative(path)}::{qualname}", binding="def", calls=pyast.calls(node)
            )
        return key
    if bound.kind == "external":
        return f"external:{bound.module}.{bound.name}"
    if bound.kind in ("unknown",) or bound.path is None:
        return None
    key = f"hq-api-decorator:{bound.symbol}"
    if key in decorators:
        return key
    where = f"{reader.sources.relative(bound.path)}::{bound.name}"
    _note_permissions(reader, bound.node)
    if bound.kind == "assign":
        facts = {
            "binding": "assign",
            "expression": ast.unparse(bound.node.value),
            "calls": pyast.calls(bound.node.value),
        }
    else:
        facts = {"binding": bound.kind, "calls": pyast.calls(bound.node)}
    decorators[key] = item(key, where, **facts)
    if depth == 0:
        for call in _called_names(bound.node):
            _decorator_key(reader, bound.module, call, decorators, depth + 1)
    return key


def _note_permissions(reader: _Reader, node: ast.AST) -> None:
    """Every ``HqPermissions.<name>`` a decorator names."""
    for child in ast.walk(node):
        if isinstance(child, ast.Attribute) and pyast.dotted(child.value) == "HqPermissions":
            reader.permissions.add(child.attr)


def _called_names(node: ast.AST) -> Iterator[ast.AST]:
    body = node.value if isinstance(node, ast.Assign) else node
    for child in ast.walk(body):
        if isinstance(child, ast.Call) and isinstance(child.func, ast.Name):
            yield child.func


def _evaluate(module_name: str, chain: str):
    value = importlib.import_module(module_name)
    for part in chain.split("."):
        value = getattr(value, part)
    return value


def _request_reads(reader: _Reader, module_name, qualname, function, seen, bodies) -> tuple[set, set, dict]:
    """The request parameters a view reads, following each HQ function it hands ``request`` to, and each
    of those functions' body."""
    bodies[f"{module_name}.{qualname}"] = _body(function)
    reads = set()
    delegates = set()
    constants = _constants_in(reader, module_name, function)
    parameters = [argument.arg for argument in function.args.args]
    request = "request" if "request" in parameters else (parameters[0] if parameters else "request")
    aliases = _request_aliases(function, request)

    def constant(node):
        # A key named by a literal, or by a module constant the function's module binds or imports
        # (`request_dict.get(CASE_SEARCH_REGISTRY_ID_KEY)`).
        text = pyast.string(node)
        if text is not None or not isinstance(node, ast.Name):
            return text
        bound = pyast.binding(module_name, node.id, HQ_ROOTS, reader.locate)
        if bound.kind == "assign" and len(bound.node.targets) == 1:
            return pyast.string(bound.node.value)
        return None

    for node in ast.walk(function):
        reads.update(_request_read(node, request, aliases, constant))
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            passes_request = any(isinstance(arg, ast.Name) and arg.id == request for arg in node.args)
            if not passes_request or node.func.id in seen:
                continue
            bound = pyast.binding(module_name, node.func.id, HQ_ROOTS, reader.locate)
            if bound.kind != "def":
                continue
            seen.add(node.func.id)
            delegates.add(f"{bound.module}.{bound.name}")
            inner_reads, inner_delegates, inner_constants = _request_reads(
                reader, bound.module, bound.name, bound.node, seen, bodies
            )
            reads |= inner_reads
            delegates |= inner_delegates
            constants.update(inner_constants)
    return reads, delegates, constants


def _request_aliases(function: ast.AST, request: str) -> dict[str, list[str]]:
    """Each local a function binds to request parts and never to anything else, with those parts
    (``request_dict = request.GET if request.method == 'GET' else request.POST``: ``GET`` and ``POST``)."""
    bound: dict[str, list[list[str]]] = {}
    for node in ast.walk(function):
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    bound.setdefault(target.id, []).append(_request_parts(node.value, request))
        elif isinstance(node, (ast.AnnAssign, ast.AugAssign)) and isinstance(node.target, ast.Name):
            bound.setdefault(node.target.id, []).append([])
    return {name: sorted({part for parts in values for part in parts}) for name, values in bound.items() if all(values)}


def _request_read(node: ast.AST, request: str, aliases=None, constant=pyast.string) -> list[str]:
    """``GET.app_id`` for ``request.GET.get('app_id')``, ``request.GET['app_id']``, ``request.GET.getlist(...)``;
    ``GET.*`` for a read of the whole query (``request.GET.lists()``, or the same through a conditional) or of a
    key ``constant`` cannot name; the same through a local the function binds to request parts alone
    (``aliases``)."""
    reads = []
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
        for part in _request_parts(node.func.value, request, aliases):
            if node.func.attr in ("get", "getlist", "pop") and node.args:
                reads.append(f"{part}.{constant(node.args[0]) or '*'}")
            else:
                reads.append(f"{part}.*")
    elif isinstance(node, ast.Subscript):
        for part in _request_parts(node.value, request, aliases):
            reads.append(f"{part}.{constant(node.slice) or '*'}")
    elif isinstance(node, ast.Compare) and any(isinstance(op, (ast.In, ast.NotIn)) for op in node.ops):
        for comparator in node.comparators:
            for part in _request_parts(comparator, request, aliases):
                reads.append(f"{part}.{constant(node.left) or '*'}")
    return reads


def _request_parts(node: ast.AST, request: str, aliases=None) -> list[str]:
    """The request parts (``GET``, ``POST``, ...) an expression reads: one, each branch of a conditional, or
    those a local holding them stands for (``aliases``)."""
    if isinstance(node, ast.IfExp):
        return _request_parts(node.body, request, aliases) + _request_parts(node.orelse, request, aliases)
    if isinstance(node, ast.Name) and aliases and node.id in aliases:
        return list(aliases[node.id])
    return [node.attr] if _is_request_part(node, request) else []


def _is_request_part(node: ast.AST, request: str) -> bool:
    if not (isinstance(node, ast.Attribute) and node.attr in REQUEST_PARTS):
        return False
    owner = node.value
    if isinstance(owner, ast.Name) and owner.id == request:
        return True
    # bundle.request.GET inside a tastypie resource.
    return isinstance(owner, ast.Attribute) and owner.attr == "request"


def _constants_in(reader: _Reader, module_name: str, node: ast.AST) -> dict[str, object]:
    constants = pyast.module_constants(pyast.parse(reader.locate(module_name)))
    return {
        child.id: constants[child.id]
        for child in ast.walk(node)
        if isinstance(child, ast.Name) and child.id in constants and child.id.isupper()
    }


# -- resources ----------------------------------------------------------------


def _resource(reader: _Reader, module_name, name, routes, supports) -> Item:
    module = importlib.import_module(module_name)
    cls = getattr(module, name)
    served = sorted(
        (
            {"pattern": pattern, "name": url_name}
            for pattern, url_name, callback in routes
            if type(_resource_of(callback)) is cls
        ),
        key=lambda route: (route["pattern"], route["name"] or ""),
    )
    meta = cls._meta
    resolved = {}
    for option in META_OPTIONS:
        value = getattr(meta, option, None)
        if isinstance(value, (list, tuple, set)):
            value = sorted(value) if isinstance(value, set) else list(value)
        resolved[option] = canonical(value, f"{name}.Meta.{option}") if _plain(value) else repr(type(value).__name__)
    for option in ("authentication", "authorization", "paginator_class", "serializer", "validation", "object_class"):
        value = getattr(meta, option, None)
        kind = value if isinstance(value, type) else type(value)
        resolved[option] = None if value is None else f"{kind.__module__}.{kind.__qualname__}"
        if value is not None and option != "object_class" and kind.__module__.startswith(HQ_ROOTS):
            _support(reader, kind, supports)
    queryset = getattr(meta, "queryset", None)
    resolved["queryset"] = None if queryset is None else f"{queryset.model.__module__}.{queryset.model.__name__}"
    assigned = {}
    for base in reversed(cls.__mro__):
        if not base.__module__.startswith(HQ_ROOTS) or "Meta" not in base.__dict__:
            continue
        base_node = pyast.find_in(reader.file(inspect.getsourcefile(base)), base.__qualname__)
        for statement in base_node.body:
            if isinstance(statement, ast.ClassDef) and statement.name == "Meta":
                for assignment in statement.body:
                    if isinstance(assignment, ast.Assign):
                        for target in assignment.targets:
                            if isinstance(target, ast.Name):
                                assigned[target.id] = {
                                    "expression": ast.unparse(assignment.value),
                                    "in": base.__qualname__,
                                }
    fields = {}
    for field_name, field in sorted(cls.base_fields.items()):
        fields[field_name] = {
            "type": type(field).__name__,
            "attribute": field.attribute if isinstance(field.attribute, str) else None,
            "null": bool(field.null),
            "readonly": bool(field.readonly),
            "unique": bool(getattr(field, "unique", False)),
        }
    methods = {}
    reads = set()
    for base in cls.__mro__:
        if not base.__module__.startswith(HQ_ROOTS):
            continue
        for method_name, value in base.__dict__.items():
            function = getattr(value, "__func__", value)
            if not inspect.isfunction(function) or method_name in methods:
                continue
            _, _, node = reader.function(function)
            methods[method_name] = {"in": base.__qualname__, **_body(node)}
            for child in ast.walk(node):
                reads.update(_request_read(child, "request"))
                read = _bundle_read(child)
                if read:
                    reads.add(read)
    return item(
        f"hq-api:{name}",
        f"{reader.sources.relative(reader.file(inspect.getsourcefile(cls)))}::{name}",
        kind="resource",
        routes=served,
        meta=resolved,
        metaAssigned=dict(sorted(assigned.items())),
        fields=fields,
        dehydrate=sorted(m for m in methods if m.startswith("dehydrate")),
        hydrate=sorted(m for m in methods if m.startswith("hydrate")),
        methods=dict(sorted(methods.items())),
        requestReads=sorted(reads),
    )


def _plain(value) -> bool:
    try:
        canonical(value)
    except Exception:
        return False
    return True


def _bundle_read(node: ast.AST) -> str | None:
    """``data.username`` for ``bundle.data['username']`` or ``bundle.data.get('username')``."""
    if isinstance(node, ast.Subscript) and isinstance(node.value, ast.Attribute) and node.value.attr == "data":
        key = pyast.string(node.slice)
        if key is not None and isinstance(node.value.value, ast.Name) and node.value.value.id == "bundle":
            return f"data.{key}"
    if (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr in ("get", "pop")
        and isinstance(node.func.value, ast.Attribute)
        and node.func.value.attr == "data"
        and isinstance(node.func.value.value, ast.Name)
        and node.func.value.value.id == "bundle"
        and node.args
    ):
        key = pyast.string(node.args[0])
        if key is not None:
            return f"data.{key}"
    return None


def _support(reader: _Reader, cls, supports) -> None:
    key = f"hq-api-support:{cls.__module__}.{cls.__qualname__}"
    if key in supports:
        return
    path = reader.file(inspect.getsourcefile(cls))
    node = pyast.find_in(path, cls.__qualname__)
    methods = {}
    for statement in node.body:
        if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef)):
            strings = sorted(
                {
                    child.value
                    for body in statement.body
                    for child in ast.walk(body)
                    if isinstance(child, ast.Constant) and isinstance(child.value, str)
                }
                - {ast.get_docstring(statement, clean=False)}
            )
            methods[statement.name] = {"calls": pyast.calls(statement), "strings": strings}
    supports[key] = item(
        key,
        f"{reader.sources.relative(path)}::{cls.__qualname__}",
        bases=[f"{base.__module__}.{base.__qualname__}" for base in cls.__bases__],
        methods=methods,
    )


# -- permissions --------------------------------------------------------------


def _permission(reader: _Reader, permission: str) -> Item:
    from corehq.apps.users.models import HqPermissions

    if permission not in HqPermissions._properties_by_key:
        raise SurfaceError(
            f"An HQ API decorator Nova's calls pass through requires HqPermissions.{permission}, which "
            "HqPermissions does not declare. HQ renamed or removed the permission; the hq-api family must follow."
        )
    template = reader.sources.hq / ROLE_EDITOR
    tree = _html_tree(_rendered_text(template.read_text(encoding="utf-8")))
    controls = []
    for element in tree.iter():
        if element.attrs.get("x-model") != f"role.permissions.{permission}":
            continue
        control_id = element.attrs.get("id")
        labels = [
            label.text()
            for label in tree.iter()
            if label.tag == "label" and control_id is not None and label.attrs.get("for") == control_id
        ]
        row = element.ancestor(lambda node: "row" in node.classes())
        headings = [] if row is None else [node.text() for node in row.iter() if "form-label" in node.classes()]
        controls.append({"control": control_id, "labels": labels, "headings": headings})
    return item(
        f"hq-api-permission:{permission}",
        [
            f"{reader.sources.relative(reader.file(inspect.getsourcefile(HqPermissions)))}::HqPermissions",
            reader.sources.relative(template),
        ],
        roleEditor=controls,
    )


def _rendered_text(text: str) -> str:
    """A Django template's text as it renders in English with no context: ``{% trans "x" %}`` as ``x``, other
    tags and variables dropped, read with Django's own lexer and variable parser."""
    from django.template.base import Lexer, TokenType, Variable
    from django.utils.text import smart_split

    out = []
    for token in Lexer(text).tokenize():
        if token.token_type == TokenType.TEXT:
            out.append(token.contents)
        elif token.token_type == TokenType.BLOCK:
            bits = list(smart_split(token.contents))
            if len(bits) == 2 and bits[0] in ("trans", "translate"):
                literal = Variable(bits[1]).literal
                if isinstance(literal, str):
                    out.append(literal)
    return "".join(out)


class _Node:
    def __init__(self, tag: str, attrs: dict, parent: _Node | None):
        self.tag = tag
        self.attrs = attrs
        self.parent = parent
        self.children: list[_Node | str] = []

    def classes(self) -> list[str]:
        return (self.attrs.get("class") or "").split()

    def iter(self) -> Iterator[_Node]:
        yield self
        for child in self.children:
            if isinstance(child, _Node):
                yield from child.iter()

    def text(self) -> str:
        parts = []
        for child in self.children:
            parts.append(child.text() if isinstance(child, _Node) else child)
        return " ".join(" ".join(parts).split())

    def ancestor(self, test) -> _Node | None:
        node = self.parent
        while node is not None and not test(node):
            node = node.parent
        return node


class _Tree(HTMLParser):
    VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = _Node("#document", {}, None)
        self.open = self.root

    def handle_starttag(self, tag, attrs):
        node = _Node(tag, {key: value or "" for key, value in attrs}, self.open)
        self.open.children.append(node)
        if tag not in self.VOID:
            self.open = node

    def handle_startendtag(self, tag, attrs):
        self.open.children.append(_Node(tag, {key: value or "" for key, value in attrs}, self.open))

    def handle_endtag(self, tag):
        node = self.open
        while node is not None and node.tag != tag:
            node = node.parent
        if node is not None and node.parent is not None:
            self.open = node.parent

    def handle_data(self, data):
        self.open.children.append(data)


def _html_tree(text: str) -> _Node:
    parser = _Tree()
    parser.feed(text)
    parser.close()
    return parser.root
