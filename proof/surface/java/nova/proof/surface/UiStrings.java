package nova.proof.surface;

import com.github.javaparser.ast.Node;
import com.github.javaparser.ast.body.CallableDeclaration;
import com.github.javaparser.ast.body.ClassOrInterfaceDeclaration;
import com.github.javaparser.ast.body.ConstructorDeclaration;
import com.github.javaparser.ast.body.EnumConstantDeclaration;
import com.github.javaparser.ast.body.EnumDeclaration;
import com.github.javaparser.ast.body.FieldDeclaration;
import com.github.javaparser.ast.body.MethodDeclaration;
import com.github.javaparser.ast.body.Parameter;
import com.github.javaparser.ast.body.TypeDeclaration;
import com.github.javaparser.ast.body.VariableDeclarator;
import com.github.javaparser.ast.expr.ArrayAccessExpr;
import com.github.javaparser.ast.expr.ArrayCreationExpr;
import com.github.javaparser.ast.expr.ArrayInitializerExpr;
import com.github.javaparser.ast.expr.AssignExpr;
import com.github.javaparser.ast.expr.BinaryExpr;
import com.github.javaparser.ast.expr.CastExpr;
import com.github.javaparser.ast.expr.ConditionalExpr;
import com.github.javaparser.ast.expr.EnclosedExpr;
import com.github.javaparser.ast.expr.Expression;
import com.github.javaparser.ast.expr.FieldAccessExpr;
import com.github.javaparser.ast.expr.LambdaExpr;
import com.github.javaparser.ast.expr.MemberValuePair;
import com.github.javaparser.ast.expr.MethodCallExpr;
import com.github.javaparser.ast.expr.MethodReferenceExpr;
import com.github.javaparser.ast.expr.NameExpr;
import com.github.javaparser.ast.expr.NormalAnnotationExpr;
import com.github.javaparser.ast.expr.ObjectCreationExpr;
import com.github.javaparser.ast.expr.StringLiteralExpr;
import com.github.javaparser.ast.expr.SuperExpr;
import com.github.javaparser.ast.expr.ThisExpr;
import com.github.javaparser.ast.stmt.ExplicitConstructorInvocationStmt;
import com.github.javaparser.ast.stmt.ForEachStmt;
import com.github.javaparser.ast.stmt.ReturnStmt;
import com.github.javaparser.ast.type.ClassOrInterfaceType;
import com.github.javaparser.ast.type.Type;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;

/**
 * The UI string ids Core's and Android's code reads, and Android's catalogs.
 *
 * A read is a call `Localization.get(id, ...)` or `Localization.getWithDefault(id, ...)`, or an
 * `@UiElement(locale = id)` annotation, in Java or in Kotlin's tokens. Its id is followed back to the values
 * it can hold: a literal or constant; each side of a `?:`; a `+` of parts (a part the reader cannot
 * name leaves a pattern, `base.*` or `*.title`); a local's initialiser and assignments; a field's
 * initialiser and every assignment to it in its class; a parameter's argument at every call the
 * method can be the target of (a call by name and argument count, on a receiver of the method's
 * class or a subclass, a static call on the class, or a call of a method it overrides; in Kotlin,
 * a call by name and argument count in a file that names the class), a constructor's at every
 * `new`, `this(...)`, `super(...)`, enum constant and Kotlin constructor call; a call's returns in
 * every method it can reach, overriding ones included, where the method returns a literal, a name
 * or a field (two calls deep at most; a method returning another call's result returns an unknown
 * value); a collection's elements from its initialiser, its `add`s and `put`s and the collections a
 * method returning it returns; an Intent's `getStringExtra(KEY)` from every `putExtra(KEY, ...)`;
 * Android's `getResources().getResourceEntryName(R.<type>.<name>)` as `<name>`, and
 * `getString(R.string.<name>)` as that string's value in `app/res/values/strings.xml`. A type name
 * resolves as Java resolves it (the file's types, imports, package), through the Kotlin classes a
 * Java hierarchy passes through. Anything else (a value from outside the code, a lambda's
 * parameter, a translation's text) is unknown, and a read of an unknown id is recorded as the
 * pattern `*`, so a read the reader cannot name is never silent. A reader of Core's code is also
 * Android or the command line when the id it reads is written in their code.
 */
final class UiStrings {
    /** A value an id can hold: exact text, or text known only at its start and end. */
    static final class Text {
        final String prefix;
        final String suffix;
        final boolean exact;

        Text(String prefix, String suffix, boolean exact) {
            this.prefix = prefix;
            this.suffix = suffix;
            this.exact = exact;
        }

        static Text exact(String value) {
            return new Text(value, "", true);
        }

        static final Text UNKNOWN = new Text("", "", false);

        Text plus(Text other) {
            if (exact && other.exact) {
                return exact(prefix + other.prefix);
            }
            if (exact) {
                return new Text(prefix + other.prefix, other.suffix, false);
            }
            if (other.exact) {
                return new Text(prefix, suffix + other.prefix, false);
            }
            return new Text(prefix, other.suffix, false);
        }

        String pattern() {
            return exact ? prefix : prefix + "*" + suffix;
        }

        @Override
        public boolean equals(Object other) {
            return other instanceof Text && ((Text) other).pattern().equals(pattern()) && ((Text) other).exact == exact;
        }

        @Override
        public int hashCode() {
            return pattern().hashCode() * 2 + (exact ? 1 : 0);
        }
    }

    /** A resource reference `R.<type>.<name>`, a value only Android's resource methods turn into text. */
    private static final class Resource {
        final String type;
        final String name;

        Resource(String type, String name) {
            this.type = type;
            this.name = name;
        }
    }

    /** What an expression can hold: texts, resource references, and whether some value is unknown. */
    private static final class Values {
        final Set<Text> texts = new LinkedHashSet<>();
        final List<Resource> resources = new ArrayList<>();
        /** Where each value was written: the node of its literal, constant or resource reference. */
        final Map<Text, Set<String>> origins = new HashMap<>();

        void add(Text text, String origin) {
            texts.add(text);
            if (origin != null) {
                origins.computeIfAbsent(text, k -> new TreeSet<>()).add(origin);
            }
        }

        void addAll(Values other) {
            for (Text text : other.texts) {
                texts.add(text);
                origins.computeIfAbsent(text, k -> new TreeSet<>()).addAll(other.origins.getOrDefault(text, Set.of()));
            }
            resources.addAll(other.resources);
        }

        static Values unknown() {
            Values out = new Values();
            out.texts.add(Text.UNKNOWN);
            return out;
        }
    }

    /** The most values one expression is followed to before the rest is read as unknown. */
    private static final int MOST_VALUES = 400;
    /** How many calls' returns, one inside another, a value is followed into. */
    private static final int MOST_RETURNS = 2;
    private int returnsFollowed;
    /** How many calls deep a value is followed back. */
    private static final int DEEPEST = 12;

