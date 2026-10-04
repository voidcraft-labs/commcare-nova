package nova.proof.surface;

import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The surface extractor's Java families (proof/surface/families/runtime.py, xforms.py,
 * evaluation.py, search.py, strings.py), each printed as one JSON document on standard output.
 * `wide` reads Core's and Android's whole Java once for the families that read across them (itext
 * forms, function handlers, search prompts, UI strings).
 *
 *   java nova.proof.surface.Main javarosa <core> <android>
 *   java nova.proof.surface.Main parsers <core> <android>
 *   java nova.proof.surface.Main appearances <core> <android>
 *   java nova.proof.surface.Main xforms <core> <android>
 *   java nova.proof.surface.Main wide <core> <android>
 *   java nova.proof.surface.Main session <core> <android>
 *   java nova.proof.surface.Main instance-sources <core> <android>
 *   java nova.proof.surface.Main xpath-grammar <core> <android>
 *   java nova.proof.surface.Main parse-functions <core> <android> <name>...
 *   java nova.proof.surface.Main probe <core> <android> <probe> <argument>...
 *   java nova.proof.surface.Main batch <core> <android> <command>...
 *
 * `batch` runs several of the families' commands in one JVM, in the order named, and prints one
 * JSON object holding each command's document under its name. Every file they read is parsed
 * once per JVM (Code.load), so families that read the same sources (Core's and Android's whole
 * Java, for `wide`, `parsers` and `appearances`) share one parse; a command that changed a tree
 * it reads fails (Code.UNCHANGED), so each document is the one the command prints alone.
 *
 * `parse-functions` is not a family: for each name it asks Core's own XPath parser which class it
 * builds for a call (trying zero to eight arguments), and reads by reflection the class's
 * `EXPECTED_ARG_COUNT` and whether it declares its own `validateArgCount`: the runtime reading the
 * surface's tests hold the `jr-fn` family against. `probe` is not a family either: it runs Core's
 * compiled classes for the readings the other families' tests compare with (Probes).
 * `<core>` and `<android>` are checkout roots; the files each family reads are named here,
 * relative to them.
 */
public final class Main {
    private Main() {
    }

    public static void main(String[] args) {
        // Core prints to standard output while its classes initialise; the document goes to the
        // real standard output only.
        PrintStream out = new PrintStream(new java.io.FileOutputStream(java.io.FileDescriptor.out), true,
                StandardCharsets.UTF_8);
        System.setOut(new PrintStream(new java.io.ByteArrayOutputStream(), true, StandardCharsets.UTF_8));
        int status = 0;
        try {
            out.println(Json.write(document(args)));
            out.flush();
        } catch (Throwable failed) {
            failed.printStackTrace();
            status = 1;
        }
        // Core's CacheTable starts a non-daemon thread; the program ends here, with its document or its failure.
        System.exit(status);
    }

    private static Object document(String[] args) throws Exception {
        String command = args[0];
        Path core = Path.of(args[1]);
        Path android = Path.of(args[2]);
        if (!command.equals("batch")) {
            return run(command, core, android, args);
        }
        Map<String, Object> results = new LinkedHashMap<>();
        for (int i = 3; i < args.length; i++) {
            if (args[i].equals("probe") || args[i].equals("parse-functions") || args[i].equals("batch")) {
                throw new IllegalArgumentException("batch runs the families' commands, and " + args[i]
                        + " is not one of them");
            }
            try {
                results.put(args[i], run(args[i], core, android, args));
            } catch (Exception failed) {
                throw new IllegalStateException("The batch's " + args[i] + " command failed: "
                        + failed.getMessage(), failed);
            }
        }
        return results;
    }

