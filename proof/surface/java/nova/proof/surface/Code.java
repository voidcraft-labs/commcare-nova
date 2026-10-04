package nova.proof.surface;

import com.github.javaparser.JavaParser;
import com.github.javaparser.ParseResult;
import com.github.javaparser.ParserConfiguration;
import com.github.javaparser.ast.CompilationUnit;
import com.github.javaparser.ast.Node;
import com.github.javaparser.ast.NodeList;
import com.github.javaparser.ast.body.BodyDeclaration;
import com.github.javaparser.ast.body.CallableDeclaration;
import com.github.javaparser.ast.body.ClassOrInterfaceDeclaration;
import com.github.javaparser.ast.body.ConstructorDeclaration;
import com.github.javaparser.ast.body.FieldDeclaration;
import com.github.javaparser.ast.body.MethodDeclaration;
import com.github.javaparser.ast.body.TypeDeclaration;
import com.github.javaparser.ast.body.VariableDeclarator;
import com.github.javaparser.ast.expr.BinaryExpr;
import com.github.javaparser.ast.expr.CharLiteralExpr;
import com.github.javaparser.ast.expr.EnclosedExpr;
import com.github.javaparser.ast.expr.Expression;
import com.github.javaparser.ast.expr.FieldAccessExpr;
import com.github.javaparser.ast.expr.NameExpr;
import com.github.javaparser.ast.expr.StringLiteralExpr;
import com.github.javaparser.ast.observer.AstObserver;
import com.github.javaparser.ast.observer.ObservableProperty;
import com.github.javaparser.ast.type.ClassOrInterfaceType;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.stream.Collectors;
import java.util.stream.Stream;

/**
 * Java sources parsed with JavaParser, indexed by type name, with string constants resolved
 * across files (a field's literal initialiser, `Class.FIELD`, and `+` joins of either).
 */
final class Code {
    /** One source file: where it is, which repository and platform it belongs to, and its tree. */
    static final class Unit {
        final Path path;
        final String relative;
        final String platform;
        final CompilationUnit tree;

        Unit(Path path, String relative, String platform, CompilationUnit tree) {
            this.path = path;
            this.relative = relative;
            this.platform = platform;
            this.tree = tree;
        }
    }

    /** A directory of sources: the repository it belongs to (for relative paths) and its platform. */
    static final class Root {
        final String repository;
        final Path base;
        final List<String> directories;
        final String platform;

        Root(String repository, Path base, String platform, String... directories) {
            this.repository = repository;
            this.base = base;
            this.platform = platform;
            this.directories = List.of(directories);
        }
    }

    final List<Unit> units = new ArrayList<>();
    final Map<String, List<TypeDeclaration<?>>> types = new LinkedHashMap<>();
    final Map<Node, Unit> unitOfType = new LinkedHashMap<>();

    /**
     * Each file's tree, parsed the first time a load in this JVM reads it: the commands of a batch
     * (Main) read the same files, so each tree is held UNCHANGED from its parse on.
     */
    private static final Map<Path, CompilationUnit> PARSED = new HashMap<>();