    private final Code code;
    private final List<Kotlin.Unit> kotlin;
    private final Map<String, String> resourceStrings;
    private final Map<String, List<MethodCallExpr>> callsByName = new HashMap<>();
    private final Map<String, List<ObjectCreationExpr>> creationsByType = new HashMap<>();
    private final Map<String, List<CallableDeclaration<?>>> callablesByName = new HashMap<>();
    private final Map<String, List<TypeDeclaration<?>>> subtypes = new HashMap<>();
    private final Map<String, List<AssignExpr>> assignmentsByName = new HashMap<>();
    /** Values computed with nothing cut short (no cycle, no depth limit), which no later reading changes. */
    private final Map<Object, Values> done = new IdentityHashMap<>();
    private final Set<Object> visiting = java.util.Collections.newSetFromMap(new IdentityHashMap<>());
    /** How many readings were cut short so far: a cycle reached again, or the depth limit. */
    private int cut;
    private final Map<TypeDeclaration<?>, List<TypeDeclaration<?>>> ancestorsOf = new IdentityHashMap<>();
    private final Map<TypeDeclaration<?>, List<TypeDeclaration<?>>> descendantsOf = new IdentityHashMap<>();
    private Set<String> referencedNames;
    /** Each type by its fully qualified name (its file's package and its enclosing types). */
    private final Map<String, TypeDeclaration<?>> byQualifiedName = new HashMap<>();
    /** Each Kotlin call `<name>(`, by name: the unit and the index of the name's token. */
    private final Map<String, List<Object[]>> kotlinCalls = new HashMap<>();
    /** Each Kotlin class by name: its file and the names of the types it extends. */
    private final Map<String, List<Object[]>> kotlinClasses = new HashMap<>();
    /** The Kotlin classes extending each type name. */
    private final Map<String, List<String>> kotlinChildren = new HashMap<>();
    /** Each Kotlin unit's identifiers, to tell whether it names a class. */
    private final Map<Kotlin.Unit, Set<String>> kotlinNames = new IdentityHashMap<>();
    /** The parameters and locals each method, constructor or lambda declares itself, by name. */
    private static final Map<Node, Map<String, Object>> DECLARED = new IdentityHashMap<>();

    private UiStrings(Code code, List<Kotlin.Unit> kotlin, Map<String, String> resourceStrings) {
        this.code = code;
        this.kotlin = kotlin;
        this.resourceStrings = resourceStrings;
        for (Kotlin.Unit unit : kotlin) {
            Set<String> names = new HashSet<>();
            for (int i = 0; i < unit.tokens.size(); i++) {
                Kotlin.Token token = unit.tokens.get(i);
                if (token.kind == Kotlin.Kind.IDENT) {
                    names.add(token.text);
                    if (i > 0 && i + 1 < unit.tokens.size() && unit.tokens.get(i + 1).is("(")
                            && !DECLARES.contains(unit.tokens.get(i - 1).text)) {
                        kotlinCalls.computeIfAbsent(token.text, k -> new ArrayList<>()).add(new Object[]{unit, i});
                    }
                }
            }
            kotlinNames.put(unit, names);
            for (Map.Entry<String, List<String>> declared : Kotlin.supertypes(unit).entrySet()) {
                kotlinClasses.computeIfAbsent(declared.getKey(), k -> new ArrayList<>())
                        .add(new Object[]{unit, declared.getValue()});
                for (String parent : declared.getValue()) {
                    kotlinChildren.computeIfAbsent(parent, k -> new ArrayList<>()).add(declared.getKey());
                }
            }
        }
        for (Code.Unit unit : code.units) {
            for (MethodCallExpr call : unit.tree.findAll(MethodCallExpr.class)) {
                callsByName.computeIfAbsent(call.getNameAsString(), k -> new ArrayList<>()).add(call);
            }
            for (ObjectCreationExpr creation : unit.tree.findAll(ObjectCreationExpr.class)) {
                creationsByType.computeIfAbsent(creation.getType().getNameAsString(), k -> new ArrayList<>()).add(creation);
            }
            for (CallableDeclaration<?> callable : unit.tree.findAll(CallableDeclaration.class)) {
                callablesByName.computeIfAbsent(callable.getNameAsString(), k -> new ArrayList<>()).add(callable);
            }
            for (AssignExpr assign : unit.tree.findAll(AssignExpr.class)) {
                Expression target = assign.getTarget();
                String name = target instanceof NameExpr ? ((NameExpr) target).getNameAsString()
                        : target instanceof FieldAccessExpr ? ((FieldAccessExpr) target).getNameAsString() : null;
                if (name != null) {
                    assignmentsByName.computeIfAbsent(name, k -> new ArrayList<>()).add(assign);
                }
            }
            String pkg = unit.tree.getPackageDeclaration().map(p -> p.getNameAsString() + ".").orElse("");
            for (TypeDeclaration<?> type : unit.tree.findAll(TypeDeclaration.class)) {
                byQualifiedName.putIfAbsent(pkg + Code.qualifiedName(type), type);
                List<ClassOrInterfaceType> parents = new ArrayList<>();
                if (type instanceof ClassOrInterfaceDeclaration) {
                    parents.addAll(((ClassOrInterfaceDeclaration) type).getExtendedTypes());
                    parents.addAll(((ClassOrInterfaceDeclaration) type).getImplementedTypes());
                } else if (type instanceof EnumDeclaration) {
                    parents.addAll(((EnumDeclaration) type).getImplementedTypes());
                }
                for (ClassOrInterfaceType parent : parents) {
                    subtypes.computeIfAbsent(parent.getNameAsString(), k -> new ArrayList<>()).add(type);
                }
            }
        }
    }

    // -- reading ----------------------------------------------------------------------------

    /**
     * `catalogs`: each Android catalog file's ids, parsed with Core's own locale file parser
     * (`LocalizationUtils.parseLocaleInput`). `reads`: each id or pattern a reader reads, with where
     * the read is and where each value was written.
     */
    static Map<String, Object> read(Code code, List<Kotlin.Unit> kotlin, Path android) throws Exception {
        Map<String, Object> out = new TreeMap<>();
        Map<String, Object> catalogs = new TreeMap<>();
        Class<?> parser = Class.forName("org.javarosa.core.services.locale.LocalizationUtils");
        Path locales = android.resolve("app/assets/locales");
        try (java.util.stream.Stream<Path> files = Files.list(locales)) {
            for (Path file : files.sorted().toList()) {
                try (java.io.InputStream stream = Files.newInputStream(file)) {
                    @SuppressWarnings("unchecked")
                    Map<String, String> parsed = (Map<String, String>) parser.getMethod("parseLocaleInput",
                            java.io.InputStream.class).invoke(null, stream);
                    catalogs.put("commcare-android/" + android.relativize(file).toString().replace('\\', '/'),
                            new ArrayList<>(new TreeSet<>(parsed.keySet())));
                }
            }
        }
        out.put("catalogs", catalogs);
        UiStrings reader = new UiStrings(code, kotlin, resourceStrings(android.resolve("app/res/values/strings.xml")));
        out.put("reads", reader.reads());
        return out;
    }

    /** `<string name="...">` values of Android's default resource strings. */
    private static Map<String, String> resourceStrings(Path file) throws Exception {
        Map<String, String> out = new TreeMap<>();
        if (!Files.exists(file)) {
            return out;
        }
        javax.xml.parsers.DocumentBuilderFactory factory = javax.xml.parsers.DocumentBuilderFactory.newInstance();
        factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        org.w3c.dom.Document document = factory.newDocumentBuilder().parse(file.toFile());
        org.w3c.dom.NodeList strings = document.getElementsByTagName("string");
        for (int i = 0; i < strings.getLength(); i++) {
            org.w3c.dom.Element string = (org.w3c.dom.Element) strings.item(i);
            out.put(string.getAttribute("name"), string.getTextContent().trim());
        }
        return out;
    }