    /** One command's document; `args` are the program's, read from the fourth on by `probe` and `parse-functions`. */
    private static Object run(String command, Path core, Path android, String[] args) throws Exception {
        Object result;
        switch (command) {
            case "javarosa": {
                Code code = Code.load(List.of(
                        new Code.Root("commcare-core", core, "core",
                                "src/main/java/org/javarosa/xpath/parser/ast",
                                "src/main/java/org/javarosa/xform/parse",
                                "src/main/java/org/javarosa/core/model"),
                        new Code.Root("commcare-android", android, "android",
                                "app/src/org/commcare/android/resource/installers",
                                "app/src/org/commcare/android/javarosa",
                                "app/src/org/commcare/engine/extensions")));
                Map<String, Object> read = JavaRosa.read(code);
                List<Map<String, Object>> extensions = new ArrayList<>();
                for (Object registration : (List<?>) read.get("android")) {
                    @SuppressWarnings("unchecked")
                    Map<String, Object> registered = (Map<String, Object>) registration;
                    Object value = registered.get("value");
                    if (value instanceof String && code.type((String) value) != null) {
                        extensions.add(registered);
                    }
                }
                read.put("extensionParsers", JavaRosa.extensionParsers(code, extensions));
                result = read;
                break;
            }
            case "parsers": {
                Code code = Code.load(List.of(
                        new Code.Root("commcare-core", core, "core",
                                "src/main/java/org/commcare/xml",
                                "src/main/java/org/commcare/data/xml",
                                "src/main/java/org/javarosa/xml",
                                "src/main/java/org/commcare/resources/model/installers"),
                        new Code.Root("commcare-android", android, "android",
                                "app/src/org/commcare/xml",
                                "app/src/org/commcare/android/resource/installers")));
                Map<String, Object> read = Parsers.read(code, List.of("installers"));
                // Where each attribute's value goes, over Core's and Android's whole Java (ParserValues); Core's
                // command-line runner where the checkout holds it (a test's planted copy holds the parsers alone).
                List<String> coreJava = new ArrayList<>(List.of("src/main/java"));
                if (java.nio.file.Files.isDirectory(core.resolve("src/cli/java"))) {
                    coreJava.add("src/cli/java");
                }
                Code whole = Code.load(List.of(
                        new Code.Root("commcare-core", core, "core", coreJava.toArray(new String[0])),
                        new Code.Root("commcare-android", android, "android", "app/src")));
                @SuppressWarnings("unchecked")
                List<Map<String, Object>> reads = (List<Map<String, Object>>) read.remove("reads");
                read.put("values", ParserValues.read(whole, reads));
                result = Parsers.plain(read);
                break;
            }
            case "appearances": {
                Code code = Code.load(List.of(
                        new Code.Root("commcare-core", core, "core", "src/main/java/org/javarosa/form/api"),
                        new Code.Root("commcare-android", android, "android", "app/src")));
                Map<String, Object> read = new LinkedHashMap<>();
                read.put("reads", Appearances.read(code));
                result = read;
                break;
            }
            case "xforms": {
                Code code = Code.load(List.of(
                        new Code.Root("commcare-core", core, "core",
                                "src/main/java/org/javarosa/xform",
                                "src/main/java/org/javarosa/core/model"),
                        new Code.Root("commcare-android", android, "android",
                                "app/src/org/commcare/android/resource/installers",
                                "app/src/org/commcare/android/javarosa",
                                "app/src/org/commcare/engine/extensions")));
                result = XForms.read(code, JavaRosa.androidRegistrations(code));
                break;
            }
            case "wide": {
                // One load of Core's and Android's whole Java for the families that read across them.
                Code code = Code.load(List.of(
                        new Code.Root("commcare-core", core, "core", "src/main/java", "src/cli/java"),
                        new Code.Root("commcare-android", android, "android", "app/src")));
                List<Kotlin.Unit> kotlin = Kotlin.load("commcare-android", android, "android", "app/src");
                Map<String, Object> read = new LinkedHashMap<>();
                read.put("itextForms", Runtimes.itextForms(code));
                read.put("functionHandlers", Runtimes.functionHandlers(code, kotlin));
                read.put("prompts", Runtimes.prompts(code, kotlin));
                read.put("uiStrings", UiStrings.read(code, kotlin, android));
                result = read;
                break;
            }
            case "session": {
                Code code = Code.load(List.of(
                        new Code.Root("commcare-core", core, "core", "src/main/java/org/commcare/session")));
                result = Runtimes.sessionInstance(code);
                break;
            }
            case "instance-sources": {
                Code code = Code.load(List.of(
                        new Code.Root("commcare-core", core, "core",
                                "src/main/java/org/commcare/core/process",
                                "src/main/java/org/commcare/cases/instance",
                                "src/main/java/org/javarosa/core/model/instance",
                                "src/cli/java/org/commcare/util/mocks"),
                        new Code.Root("commcare-android", android, "android", "app/src/org/commcare/utils")));
                result = Runtimes.instanceSources(code);
                break;
            }
            case "xpath-grammar": {
                Code code = Code.load(List.of(
                        new Code.Root("commcare-core", core, "core", "src/main/java/org/javarosa/xpath")));
                result = Runtimes.xpathGrammar(code);
                break;
            }
            case "probe": {
                result = Probes.run(args[3], args, 4);
                break;
            }
            case "parse-functions": {
                Map<String, Object> built = new java.util.TreeMap<>();
                for (int i = 3; i < args.length; i++) {
                    String name = args[i];
                    String found = null;
                    for (int count = 0; count <= 8 && found == null; count++) {
                        String call = name + "(" + String.join(",", java.util.Collections.nCopies(count, "1")) + ")";
                        try {
                            found = org.javarosa.xpath.XPathParseTool.parseXPath(call).getClass().getSimpleName();
                        } catch (Exception refused) {
                            // Core refuses the call at this arity; the next count may be the function's.
                        }
                    }
                    Map<String, Object> facts = new LinkedHashMap<>();
                    facts.put("class", found);
                    if (found != null) {
                        Class<?> function = Class.forName("org.javarosa.xpath.expr." + found);
                        java.lang.reflect.Field count = null;
                        for (Class<?> c = function; c != null && count == null; c = c.getSuperclass()) {
                            try {
                                count = c.getDeclaredField("EXPECTED_ARG_COUNT");
                            } catch (NoSuchFieldException absent) {
                                // The field is declared further up, or not at all.
                            }
                        }
                        if (count != null) {
                            count.setAccessible(true);
                        }
                        facts.put("expectedArgCount", count == null ? null : count.getInt(null));
                        boolean own;
                        try {
                            function.getDeclaredMethod("validateArgCount");
                            own = true;
                        } catch (NoSuchMethodException inherited) {
                            own = false;
                        }
                        facts.put("validatesOwnArgCount", own);
                    }
                    built.put(name, facts);
                }
                result = built;
                break;
            }
            default:
                throw new IllegalArgumentException("unknown command " + command);
        }
        return result;
    }
}