    /**
     * Refuses every change to a tree PARSED holds (a property set, a node added to, removed from or
     * replaced in a list, a node moved to another parent), before JavaParser applies it. Every
     * command of a batch reads the trees as parsed, whichever commands ran before it, and the
     * structural hashes (Structural) and the units by type (unitOf) kept for them hold only while
     * they are unchanged; a command that needs a changed tree changes its own copy (Node.clone()).
     */
    private static final AstObserver UNCHANGED = new AstObserver() {
        @Override
        public void propertyChange(Node observedNode, ObservableProperty property, Object oldValue, Object newValue) {
            refuse(observedNode, "set its " + property.camelCaseName());
        }

        @Override
        public void parentChange(Node observedNode, Node previousParent, Node newParent) {
            refuse(observedNode, "moved it to another parent");
        }

        @Override
        public void listChange(NodeList<?> observedNode, ListChangeType type, int index, Node nodeAddedOrRemoved) {
            refuse(observedNode.getParentNode().orElse(null), (type == ListChangeType.ADDITION ? "added " : "removed ")
                    + nodeAddedOrRemoved.getClass().getSimpleName() + " at " + index + " of one of its lists");
        }

        @Override
        public void listReplacement(NodeList<?> observedNode, int index, Node oldNode, Node newNode) {
            refuse(observedNode.getParentNode().orElse(null), "replaced " + oldNode.getClass().getSimpleName()
                    + " at " + index + " of one of its lists");
        }

        private void refuse(Node node, String change) {
            // Trees keep no tokens (load), so no node knows its line; the file and the node's kind name it.
            String where = node == null ? "a parsed file" : node.findCompilationUnit()
                    .flatMap(CompilationUnit::getStorage).map(storage -> storage.getPath().toString())
                    .orElse("a parsed file") + " (" + node.getClass().getSimpleName() + ")";
            throw new IllegalStateException("The surface helper changed the tree it parsed from " + where + ": it "
                    + change + ". Every command reads the trees Code.load parsed once in this JVM, so a change"
                    + " to one would reach every command that reads it after; change a copy (Node.clone()).");
        }
    };

    static Code load(List<Root> roots) throws IOException {
        // Tokens are not kept: nothing reads source text, and they would hold every file's text in memory.
        JavaParser parser = new JavaParser(new ParserConfiguration()
                .setLanguageLevel(ParserConfiguration.LanguageLevel.JAVA_17)
                .setStoreTokens(false));
        Code code = new Code();
        for (Root root : roots) {
            for (String directory : root.directories) {
                Path start = root.base.resolve(directory);
                if (!Files.exists(start)) {
                    throw new IllegalStateException("The surface extractor expected Java sources at " + directory
                            + " in " + root.repository + " and found none there.");
                }
                List<Path> files;
                try (Stream<Path> walk = Files.walk(start)) {
                    files = walk.filter(p -> p.toString().endsWith(".java")).sorted().collect(Collectors.toList());
                }
                for (Path file : files) {
                    Path key = file.toAbsolutePath().normalize();
                    CompilationUnit tree = PARSED.get(key);
                    if (tree == null) {
                        ParseResult<CompilationUnit> result = parser.parse(file);
                        if (!result.isSuccessful() || result.getResult().isEmpty()) {
                            throw new IllegalStateException("JavaParser could not parse " + file + ": "
                                    + result.getProblems());
                        }
                        tree = result.getResult().get();
                        tree.registerForSubtree(UNCHANGED);
                        PARSED.put(key, tree);
                    }
                    String relative = root.repository + "/" + root.base.relativize(file).toString().replace('\\', '/');
                    Unit unit = new Unit(file, relative, root.platform, tree);
                    code.units.add(unit);
                    for (TypeDeclaration<?> type : unit.tree.findAll(TypeDeclaration.class)) {
                        code.types.computeIfAbsent(type.getNameAsString(), k -> new ArrayList<>()).add(type);
                        code.unitOfType.put(type, unit);
                    }
                }
            }
        }
        return code;
    }

    /**
     * The unit of the nearest enclosing type unitOfType holds. Only a TypeDeclaration can equal one of
     * its keys (JavaParser's equality is structural and refuses nodes of different classes), so only
     * those ancestors are asked; and since a node's hash covers its whole subtree, each type's answer
     * is kept by identity (unitOfType does not change once the load is done, nor do the trees: UNCHANGED).
     */
    Unit unitOf(Node node) {
        Node current = node;
        while (current != null) {
            if (current instanceof TypeDeclaration) {
                Unit unit = unitOfTypeAsked(current);
                if (unit != null) {
                    return unit;
                }
            }
            current = current.getParentNode().orElse(null);
        }
        return null;
    }

    private final Map<Node, Optional<Unit>> unitOfTypeByIdentity = new IdentityHashMap<>();

    private Unit unitOfTypeAsked(Node type) {
        return unitOfTypeByIdentity.computeIfAbsent(type, asked -> Optional.ofNullable(unitOfType.get(asked)))
                .orElse(null);
    }