    private List<Object> reads() {
        // reader + "\n" + pattern -> {how -> sites}
        Map<String, Map<String, Set<String>>> found = new TreeMap<>();
        for (Code.Unit unit : code.units) {
            String reader = unit.relative.contains("/src/cli/") ? "cli" : unit.platform;
            for (MethodCallExpr call : unit.tree.findAll(MethodCallExpr.class)) {
                if (!isSink(call)) {
                    continue;
                }
                Values values = values(call.getArgument(0), 0);
                record(found, reader, values, code.where(call));
            }
            for (NormalAnnotationExpr annotation : unit.tree.findAll(NormalAnnotationExpr.class)) {
                for (MemberValuePair pair : annotation.getPairs()) {
                    if (pair.getNameAsString().equals("locale")) {
                        Values values = values(pair.getValue(), 0);
                        record(found, unit.platform, values, code.where(annotation));
                    }
                }
            }
        }
        for (Kotlin.Unit unit : kotlin) {
            List<Kotlin.Token> tokens = unit.tokens;
            for (int i = 0; i + 4 < tokens.size(); i++) {
                if (tokens.get(i).is("Localization") && tokens.get(i + 1).is(".")
                        && (tokens.get(i + 2).is("get") || tokens.get(i + 2).is("getWithDefault"))
                        && tokens.get(i + 3).is("(")) {
                    List<List<Kotlin.Token>> arguments = Kotlin.arguments(tokens, i + 3);
                    if (arguments.isEmpty()) {
                        continue;
                    }
                    Values values = kotlinValues(unit, arguments.get(0), 0);
                    record(found, unit.platform, values, Kotlin.where(unit, i));
                }
                // `@UiElement(value = ..., locale = "...")` on a Kotlin property.
                if (tokens.get(i).is("@") && tokens.get(i + 1).is("UiElement") && tokens.get(i + 2).is("(")) {
                    for (List<Kotlin.Token> argument : Kotlin.arguments(tokens, i + 2)) {
                        if (argument.size() > 2 && argument.get(0).is("locale") && argument.get(1).is("=")) {
                            Values values = kotlinValues(unit, argument.subList(2, argument.size()), 0);
                            record(found, unit.platform, values, Kotlin.where(unit, i));
                        }
                    }
                }
            }
        }
        List<Object> out = new ArrayList<>();
        for (Map.Entry<String, Map<String, Set<String>>> entry : found.entrySet()) {
            String key = entry.getKey();
            Map<String, Object> one = new TreeMap<>();
            one.put("reader", key.substring(0, key.indexOf('\n')));
            String rest = key.substring(key.indexOf('\n') + 1);
            boolean exact = rest.startsWith("=");
            one.put(exact ? "id" : "pattern", rest.substring(1));
            one.put("at", new ArrayList<>(entry.getValue().getOrDefault("at", Set.of())));
            one.put("writtenAt", new ArrayList<>(entry.getValue().getOrDefault("writtenAt", Set.of())));
            out.add(one);
        }
        return out;
    }

    private static boolean isSink(MethodCallExpr call) {
        String name = call.getNameAsString();
        return (name.equals("get") || name.equals("getWithDefault")) && call.getScope().isPresent()
                && call.getScope().get().toString().equals("Localization") && !call.getArguments().isEmpty();
    }

    private static void record(Map<String, Map<String, Set<String>>> found, String reader, Values values, String at) {
        for (Text text : values.texts) {
            if (text.exact && text.prefix.isEmpty()) {
                // An empty id names no string (`FormUploadResult.FULL_SUCCESS`'s): nothing to record.
                continue;
            }
            Set<String> origins = values.origins.getOrDefault(text, Set.of());
            // Core's code runs inside Android and the command line: an id they hand it is read there too.
            Set<String> readers = new TreeSet<>(Set.of(reader));
            for (String origin : origins) {
                if (origin.startsWith("commcare-android/")) {
                    readers.add("android");
                } else if (origin.startsWith("commcare-core/src/cli/")) {
                    readers.add("cli");
                }
            }
            for (String one : readers) {
                String key = one + "\n" + (text.exact ? "=" : "~") + text.pattern();
                Map<String, Set<String>> facts = found.computeIfAbsent(key, k -> new TreeMap<>());
                facts.computeIfAbsent("at", k -> new TreeSet<>()).add(at);
                facts.computeIfAbsent("writtenAt", k -> new TreeSet<>()).addAll(origins);
            }
        }
        if (!values.resources.isEmpty() && values.texts.isEmpty()) {
            // A resource reference read as an id stands for no text the reader can name.
            Map<String, Set<String>> facts = found.computeIfAbsent(reader + "\n~*", k -> new TreeMap<>());
            facts.computeIfAbsent("at", k -> new TreeSet<>()).add(at);
        }
    }

    // -- Java values ------------------------------------------------------------------------

    private Values values(Expression expression, int depth) {
        Values known = done.get(expression);
        if (known != null) {
            return known;
        }
        if (depth > DEEPEST) {
            cut++;
            return Values.unknown();
        }
        if (!visiting.add(expression)) {
            // Reached again through a cycle: the cycle adds no value its other paths do not.
            cut++;
            return new Values();
        }
        int before = cut;
        Values out;
        try {
            out = compute(expression, depth);
        } finally {
            visiting.remove(expression);
        }
        if (out.texts.size() > MOST_VALUES) {
            out = Values.unknown();
        }
        if (cut == before) {
            done.put(expression, out);
        }
        return out;
    }

    private Values compute(Expression expression, int depth) {
        Values out = new Values();
        if (expression instanceof EnclosedExpr) {
            return values(((EnclosedExpr) expression).getInner(), depth);
        }
        if (expression instanceof CastExpr) {
            return values(((CastExpr) expression).getExpression(), depth);
        }
        String constant = expression instanceof NameExpr && local(((NameExpr) expression).getNameAsString(), expression) != null
                ? null : code.constant(expression, Code.typeOf(expression));
        if (constant != null) {
            out.add(Text.exact(constant), code.where(expression));
            return out;
        }
        if (expression instanceof StringLiteralExpr) {
            out.add(Text.exact(((StringLiteralExpr) expression).asString()), code.where(expression));
            return out;
        }
        if (expression instanceof com.github.javaparser.ast.expr.NullLiteralExpr) {
            // No id: read as the empty id, which names no string and is never recorded.
            out.add(Text.exact(""), null);
            return out;
        }
        if (expression instanceof ConditionalExpr) {
            out.addAll(values(((ConditionalExpr) expression).getThenExpr(), depth));
            out.addAll(values(((ConditionalExpr) expression).getElseExpr(), depth));
            return out;
        }
        if (expression instanceof BinaryExpr && ((BinaryExpr) expression).getOperator() == BinaryExpr.Operator.PLUS) {
            Values left = values(((BinaryExpr) expression).getLeft(), depth);
            Values right = values(((BinaryExpr) expression).getRight(), depth);
            return concatenated(left, right);
        }
        if (expression instanceof NameExpr) {
            return named((NameExpr) expression, depth);
        }
        if (expression instanceof FieldAccessExpr) {
            FieldAccessExpr access = (FieldAccessExpr) expression;
            Expression scope = access.getScope();
            if (scope instanceof FieldAccessExpr && ((FieldAccessExpr) scope).getScope() instanceof NameExpr
                    && ((NameExpr) ((FieldAccessExpr) scope).getScope()).getNameAsString().equals("R")) {
                out.resources.add(new Resource(((FieldAccessExpr) scope).getNameAsString(), access.getNameAsString()));
                return out;
            }
            TypeDeclaration<?> owner = scope instanceof ThisExpr ? Code.typeOf(expression) : typeOf(scope);
            VariableDeclarator field = owner == null ? null : code.field(owner, access.getNameAsString());
            return field == null ? Values.unknown() : fieldValues(field, depth);
        }
        if (expression instanceof ArrayAccessExpr) {
            return elements(((ArrayAccessExpr) expression).getName(), depth);
        }
        if (expression instanceof MethodCallExpr) {
            return called((MethodCallExpr) expression, depth);
        }
        return Values.unknown();
    }

    private static Values concatenated(Values left, Values right) {
        Values out = new Values();
        Set<Text> lefts = left.texts.isEmpty() ? Set.of(Text.UNKNOWN) : left.texts;
        Set<Text> rights = right.texts.isEmpty() ? Set.of(Text.UNKNOWN) : right.texts;
        if ((long) lefts.size() * rights.size() > MOST_VALUES) {
            return Values.unknown();
        }
        for (Text l : lefts) {
            for (Text r : rights) {
                Text joined = l.plus(r);
                out.texts.add(joined);
                Set<String> origins = new TreeSet<>(left.origins.getOrDefault(l, Set.of()));
                origins.addAll(right.origins.getOrDefault(r, Set.of()));
                if (!origins.isEmpty()) {
                    out.origins.computeIfAbsent(joined, k -> new TreeSet<>()).addAll(origins);
                }
            }
        }
        return out;
    }

