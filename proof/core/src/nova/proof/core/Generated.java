package nova.proof.core;

import org.javarosa.core.model.utils.DateUtils;
import org.javarosa.core.util.MathUtils;
import org.json.JSONArray;
import org.json.JSONObject;
import org.w3c.dom.Attr;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.NamedNodeMap;
import org.w3c.dom.Node;
import org.w3c.dom.NodeList;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.lang.reflect.Field;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Enumeration;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.Set;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

import javax.xml.parsers.DocumentBuilderFactory;

/**
 * The values Core's runtime generates rather than reads from its inputs, and
 * how a trace marks them.
 *
 * Randomness. Every random value an app's logic or Core's installer reaches
 * comes from MathUtils.getRand(): uuid() and uuid(n) (XPathUuidFunc), random()
 * (XPathRandomFunc), a profile's missing uniqueid (ProfileParser) and each
 * resource's record guid (Resource), through PropertyUtils.genUUID and genGUID.
 * MathUtils keeps that Random in a private static field it fills lazily with a
 * SecureRandom and offers no setter, so each run and each admission sets the
 * field to a Random with a fixed seed before it starts. The same run on the same
 * inputs then draws the same values. Core's two other random sources the runner
 * reaches are replaced where Core takes them as arguments: an archive's guid is
 * the app's handle (ArchiveFileRoot.addArchiveFile), and a multi-select's stored
 * selection is keyed by a counter (SessionOp.Selections) rather than
 * MemoryVirtualDataInstanceStorage's UUID.randomUUID.
 *
 * Time. Every clock read an app's logic reaches reads ProofClock, which each run
 * sets to its request's instant (see ProofClock for how), so time is fixed too.
 *
 * Marking. After a run, its trace is searched for ids the runtime generated:
 * whole values (text, attribute values, trace fields) shaped as genUUID shapes
 * them (8-4-4-4-12 lowercase hex, version 4, variant 8 to b) that occur nowhere
 * in the request's inputs: the admitted archive's text entries, the restore, a
 * form given by its bytes, and the request's other arguments. So an id an app
 * authors (a default value, a choice, a hidden value) stays as it is. Each
 * generated id is replaced wherever it occurs in the trace, also inside longer
 * text such as a label that shows it, by "@generated:uuid:N", N counting ids in
 * their order of first appearance in the trace. Two runs whose ids are made in
 * the same places then compare equal whatever order Core drew them in, and two
 * places that hold the same id still hold the same token.
 *
 * The clock's instant as Core spells a date-time (DateUtils.formatDateTime,
 * ISO 8601) is replaced by "@clock:now", and its date as Core spells a date by
 * "@clock:today", wherever either occurs, whether now() or today() produced it
 * or a request or an app holds the same text. The request fixes the clock, so
 * each token stands for exactly one string, and marking never makes two
 * different values equal. A clock value spelled any other way (format-date
 * output, days since the epoch, another zone's spelling) is left as it is: with
 * the clock fixed it is the same on every run. So is an id uuid(n) makes
 * (genGUID's uppercase letters and digits), which no shape tells apart from an
 * authored value; seeded, it too is the same on every run.
 */
final class Generated {
    static final long SEED = 20260930L;
    static final String NOW = "@clock:now";
    static final String TODAY = "@clock:today";

    private Generated() {
    }

    /** Replaces Core's lazily created SecureRandom with a seeded Random. */
    static void seedCoreRandomness() {
        try {
            Field field = MathUtils.class.getDeclaredField("r");
            field.setAccessible(true);
            field.set(null, new Random(SEED));
        } catch (ReflectiveOperationException e) {
            throw new IllegalStateException("The runner could not seed Core's MathUtils random source, so"
                    + " generated ids would differ between runs: " + e, e);
        }
    }

    /** The clock's instant as Core spells a date-time value. */
    static String nowSpelling() {
        return DateUtils.formatDateTime(ProofClock.now(), DateUtils.FORMAT_ISO8601);
    }

    /** The clock's date as Core spells a date value. */
    static String todaySpelling() {
        return DateUtils.formatDate(ProofClock.now(), DateUtils.FORMAT_ISO8601);
    }

    /** Marks the generated values in one run's trace, in place, and returns what it found. */
    static JSONObject mark(JSONObject run, Inputs inputs) {
        Detector detector = new Detector(inputs);
        detector.scan(run);
        Map<String, String> tokens = new LinkedHashMap<>(detector.found);
        tokens.put(nowSpelling(), NOW);
        tokens.put(todaySpelling(), TODAY);
        replace(run, tokens);
        JSONObject clock = new JSONObject();
        clock.put(NOW, nowSpelling());
        clock.put(TODAY, todaySpelling());
        JSONObject found = new JSONObject();
        found.put("uuids", detector.found.size());
        found.put("seed", SEED);
        found.put("clock", clock);
        return found;
    }

    /**
     * The id-shaped values a request supplied: every genUUID-shaped stretch of
     * its inputs' text. A generated id is one the trace holds that is not here.
     */
    static final class Inputs {
        private final Set<String> uuids = new HashSet<>();

        /** The inputs of a request over an admitted app (null when the request names none). */
        static Inputs of(Apps.App app, byte[] restore, JSONObject request) {
            Inputs inputs = new Inputs();
            if (app != null) {
                inputs.uuids.addAll(app.archiveUuids());
            }
            inputs.addText(new String(restore, StandardCharsets.UTF_8));
            JSONObject arguments = new JSONObject(request.toMap());
            arguments.remove("restoreBase64");
            Object form = arguments.remove("formBase64");
            if (form instanceof String) {
                inputs.addText(new String(Base64.getDecoder().decode((String)form), StandardCharsets.UTF_8));
            }
            inputs.addText(arguments.toString());
            return inputs;
        }