    /**
     * A node as JavaParser compares nodes (structurally), with the structural hash computed once per
     * node: the hash visits the node's whole subtree, and no tree changes once parsed (UNCHANGED).
     */
    private static final class Structural {
        private static final Map<Node, Integer> HASHES = new IdentityHashMap<>();
        final Node node;
        final int hash;

        Structural(Node node) {
            this.node = node;
            this.hash = HASHES.computeIfAbsent(node, Node::hashCode);
        }

        @Override
        public int hashCode() {
            return hash;
        }

        @Override
        public boolean equals(Object other) {
            return other instanceof Structural && node.equals(((Structural) other).node);
        }
    }

    static TypeDeclaration<?> typeOf(Node node) {
        Node current = node;
        while (current != null) {
            if (current instanceof TypeDeclaration) {
                return (TypeDeclaration<?>) current;
            }
            current = current.getParentNode().orElse(null);
        }
        return null;
    }

    /** `path::Type.member` for a node inside a callable, `path::Type` otherwise. */
    String where(Node node) {
        Unit unit = unitOf(node);
        TypeDeclaration<?> type = typeOf(node);
        String member = null;
        Node current = node;
        while (current != null && !(current instanceof TypeDeclaration)) {
            if (current instanceof MethodDeclaration) {
                member = ((MethodDeclaration) current).getNameAsString();
                break;
            }
            if (current instanceof ConstructorDeclaration) {
                member = "<init>";
                break;
            }
            current = current.getParentNode().orElse(null);
        }
        String name = type == null ? "?" : qualifiedName(type);
        return (unit == null ? "?" : unit.relative) + "::" + name + (member == null ? "" : "." + member);
    }

    static String qualifiedName(TypeDeclaration<?> type) {
        List<String> names = new ArrayList<>();
        Node current = type;
        while (current != null) {
            if (current instanceof TypeDeclaration) {
                names.add(0, ((TypeDeclaration<?>) current).getNameAsString());
            }
            current = current.getParentNode().orElse(null);
        }
        return String.join(".", names);
    }

    TypeDeclaration<?> type(String simpleName) {
        List<TypeDeclaration<?>> found = types.get(simpleName);
        return found == null || found.isEmpty() ? null : found.get(0);
    }

    /** The simple name of the class a type extends, if it names one. */
    static String superName(TypeDeclaration<?> type) {
        if (type instanceof ClassOrInterfaceDeclaration) {
            List<ClassOrInterfaceType> extended = ((ClassOrInterfaceDeclaration) type).getExtendedTypes();
            if (!extended.isEmpty()) {
                return extended.get(0).getNameAsString();
            }
        }
        return null;
    }

    /** The type, its enclosing types and the classes it extends that the index holds. */
    List<TypeDeclaration<?>> lookupChain(TypeDeclaration<?> type) {
        List<TypeDeclaration<?>> chain = new ArrayList<>();
        Set<Structural> seen = new HashSet<>();
        TypeDeclaration<?> current = type;
        while (current != null && seen.add(new Structural(current))) {
            chain.add(current);
            String parent = superName(current);
            current = parent == null ? null : type(parent);
        }
        Node outer = type.getParentNode().orElse(null);
        while (outer != null) {
            if (outer instanceof TypeDeclaration) {
                for (TypeDeclaration<?> t : lookupChain((TypeDeclaration<?>) outer)) {
                    if (!chain.contains(t)) {
                        chain.add(t);
                    }
                }
                break;
            }
            outer = outer.getParentNode().orElse(null);
        }
        return chain;
    }

    /** The declaration of the field `name` visible from `context`. */
    VariableDeclarator field(TypeDeclaration<?> context, String name) {
        if (context == null) {
            return null;
        }
        for (TypeDeclaration<?> type : lookupChain(context)) {
            for (BodyDeclaration<?> member : type.getMembers()) {
                if (member instanceof FieldDeclaration) {
                    for (VariableDeclarator variable : ((FieldDeclaration) member).getVariables()) {
                        if (variable.getNameAsString().equals(name)) {
                            return variable;
                        }
                    }
                }
            }
        }
        return null;
    }