    /** A name: a parameter, a local, a field, or a constant. */
    private Values named(NameExpr name, int depth) {
        Object declared = local(name.getNameAsString(), name);
        if (declared instanceof Parameter) {
            Parameter parameter = (Parameter) declared;
            Node owner = parameter.getParentNode().orElse(null);
            if (owner instanceof CallableDeclaration) {
                return parameterValues((CallableDeclaration<?>) owner, same(((CallableDeclaration<?>) owner).getParameters(), parameter),
                        depth);
            }
            return Values.unknown();
        }
        if (declared instanceof VariableDeclarator) {
            VariableDeclarator variable = (VariableDeclarator) declared;
            Values out = new Values();
            Node holder = variable.getParentNode().orElse(null);
            if (holder != null && holder.getParentNode().orElse(null) instanceof ForEachStmt) {
                return elements(((ForEachStmt) holder.getParentNode().get()).getIterable(), depth);
            }
            variable.getInitializer().ifPresent(value -> out.addAll(values(value, depth)));
            Node scope = enclosingCallable(name);
            for (AssignExpr assign : assignmentsByName.getOrDefault(variable.getNameAsString(), List.of())) {
                if (assign.getTarget() instanceof NameExpr && scope != null && within(assign, scope)
                        && local(variable.getNameAsString(), assign.getTarget()) == variable) {
                    out.addAll(assigned(assign, depth));
                }
            }
            return out.texts.isEmpty() && out.resources.isEmpty() ? Values.unknown() : out;
        }
        VariableDeclarator field = code.field(Code.typeOf(name), name.getNameAsString());
        if (field == null) {
            field = code.staticImport(name, name.getNameAsString());
        }
        return field == null ? Values.unknown() : fieldValues(field, depth);
    }

    private Values assigned(AssignExpr assign, int depth) {
        if (assign.getOperator() == AssignExpr.Operator.ASSIGN) {
            return values(assign.getValue(), depth);
        }
        if (assign.getOperator() == AssignExpr.Operator.PLUS) {
            return concatenated(Values.unknown(), values(assign.getValue(), depth));
        }
        return Values.unknown();
    }

    /** A field's initialiser and every assignment to it in its class (and the classes nested in it). */
    private Values fieldValues(VariableDeclarator field, int depth) {
        Values out = new Values();
        field.getInitializer().ifPresent(value -> out.addAll(values(value, depth)));
        TypeDeclaration<?> owner = Code.typeOf(field);
        for (AssignExpr assign : assignmentsByName.getOrDefault(field.getNameAsString(), List.of())) {
            Expression target = assign.getTarget();
            boolean ours = target instanceof NameExpr ? local(field.getNameAsString(), target) == null
                    && code.field(Code.typeOf(assign), field.getNameAsString()) == field
                    : target instanceof FieldAccessExpr && (((FieldAccessExpr) target).getScope() instanceof ThisExpr
                    ? Code.typeOf(assign) == owner : typeOf(((FieldAccessExpr) target).getScope()) == owner);
            if (ours) {
                out.addAll(assigned(assign, depth + 1));
            }
        }
        return out.texts.isEmpty() && out.resources.isEmpty() ? Values.unknown() : out;
    }

    /** The values an array or collection expression's elements hold. */
    private Values elements(Expression expression, int depth) {
        if (depth > DEEPEST) {
            cut++;
            return Values.unknown();
        }
        Expression inner = expression;
        while (inner instanceof EnclosedExpr || inner instanceof CastExpr) {
            inner = inner instanceof EnclosedExpr ? ((EnclosedExpr) inner).getInner() : ((CastExpr) inner).getExpression();
        }
        Values out = new Values();
        if (inner instanceof com.github.javaparser.ast.expr.NullLiteralExpr) {
            // No collection: no elements.
            return out;
        }
        if (inner instanceof ArrayCreationExpr && ((ArrayCreationExpr) inner).getInitializer().isPresent()) {
            inner = ((ArrayCreationExpr) inner).getInitializer().get();
        }
        if (inner instanceof ArrayInitializerExpr) {
            for (Expression element : ((ArrayInitializerExpr) inner).getValues()) {
                out.addAll(values(element, depth));
            }
            return out;
        }
        VariableDeclarator held = null;
        if (inner instanceof NameExpr) {
            Object declared = local(((NameExpr) inner).getNameAsString(), inner);
            held = declared instanceof VariableDeclarator ? (VariableDeclarator) declared
                    : declared == null ? code.field(Code.typeOf(inner), ((NameExpr) inner).getNameAsString()) : null;
        } else if (inner instanceof FieldAccessExpr) {
            TypeDeclaration<?> owner = ((FieldAccessExpr) inner).getScope() instanceof ThisExpr ? Code.typeOf(inner)
                    : typeOf(((FieldAccessExpr) inner).getScope());
            held = owner == null ? null : code.field(owner, ((FieldAccessExpr) inner).getNameAsString());
        } else if (inner instanceof MethodCallExpr) {
            // What the methods it can reach return, read as collections.
            List<CallableDeclaration<?>> targets = targets((MethodCallExpr) inner);
            for (CallableDeclaration<?> target : targets == null ? List.<CallableDeclaration<?>>of() : targets) {
                if (target instanceof MethodDeclaration && ((MethodDeclaration) target).getBody().isPresent()) {
                    for (ReturnStmt returned : target.findAll(ReturnStmt.class)) {
                        if (returned.getExpression().isPresent() && enclosingCallable(returned) == target) {
                            Expression value = returned.getExpression().get();
                            if (simple(value)) {
                                out.addAll(elements(value, depth + 1));
                            } else {
                                out.texts.add(Text.UNKNOWN);
                            }
                        }
                    }
                }
            }
            return out.texts.isEmpty() && out.resources.isEmpty() ? Values.unknown() : out;
        }
        if (held != null && held.getInitializer().isPresent()) {
            Expression initial = held.getInitializer().get();
            if (initial instanceof ArrayInitializerExpr || initial instanceof ArrayCreationExpr) {
                return elements(initial, depth);
            }
            if (initial instanceof MethodCallExpr) {
                Values returned = elements(initial, depth + 1);
                if (!(returned.texts.size() == 1 && returned.texts.contains(Text.UNKNOWN))) {
                    out.addAll(returned);
                }
            }
        }
        if (held != null) {
            // A collection: the values its `add`s and `put`s put in it, in the scope it is declared in.
            Node scope = held.getParentNode().orElse(null) instanceof FieldDeclaration ? Code.typeOf(held) : enclosingCallable(held);
            for (String adder : List.of("add", "addElement", "put")) {
                for (MethodCallExpr call : callsByName.getOrDefault(adder, List.of())) {
                    if (scope != null && within(call, scope) && call.getScope().isPresent()
                            && call.getScope().get() instanceof NameExpr
                            && ((NameExpr) call.getScope().get()).getNameAsString().equals(held.getNameAsString())
                            && !call.getArguments().isEmpty()) {
                        out.addAll(values(call.getArgument(call.getArguments().size() - 1), depth + 1));
                    }
                }
            }
        }
        return out.texts.isEmpty() && out.resources.isEmpty() ? Values.unknown() : out;
    }