        /**
         * The genUUID-shaped values in an archive's text entries. An entry that is
         * not UTF-8 text (an image, audio) is media, whose bytes no trace shows.
         */
        static Set<String> archiveUuids(ZipFile zip) throws IOException {
            Inputs inputs = new Inputs();
            for (Enumeration<? extends ZipEntry> entries = zip.entries(); entries.hasMoreElements(); ) {
                ZipEntry entry = entries.nextElement();
                if (entry.isDirectory()) {
                    continue;
                }
                byte[] bytes;
                try (InputStream in = zip.getInputStream(entry)) {
                    bytes = in.readAllBytes();
                }
                try {
                    inputs.addText(StandardCharsets.UTF_8.newDecoder()
                            .onMalformedInput(CodingErrorAction.REPORT)
                            .onUnmappableCharacter(CodingErrorAction.REPORT)
                            .decode(ByteBuffer.wrap(bytes)).toString());
                } catch (CharacterCodingException notText) {
                    // Media: not text an app's logic or a trace reads.
                }
            }
            return inputs.uuids;
        }

        private void addText(String text) {
            for (int i = 0; i + 36 <= text.length(); i++) {
                if (text.charAt(i + 8) == '-' && text.charAt(i + 13) == '-' && text.charAt(i + 18) == '-'
                        && text.charAt(i + 23) == '-') {
                    String candidate = text.substring(i, i + 36);
                    if (isGeneratedUuidShape(candidate)) {
                        uuids.add(candidate);
                    }
                }
            }
        }

        boolean holds(String uuid) {
            return uuids.contains(uuid);
        }
    }

    private static final class Detector {
        private final Inputs inputs;
        private final Map<String, String> found = new LinkedHashMap<>();

        Detector(Inputs inputs) {
            this.inputs = inputs;
        }

        void scan(Object value) {
            if (value instanceof JSONObject) {
                JSONObject object = (JSONObject)value;
                for (String name : sortedKeys(object)) {
                    scan(object.get(name));
                }
            } else if (value instanceof JSONArray) {
                JSONArray array = (JSONArray)value;
                for (int i = 0; i < array.length(); i++) {
                    scan(array.get(i));
                }
            } else if (value instanceof String) {
                String text = (String)value;
                if (text.startsWith("<") && text.endsWith(">")) {
                    scanXml(text);
                } else {
                    consider(text);
                }
            }
        }

        private void scanXml(String xml) {
            Document document;
            try {
                DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
                factory.setNamespaceAware(true);
                document = factory.newDocumentBuilder().parse(
                        new ByteArrayInputStream(xml.getBytes(StandardCharsets.UTF_8)));
            } catch (Exception e) {
                consider(xml);
                return;
            }
            scanNode(document.getDocumentElement());
        }

        private void scanNode(Node node) {
            if (node instanceof Element) {
                NamedNodeMap attributes = node.getAttributes();
                for (int i = 0; i < attributes.getLength(); i++) {
                    consider(((Attr)attributes.item(i)).getValue());
                }
                NodeList children = node.getChildNodes();
                for (int i = 0; i < children.getLength(); i++) {
                    scanNode(children.item(i));
                }
            } else if (node.getNodeType() == Node.TEXT_NODE || node.getNodeType() == Node.CDATA_SECTION_NODE) {
                consider(node.getNodeValue().trim());
            }
        }

        private void consider(String value) {
            if (isGeneratedUuidShape(value) && !found.containsKey(value) && !inputs.holds(value)) {
                found.put(value, "@generated:uuid:" + (found.size() + 1));
            }
        }
    }

    /** PropertyUtils.genUUID's shape: 8-4-4-4-12 lowercase hex, "4" opening the third group, 8 to b the fourth. */
    static boolean isGeneratedUuidShape(String value) {
        if (value.length() != 36) {
            return false;
        }
        for (int i = 0; i < 36; i++) {
            char c = value.charAt(i);
            boolean dash = i == 8 || i == 13 || i == 18 || i == 23;
            if (dash) {
                if (c != '-') {
                    return false;
                }
            } else if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) {
                return false;
            }
        }
        char variant = value.charAt(19);
        return value.charAt(14) == '4' && (variant == '8' || variant == '9' || variant == 'a' || variant == 'b');
    }

    private static void replace(JSONObject object, Map<String, String> tokens) {
        List<String> raw = new ArrayList<>(tokens.keySet());
        raw.sort((a, b) -> Integer.compare(b.length(), a.length()));
        replaceIn(object, raw, tokens);
    }

    private static void replaceIn(JSONObject object, List<String> raw, Map<String, String> tokens) {
        for (String name : sortedKeys(object)) {
            object.put(name, replaceValue(object.get(name), raw, tokens));
        }
    }

    private static Object replaceValue(Object value, List<String> raw, Map<String, String> tokens) {
        if (value instanceof JSONObject) {
            replaceIn((JSONObject)value, raw, tokens);
            return value;
        }
        if (value instanceof JSONArray) {
            JSONArray array = (JSONArray)value;
            for (int i = 0; i < array.length(); i++) {
                array.put(i, replaceValue(array.get(i), raw, tokens));
            }
            return array;
        }
        if (value instanceof String) {
            String text = (String)value;
            for (String generated : raw) {
                if (text.contains(generated)) {
                    text = text.replace(generated, tokens.get(generated));
                }
            }
            return text;
        }
        return value;
    }

    static List<String> sortedKeys(JSONObject object) {
        List<String> keys = new ArrayList<>(object.keySet());
        keys.sort(String::compareTo);
        return keys;
    }
}