    /** The string an expression always has, when it is a literal or a constant built from literals. */
    String constant(Expression expression, TypeDeclaration<?> context) {
        return constant(expression, context, new HashSet<>());
    }

    private String constant(Expression expression, TypeDeclaration<?> context, Set<Node> visiting) {
        if (expression == null) {
            return null;
        }
        if (expression instanceof StringLiteralExpr) {
            return ((StringLiteralExpr) expression).asString();
        }
        if (expression instanceof CharLiteralExpr) {
            return String.valueOf(((CharLiteralExpr) expression).asChar());
        }
        if (expression instanceof EnclosedExpr) {
            return constant(((EnclosedExpr) expression).getInner(), context, visiting);
        }
        if (expression instanceof BinaryExpr && ((BinaryExpr) expression).getOperator() == BinaryExpr.Operator.PLUS) {
            String left = constant(((BinaryExpr) expression).getLeft(), context, visiting);
            String right = constant(((BinaryExpr) expression).getRight(), context, visiting);
            return left == null || right == null ? null : left + right;
        }
        VariableDeclarator variable = null;
        if (expression instanceof NameExpr) {
            String name = ((NameExpr) expression).getNameAsString();
            variable = field(context, name);
            if (variable == null) {
                variable = staticImport(expression, name);
            }
        } else if (expression instanceof FieldAccessExpr) {
            FieldAccessExpr access = (FieldAccessExpr) expression;
            String owner = access.getScope().toString();
            owner = owner.substring(owner.lastIndexOf('.') + 1);
            variable = field(type(owner), access.getNameAsString());
        }
        if (variable == null || !variable.getInitializer().isPresent() || !visiting.add(variable)) {
            return null;
        }
        Optional<Node> declaration = variable.getParentNode();
        if (declaration.isPresent() && declaration.get() instanceof FieldDeclaration
                && !((FieldDeclaration) declaration.get()).isFinal()) {
            return null;
        }
        return constant(variable.getInitializer().get(), typeOf(variable), visiting);
    }

    /** The field a name reaches through its file's static imports (`import static X.NAME`, `import static X.*`). */
    VariableDeclarator staticImport(Node at, String name) {
        Optional<CompilationUnit> unit = at.findCompilationUnit();
        if (!unit.isPresent()) {
            return null;
        }
        for (com.github.javaparser.ast.ImportDeclaration imported : unit.get().getImports()) {
            if (!imported.isStatic()) {
                continue;
            }
            String full = imported.getNameAsString();
            String owner;
            if (imported.isAsterisk()) {
                owner = full.substring(full.lastIndexOf('.') + 1);
            } else if (full.endsWith("." + name)) {
                String prefix = full.substring(0, full.length() - name.length() - 1);
                owner = prefix.substring(prefix.lastIndexOf('.') + 1);
            } else {
                continue;
            }
            VariableDeclarator found = field(type(owner), name);
            if (found != null) {
                return found;
            }
        }
        return null;
    }

    /** Every method or constructor named `name` with `arity` parameters declared in the type's chain. */
    List<CallableDeclaration<?>> callables(TypeDeclaration<?> type, String name, int arity) {
        List<CallableDeclaration<?>> found = new ArrayList<>();
        if (type == null) {
            return found;
        }
        for (TypeDeclaration<?> candidate : lookupChain(type)) {
            for (BodyDeclaration<?> member : candidate.getMembers()) {
                if (member instanceof CallableDeclaration) {
                    CallableDeclaration<?> callable = (CallableDeclaration<?>) member;
                    boolean named = name == null ? callable instanceof ConstructorDeclaration
                            : callable instanceof MethodDeclaration && callable.getNameAsString().equals(name);
                    if (named && callable.getParameters().size() == arity) {
                        found.add(callable);
                    }
                }
            }
            if (name == null) {
                break;
            }
        }
        return found;
    }
}