    /** A call's value: Android's resource methods, a map read, or what the methods it can reach return. */
    private Values called(MethodCallExpr call, int depth) {
        String name = call.getNameAsString();
        Values out = new Values();
        if (name.equals("getResourceEntryName") && call.getArguments().size() == 1) {
            Values resources = values(call.getArgument(0), depth);
            for (Resource resource : resources.resources) {
                out.add(Text.exact(resource.name), code.where(call));
            }
            return out.texts.isEmpty() ? Values.unknown() : out;
        }
        if (name.equals("getString") && !call.getArguments().isEmpty() && call.getScope().isPresent()) {
            Values resources = values(call.getArgument(0), depth);
            for (Resource resource : resources.resources) {
                String text = resource.type.equals("string") ? resourceStrings.get(resource.name) : null;
                out.add(text == null ? Text.UNKNOWN : Text.exact(text), "commcare-android/app/res/values/strings.xml::" + resource.name);
            }
            if (!resources.resources.isEmpty()) {
                return out;
            }
        }
        if (name.equals("getStringExtra") && call.getArguments().size() == 1 && call.getScope().isPresent()) {
            // An Intent's extra: the values every `putExtra` stores under the same constant key.
            String key = code.constant(call.getArgument(0), Code.typeOf(call));
            if (key != null) {
                for (MethodCallExpr put : callsByName.getOrDefault("putExtra", List.of())) {
                    if (put.getArguments().size() == 2 && key.equals(code.constant(put.getArgument(0), Code.typeOf(put)))) {
                        out.addAll(values(put.getArgument(1), depth + 1));
                    }
                }
                if (!out.texts.isEmpty()) {
                    return out;
                }
            }
        }
        if ((name.equals("toString") || name.equals("trim") || name.equals("intern")) && call.getArguments().isEmpty()
                && call.getScope().isPresent()) {
            return values(call.getScope().get(), depth);
        }
        if (name.equals("valueOf") && call.getArguments().size() == 1 && call.getScope().isPresent()
                && call.getScope().get().toString().equals("String")) {
            return values(call.getArgument(0), depth);
        }
        if (name.equals("get") && call.getArguments().size() == 1 && call.getScope().isPresent()) {
            Values held = elements(call.getScope().get(), depth);
            if (!(held.texts.size() == 1 && held.texts.contains(Text.UNKNOWN))) {
                return held;
            }
        }
        if (isSink(call)) {
            // A translation's text, not an id.
            return Values.unknown();
        }
        List<CallableDeclaration<?>> targets = targets(call);
        if (targets == null || targets.isEmpty()) {
            return Values.unknown();
        }
        if (returnsFollowed >= MOST_RETURNS) {
            // Cut short here, so what reaches this call is not remembered as its whole value.
            cut++;
            return Values.unknown();
        }
        returnsFollowed++;
        try {
            for (CallableDeclaration<?> target : targets) {
                if (!(target instanceof MethodDeclaration) || !((MethodDeclaration) target).getBody().isPresent()) {
                    continue;
                }
                for (ReturnStmt returned : target.findAll(ReturnStmt.class)) {
                    if (returned.getExpression().isPresent() && enclosingCallable(returned) == target) {
                        Expression value = returned.getExpression().get();
                        if (simple(value)) {
                            out.addAll(values(value, depth + 1));
                        } else {
                            out.texts.add(Text.UNKNOWN);
                        }
                    }
                }
            }
        } finally {
            returnsFollowed--;
        }
        return out.texts.isEmpty() && out.resources.isEmpty() ? Values.unknown() : out;
    }

    /**
     * Whether a returned value is one a call's value is followed into: a literal, a name, a field, or a
     * `?:` or `+` of those. A method returning what another call computes (`return argument.evaluate(c)`,
     * a formatter's output) is read as returning an unknown value, so a generic method never lends its
     * every caller's text to a read.
     */
    private static boolean simple(Expression value) {
        if (value instanceof EnclosedExpr) {
            return simple(((EnclosedExpr) value).getInner());
        }
        if (value instanceof CastExpr) {
            return simple(((CastExpr) value).getExpression());
        }
        if (value instanceof ConditionalExpr) {
            return simple(((ConditionalExpr) value).getThenExpr()) && simple(((ConditionalExpr) value).getElseExpr());
        }
        if (value instanceof BinaryExpr && ((BinaryExpr) value).getOperator() == BinaryExpr.Operator.PLUS) {
            return simple(((BinaryExpr) value).getLeft()) && simple(((BinaryExpr) value).getRight());
        }
        return value instanceof StringLiteralExpr || value instanceof com.github.javaparser.ast.expr.NullLiteralExpr
                || value instanceof NameExpr || value instanceof FieldAccessExpr;
    }

    /** The arguments a parameter is given at every call that can reach its method or constructor. */
    private Values parameterValues(CallableDeclaration<?> callable, int index, int depth) {
        Values out = new Values();
        int arity = callable.getParameters().size();
        boolean varargs = callable.getParameter(arity - 1).isVarArgs();
        if (callable instanceof ConstructorDeclaration) {
            TypeDeclaration<?> owner = Code.typeOf(callable);
            String typeName = owner.getNameAsString();
            for (ObjectCreationExpr creation : creationsByType.getOrDefault(typeName, List.of())) {
                if (creation.getArguments().size() == arity && resolve(typeName, creation) == owner) {
                    out.addAll(values(creation.getArgument(index), depth + 1));
                }
            }
            if (owner instanceof EnumDeclaration) {
                for (EnumConstantDeclaration constant : ((EnumDeclaration) owner).getEntries()) {
                    if (constant.getArguments().size() == arity) {
                        out.addAll(values(constant.getArgument(index), depth + 1));
                    }
                }
            }
            for (Object[] site : kotlinCalls.getOrDefault(typeName, List.of())) {
                Kotlin.Unit unit = (Kotlin.Unit) site[0];
                if (resolveKotlin(unit, typeName) == owner) {
                    List<List<Kotlin.Token>> arguments = Kotlin.arguments(unit.tokens, (Integer) site[1] + 1);
                    if (arguments.size() == arity) {
                        out.addAll(kotlinValues(unit, arguments.get(index), depth + 1));
                    }
                }
            }
            for (ExplicitConstructorInvocationStmt invocation : allConstructorInvocations()) {
                TypeDeclaration<?> at = Code.typeOf(invocation);
                boolean reaches = invocation.isThis() ? at == owner
                        : at != null && typeName.equals(Code.superName(at));
                if (reaches && invocation.getArguments().size() == arity) {
                    out.addAll(values(invocation.getArgument(index), depth + 1));
                }
            }
        } else {
            for (MethodCallExpr call : callsByName.getOrDefault(callable.getNameAsString(), List.of())) {
                int given = call.getArguments().size();
                if (given != arity && !(varargs && given >= arity - 1)) {
                    continue;
                }
                List<CallableDeclaration<?>> targets = targets(call);
                if (targets != null && same(targets, callable) >= 0 && index < given) {
                    out.addAll(values(call.getArgument(index), depth + 1));
                }
            }
            for (Object[] site : kotlinCalls.getOrDefault(callable.getNameAsString(), List.of())) {
                Kotlin.Unit unit = (Kotlin.Unit) site[0];
                int i = (Integer) site[1];
                if (uniqueName(callable) && namesClassOf(unit, callable)) {
                    List<List<Kotlin.Token>> arguments = Kotlin.arguments(unit.tokens, i + 1);
                    if (arguments.size() == arity && index < arguments.size()) {
                        out.addAll(kotlinValues(unit, arguments.get(index), depth + 1));
                    }
                }
            }
            if (referenced(callable)) {
                // Passed as a method reference: its arguments come from whoever calls the reference.
                out.texts.add(Text.UNKNOWN);
            }
        }
        return out.texts.isEmpty() && out.resources.isEmpty() ? Values.unknown() : out;
    }

    private List<ExplicitConstructorInvocationStmt> constructorInvocations;

    private List<ExplicitConstructorInvocationStmt> allConstructorInvocations() {
        if (constructorInvocations == null) {
            constructorInvocations = new ArrayList<>();
            for (Code.Unit unit : code.units) {
                constructorInvocations.addAll(unit.tree.findAll(ExplicitConstructorInvocationStmt.class));
            }
        }
        return constructorInvocations;
    }

    private boolean referenced(CallableDeclaration<?> callable) {
        if (referencedNames == null) {
            referencedNames = new HashSet<>();
            for (Code.Unit unit : code.units) {
                for (MethodReferenceExpr reference : unit.tree.findAll(MethodReferenceExpr.class)) {
                    referencedNames.add(reference.getIdentifier());
                }
            }
        }
        return referencedNames.contains(callable.getNameAsString());
    }

    /** Whether a Kotlin file names the method's class or one of its subclasses, as any file that can call it does. */
    private boolean namesClassOf(Kotlin.Unit unit, CallableDeclaration<?> callable) {
        TypeDeclaration<?> owner = Code.typeOf(callable);
        Set<String> names = kotlinNames.get(unit);
        if (owner == null || names == null) {
            return false;
        }
        if (names.contains(owner.getNameAsString())) {
            return true;
        }
        for (TypeDeclaration<?> sub : descendants(owner)) {
            if (names.contains(sub.getNameAsString())) {
                return true;
            }
        }
        return false;
    }

    /** Whether every Java method of the name and arity sits in one class hierarchy (so a Kotlin call by name is one of them). */
    private boolean uniqueName(CallableDeclaration<?> callable) {
        TypeDeclaration<?> owner = Code.typeOf(callable);
        for (CallableDeclaration<?> other : callablesByName.getOrDefault(callable.getNameAsString(), List.of())) {
            if (other.getParameters().size() == callable.getParameters().size()) {
                TypeDeclaration<?> type = Code.typeOf(other);
                if (type != owner && !related(type, owner)) {
                    return false;
                }
            }
        }
        return true;
    }

    // -- call targets -----------------------------------------------------------------------

    /**
     * The methods a call can run: on its receiver's class (its declared type, or the class the call
     * is in for a call with no receiver or `this`), the classes and interfaces it extends, and every
     * override in a subclass; a static call on a class names that class. Null when the receiver's
     * class cannot be read and more than one class hierarchy declares such a method.
     */
    private final Map<MethodCallExpr, Object> targetsOf = new IdentityHashMap<>();
    private final Map<Expression, Object> typesOf = new IdentityHashMap<>();
    private static final Object NONE = new Object();
    /** The Kotlin keywords whose next name is declared, not called. */
    private static final Set<String> DECLARES = Set.of("fun", "class", "interface", "object");

    @SuppressWarnings("unchecked")
    private List<CallableDeclaration<?>> targets(MethodCallExpr call) {
        Object known = targetsOf.get(call);
        if (known != null) {
            return known == NONE ? null : (List<CallableDeclaration<?>>) known;
        }
        // A call reached again while its own targets are read (a receiver that is a call of itself).
        targetsOf.put(call, NONE);
        List<CallableDeclaration<?>> found = findTargets(call);
        targetsOf.put(call, found == null ? NONE : found);
        return found;
    }

    private List<CallableDeclaration<?>> findTargets(MethodCallExpr call) {
        String name = call.getNameAsString();
        int arity = call.getArguments().size();
        TypeDeclaration<?> receiver;
        if (!call.getScope().isPresent() || call.getScope().get() instanceof ThisExpr) {
            receiver = Code.typeOf(call);
        } else if (call.getScope().get() instanceof SuperExpr) {
            TypeDeclaration<?> at = Code.typeOf(call);
            receiver = at == null || Code.superName(at) == null ? null : resolve(Code.superName(at), at);
        } else {
            receiver = typeOf(call.getScope().get());
        }
        if (receiver != null) {
            List<CallableDeclaration<?>> found = new ArrayList<>();
            for (TypeDeclaration<?> type : ancestors(receiver)) {
                for (CallableDeclaration<?> candidate : declared(type, name)) {
                    if (fits(candidate, arity)) {
                        found.add(candidate);
                    }
                }
            }
            if (!found.isEmpty()) {
                for (TypeDeclaration<?> sub : descendants(receiver)) {
                    for (CallableDeclaration<?> candidate : declared(sub, name)) {
                        if (fits(candidate, arity) && same(found, candidate) < 0) {
                            found.add(candidate);
                        }
                    }
                }
                return found;
            }
            if (call.getScope().isPresent() && !(call.getScope().get() instanceof ThisExpr)) {
                // A receiver of a class outside the read sources (a library's): none of ours.
                return List.of();
            }
        }
        // The receiver's class is unread: every method of the name, when they share one hierarchy.
        List<CallableDeclaration<?>> found = new ArrayList<>();
        TypeDeclaration<?> first = null;
        for (CallableDeclaration<?> candidate : callablesByName.getOrDefault(name, List.of())) {
            if (candidate instanceof MethodDeclaration && fits(candidate, arity)) {
                TypeDeclaration<?> type = Code.typeOf(candidate);
                if (first == null) {
                    first = type;
                } else if (type != first && !related(type, first)) {
                    return null;
                }
                found.add(candidate);
            }
        }
        return found;
    }

    private static boolean fits(CallableDeclaration<?> candidate, int arity) {
        int declared = candidate.getParameters().size();
        if (declared == arity) {
            return true;
        }
        return declared > 0 && candidate.getParameter(declared - 1).isVarArgs() && arity >= declared - 1;
    }

    private static List<CallableDeclaration<?>> declared(TypeDeclaration<?> type, String name) {
        List<CallableDeclaration<?>> out = new ArrayList<>();
        for (com.github.javaparser.ast.body.BodyDeclaration<?> member : type.getMembers()) {
            if (member instanceof MethodDeclaration && ((MethodDeclaration) member).getNameAsString().equals(name)) {
                out.add((MethodDeclaration) member);
            }
        }
        return out;
    }

    /** The type, every class and interface it extends or implements, and the types it is nested in. */
    private List<TypeDeclaration<?>> ancestors(TypeDeclaration<?> type) {
        List<TypeDeclaration<?>> cached = ancestorsOf.get(type);
        if (cached != null) {
            return cached;
        }
        List<TypeDeclaration<?>> out = new ArrayList<>();
        List<TypeDeclaration<?>> queue = new ArrayList<>(List.of(type));
        while (!queue.isEmpty()) {
            TypeDeclaration<?> current = queue.remove(0);
            if (current == null || same(out, current) >= 0) {
                continue;
            }
            out.add(current);
            List<ClassOrInterfaceType> parents = new ArrayList<>();
            if (current instanceof ClassOrInterfaceDeclaration) {
                parents.addAll(((ClassOrInterfaceDeclaration) current).getExtendedTypes());
                parents.addAll(((ClassOrInterfaceDeclaration) current).getImplementedTypes());
            } else if (current instanceof EnumDeclaration) {
                parents.addAll(((EnumDeclaration) current).getImplementedTypes());
            }
            for (ClassOrInterfaceType parent : parents) {
                TypeDeclaration<?> resolvedParent = resolve(parent.getNameAsString(), current);
                if (resolvedParent != null) {
                    queue.add(resolvedParent);
                } else {
                    // A Kotlin class between Java ones (`BaseDrawerActivity`): the Java types it extends.
                    queue.addAll(throughKotlin(parent.getNameAsString(), new HashSet<>()));
                }
            }
            Node outer = current.getParentNode().orElse(null);
            while (outer != null && !(outer instanceof TypeDeclaration)) {
                outer = outer.getParentNode().orElse(null);
            }
            if (outer != null) {
                queue.add((TypeDeclaration<?>) outer);
            }
        }
        ancestorsOf.put(type, out);
        return out;
    }

    /** The Java types a Kotlin class of this name extends, through any Kotlin classes between them. */
    private List<TypeDeclaration<?>> throughKotlin(String name, Set<String> seen) {
        List<TypeDeclaration<?>> out = new ArrayList<>();
        if (!seen.add(name)) {
            return out;
        }
        for (Object[] declared : kotlinClasses.getOrDefault(name, List.of())) {
            @SuppressWarnings("unchecked")
            List<String> parents = (List<String>) declared[1];
            for (String parent : parents) {
                TypeDeclaration<?> java = resolveKotlin((Kotlin.Unit) declared[0], parent);
                if (java != null) {
                    out.add(java);
                } else {
                    out.addAll(throughKotlin(parent, seen));
                }
            }
        }
        return out;
    }

    /** Every type that extends or implements the type, directly or not. */
    private List<TypeDeclaration<?>> descendants(TypeDeclaration<?> type) {
        List<TypeDeclaration<?>> cached = descendantsOf.get(type);
        if (cached != null) {
            return cached;
        }
        List<TypeDeclaration<?>> out = new ArrayList<>();
        // By name, so a Kotlin class between two Java ones passes its Java subclasses on.
        List<String> names = new ArrayList<>(List.of(type.getNameAsString()));
        Set<String> seen = new HashSet<>();
        while (!names.isEmpty()) {
            String name = names.remove(0);
            if (!seen.add(name)) {
                continue;
            }
            for (TypeDeclaration<?> sub : subtypes.getOrDefault(name, List.of())) {
                if (same(out, sub) < 0) {
                    out.add(sub);
                }
                names.add(sub.getNameAsString());
            }
            names.addAll(kotlinChildren.getOrDefault(name, List.of()));
        }
        descendantsOf.put(type, out);
        return out;
    }

    private boolean related(TypeDeclaration<?> a, TypeDeclaration<?> b) {
        return a != null && b != null && (same(ancestors(a), b) >= 0 || same(ancestors(b), a) >= 0);
    }

    /**
     * The index of `node` itself in `nodes`, or -1. JavaParser's `equals` compares nodes by their
     * structure, so two methods written alike in different classes are equal; identity tells them apart.
     */
    private static int same(List<? extends Node> nodes, Node node) {
        for (int i = 0; i < nodes.size(); i++) {
            if (nodes.get(i) == node) {
                return i;
            }
        }
        return -1;
    }

    /** The class an expression's value has, where its declaration names one the sources hold. */
    private TypeDeclaration<?> typeOf(Expression expression) {
        Object known = typesOf.get(expression);
        if (known != null) {
            return known == NONE ? null : (TypeDeclaration<?>) known;
        }
        typesOf.put(expression, NONE);
        TypeDeclaration<?> found = findType(expression);
        typesOf.put(expression, found == null ? NONE : found);
        return found;
    }

    private TypeDeclaration<?> findType(Expression expression) {
        Expression inner = expression;
        while (inner instanceof EnclosedExpr) {
            inner = ((EnclosedExpr) inner).getInner();
        }
        if (inner instanceof CastExpr) {
            return typeNamed(((CastExpr) inner).getType());
        }
        if (inner instanceof ThisExpr) {
            return Code.typeOf(inner);
        }
        if (inner instanceof ObjectCreationExpr) {
            return resolve(((ObjectCreationExpr) inner).getType().getNameAsString(), inner);
        }
        if (inner instanceof NameExpr) {
            String name = ((NameExpr) inner).getNameAsString();
            Object declared = local(name, inner);
            if (declared instanceof Parameter) {
                return typeNamed(((Parameter) declared).getType());
            }
            if (declared instanceof VariableDeclarator) {
                return typeNamed(((VariableDeclarator) declared).getType());
            }
            VariableDeclarator field = code.field(Code.typeOf(inner), name);
            if (field != null) {
                return typeNamed(field.getType());
            }
            // A class named directly (a static call's receiver).
            return resolve(name, inner);
        }
        if (inner instanceof FieldAccessExpr) {
            FieldAccessExpr access = (FieldAccessExpr) inner;
            TypeDeclaration<?> owner = access.getScope() instanceof ThisExpr ? Code.typeOf(inner) : typeOf(access.getScope());
            VariableDeclarator field = owner == null ? null : code.field(owner, access.getNameAsString());
            if (field != null) {
                return typeNamed(field.getType());
            }
            if (owner instanceof EnumDeclaration && ((EnumDeclaration) owner).getEntries().stream()
                    .anyMatch(entry -> entry.getNameAsString().equals(access.getNameAsString()))) {
                // An enum constant is a value of its enum.
                return owner;
            }
            return resolve(access.toString(), inner);
        }
        if (inner instanceof ArrayAccessExpr) {
            return typeOf(((ArrayAccessExpr) inner).getName());
        }
        if (inner instanceof MethodCallExpr) {
            List<CallableDeclaration<?>> targets = targets((MethodCallExpr) inner);
            TypeDeclaration<?> found = null;
            for (CallableDeclaration<?> target : targets == null ? List.<CallableDeclaration<?>>of() : targets) {
                if (target instanceof MethodDeclaration) {
                    TypeDeclaration<?> returned = typeNamed(((MethodDeclaration) target).getType());
                    if (found != null && returned != found) {
                        return null;
                    }
                    found = returned;
                }
            }
            return found;
        }
        return null;
    }

    private TypeDeclaration<?> typeNamed(Type type) {
        Type element = type;
        while (element.isArrayType()) {
            element = element.asArrayType().getComponentType();
        }
        return element.isClassOrInterfaceType() ? resolve(element.asClassOrInterfaceType().getNameAsString(), type) : null;
    }

    /**
     * The type a simple (or dotted) name stands for where `at` is, as Java resolves it: a type its
     * file declares, a single-type import, its package, an on-demand import. A name that resolves to
     * a class outside the read sources (`android.util.Pair`, `java.lang.String`) is null, never a
     * read class of the same simple name.
     */
    private final Map<com.github.javaparser.ast.CompilationUnit, Map<String, Object>> resolved = new IdentityHashMap<>();

    private TypeDeclaration<?> resolve(String name, Node at) {
        if (name == null) {
            return null;
        }
        com.github.javaparser.ast.CompilationUnit file = at.findCompilationUnit().orElse(null);
        if (file == null) {
            return null;
        }
        Map<String, Object> cache = resolved.computeIfAbsent(file, k -> new HashMap<>());
        Object known = cache.get(name);
        if (known != null) {
            return known == NONE ? null : (TypeDeclaration<?>) known;
        }
        TypeDeclaration<?> found = resolveIn(name, at);
        cache.put(name, found == null ? NONE : found);
        return found;
    }

    private TypeDeclaration<?> resolveIn(String name, Node at) {
        TypeDeclaration<?> qualified = byQualifiedName.get(name);
        if (qualified != null) {
            return qualified;
        }
        String simple = name.substring(name.lastIndexOf('.') + 1);
        com.github.javaparser.ast.CompilationUnit unit = at.findCompilationUnit().orElse(null);
        if (unit == null) {
            return null;
        }
        if (name.contains(".")) {
            // `Outer.Inner`: the outer type, then its member.
            TypeDeclaration<?> outer = resolve(name.substring(0, name.lastIndexOf('.')), at);
            if (outer != null) {
                for (TypeDeclaration<?> inner : outer.findAll(TypeDeclaration.class)) {
                    if (inner != outer && inner.getNameAsString().equals(simple)) {
                        return inner;
                    }
                }
            }
            return null;
        }
        for (TypeDeclaration<?> declared : unit.findAll(TypeDeclaration.class)) {
            if (declared.getNameAsString().equals(simple)) {
                return declared;
            }
        }
        for (com.github.javaparser.ast.ImportDeclaration imported : unit.getImports()) {
            if (!imported.isStatic() && !imported.isAsterisk() && imported.getName().getIdentifier().equals(simple)) {
                return byQualifiedName.get(imported.getNameAsString());
            }
        }
        String pkg = unit.getPackageDeclaration().map(p -> p.getNameAsString() + ".").orElse("");
        TypeDeclaration<?> sibling = byQualifiedName.get(pkg + simple);
        if (sibling != null) {
            return sibling;
        }
        for (com.github.javaparser.ast.ImportDeclaration imported : unit.getImports()) {
            if (!imported.isStatic() && imported.isAsterisk()) {
                TypeDeclaration<?> found = byQualifiedName.get(imported.getNameAsString() + "." + simple);
                if (found != null) {
                    return found;
                }
            }
        }
        return null;
    }

    /** The Java type a Kotlin file names `simple`: through its imports, else in its own package. */
    private TypeDeclaration<?> resolveKotlin(Kotlin.Unit unit, String simple) {
        List<Kotlin.Token> tokens = unit.tokens;
        String pkg = "";
        for (int i = 0; i + 1 < tokens.size(); i++) {
            boolean importing = tokens.get(i).is("import");
            if (!importing && !tokens.get(i).is("package")) {
                continue;
            }
            StringBuilder dotted = new StringBuilder(tokens.get(i + 1).text);
            int j = i + 2;
            while (j + 1 < tokens.size() && tokens.get(j).is(".") && tokens.get(j + 1).kind == Kotlin.Kind.IDENT) {
                dotted.append('.').append(tokens.get(j + 1).text);
                j += 2;
            }
            String name = dotted.toString();
            if (!importing) {
                pkg = name + ".";
            } else if (name.endsWith("." + simple)) {
                return byQualifiedName.get(name);
            }
        }
        return byQualifiedName.get(pkg + simple);
    }

    // -- scopes -----------------------------------------------------------------------------

    /** The parameter or local `name` is where `at` stands, or null when it is not one (a field). */
    private static Object local(String name, Node at) {
        Node current = at.getParentNode().orElse(null);
        while (current != null && !(current instanceof TypeDeclaration)) {
            if (current instanceof CallableDeclaration || current instanceof LambdaExpr) {
                Object declared = declaredIn(current).get(name);
                if (declared != null) {
                    return declared;
                }
                if (current instanceof CallableDeclaration) {
                    return null;
                }
            }
            if (current instanceof com.github.javaparser.ast.stmt.CatchClause
                    && ((com.github.javaparser.ast.stmt.CatchClause) current).getParameter().getNameAsString().equals(name)) {
                return ((com.github.javaparser.ast.stmt.CatchClause) current).getParameter();
            }
            current = current.getParentNode().orElse(null);
        }
        return null;
    }

    /** The parameters, then the locals, a method, constructor or lambda declares itself (not its nested lambdas'). */
    private static Map<String, Object> declaredIn(Node callable) {
        Map<String, Object> known = DECLARED.get(callable);
        if (known != null) {
            return known;
        }
        Map<String, Object> out = new HashMap<>();
        for (VariableDeclarator local : callable.findAll(VariableDeclarator.class)) {
            if (!(local.getParentNode().orElse(null) instanceof FieldDeclaration) && enclosingCallable(local) == callable) {
                out.putIfAbsent(local.getNameAsString(), local);
            }
        }
        List<Parameter> parameters = callable instanceof CallableDeclaration
                ? ((CallableDeclaration<?>) callable).getParameters() : ((LambdaExpr) callable).getParameters();
        for (Parameter parameter : parameters) {
            out.put(parameter.getNameAsString(), parameter);
        }
        DECLARED.put(callable, out);
        return out;
    }

    private static Node enclosingCallable(Node node) {
        Node current = node.getParentNode().orElse(null);
        while (current != null && !(current instanceof CallableDeclaration) && !(current instanceof LambdaExpr)
                && !(current instanceof TypeDeclaration)) {
            current = current.getParentNode().orElse(null);
        }
        return current instanceof TypeDeclaration ? null : current;
    }

    private static boolean within(Node node, Node ancestor) {
        Node current = node;
        while (current != null) {
            if (current == ancestor) {
                return true;
            }
            current = current.getParentNode().orElse(null);
        }
        return false;
    }

    // -- Kotlin values ----------------------------------------------------------------------

    /**
     * A Kotlin argument's values: a string (a template's literal start and end around what it
     * interpolates), a `const val` of the file, a `+` of parts, and `<name>.<property>` on a value
     * the file declares `<name>: <JavaClass>`, read as the Java class's getter or field.
     */
    private Values kotlinValues(Kotlin.Unit unit, List<Kotlin.Token> argument, int depth) {
        List<List<Kotlin.Token>> parts = new ArrayList<>();
        List<Kotlin.Token> part = new ArrayList<>();
        int nesting = 0;
        for (Kotlin.Token token : argument) {
            if (token.is("(") || token.is("[") || token.is("{")) {
                nesting++;
            } else if (token.is(")") || token.is("]") || token.is("}")) {
                nesting--;
            }
            if (nesting == 0 && token.is("+")) {
                parts.add(part);
                part = new ArrayList<>();
            } else {
                part.add(token);
            }
        }
        parts.add(part);
        Values joined = null;
        for (List<Kotlin.Token> one : parts) {
            Values value = kotlinPart(unit, one, depth);
            joined = joined == null ? value : concatenated(joined, value);
        }
        return joined == null ? Values.unknown() : joined;
    }

    private Values kotlinPart(Kotlin.Unit unit, List<Kotlin.Token> tokens, int depth) {
        Values out = new Values();
        String at = tokens.isEmpty() ? null : Kotlin.where(unit, unit.tokens.indexOf(tokens.get(0)));
        if (tokens.size() == 1 && tokens.get(0).kind == Kotlin.Kind.STRING) {
            Kotlin.Token string = tokens.get(0);
            if (string.text != null) {
                out.add(Text.exact(string.text), at);
            } else {
                List<String> literals = string.parts;
                out.add(new Text(literals.get(0), literals.get(literals.size() - 1), false), at);
            }
            return out;
        }
        if (tokens.size() == 1 && tokens.get(0).kind == Kotlin.Kind.IDENT) {
            String constant = Kotlin.constant(unit, tokens.get(0).text);
            if (constant != null) {
                out.add(Text.exact(constant), at);
                return out;
            }
        }
        if (tokens.size() == 3 && tokens.get(0).kind == Kotlin.Kind.IDENT && tokens.get(1).is(".")
                && tokens.get(2).kind == Kotlin.Kind.IDENT) {
            String declared = Kotlin.declaredType(unit, tokens.get(0).text, unit.tokens.indexOf(tokens.get(0)));
            TypeDeclaration<?> type = declared == null ? null : resolveKotlin(unit, declared);
            if (type != null) {
                String property = tokens.get(2).text;
                String getter = "get" + Character.toUpperCase(property.charAt(0)) + property.substring(1);
                for (TypeDeclaration<?> owner : ancestors(type)) {
                    for (CallableDeclaration<?> method : declared(owner, getter)) {
                        if (method.getParameters().isEmpty() && method instanceof MethodDeclaration
                                && ((MethodDeclaration) method).getBody().isPresent()) {
                            for (ReturnStmt returned : method.findAll(ReturnStmt.class)) {
                                returned.getExpression().ifPresent(e -> out.addAll(values(e, depth + 1)));
                            }
                        }
                    }
                }
                if (out.texts.isEmpty()) {
                    VariableDeclarator field = code.field(type, property);
                    if (field != null) {
                        out.addAll(fieldValues(field, depth + 1));
                    }
                }
                if (!out.texts.isEmpty()) {
                    return out;
                }
            }
        }
        return Values.unknown();
    }
}
