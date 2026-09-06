package nova.compatibility;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import org.commcare.session.CommCareSession;
import org.commcare.session.RemoteQuerySessionManager;
import org.commcare.suite.model.*;
import org.commcare.test.utilities.TestInstanceInitializer;
import org.commcare.util.CommCarePlatform;
import org.commcare.util.mocks.MockDataUtils;
import org.commcare.xml.SuiteParser;
import org.javarosa.core.model.condition.EvaluationContext;
import org.javarosa.core.model.instance.*;
import org.javarosa.core.services.locale.*;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Test;
import static org.junit.Assert.*;

public class CsqlQuoteRuntimeTest {
    private static final String REFUSAL = "search-value-mixes-quote-marks()";
    private static final class Parser extends SuiteParser {
        Parser(InputStream stream) throws IOException { super(stream, null, "nova-quotes", null, true, true, false); }
    }
    private InputStream resource(String name) {
        InputStream stream = getClass().getResourceAsStream("/" + name);
        assertNotNull(name, stream);
        return stream;
    }
    private void localize() throws Exception {
        Hashtable<String, String> strings = new Hashtable<>();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(resource("runtime-quotes.strings.txt"), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                int equals = line.indexOf('=');
                if (equals > 0) strings.put(line.substring(0, equals), line.substring(equals + 1));
            }
        }
        LocalizerManager.init(true);
        Localizer localizer = LocalizerManager.getGlobalLocalizer();
        localizer.addAvailableLocale("en");
        localizer.registerLocaleResource("en", new TableLocaleSource(strings));
        localizer.setLocale("en");
    }
    @After public void cleanupLocale() { LocalizerManager.clearInstance(); }
    private RemoteQuerySessionManager manager(boolean hq) throws Exception {
        localize();
        Suite suite;
        try (InputStream stream = resource("runtime-quotes" + (hq ? ".hq-suite.xml" : ".suite.xml"))) { suite = new Parser(stream).parse(); }
        CommCarePlatform platform = new CommCarePlatform(2, 53, 0);
        platform.registerSuite(suite);
        CommCareSession session = new CommCareSession(platform);
        session.setCommand("search_command.m0");
        TestInstanceInitializer data = new TestInstanceInitializer(MockDataUtils.getStaticStorage()) {
            @Override public InstanceRoot generateRoot(ExternalDataInstance instance) {
                if (instance.getInstanceId().startsWith("search-input:")) return new ConcreteInstanceRoot(null);
                return super.generateRoot(instance);
            }
        };
        Hashtable<String, DataInstance> instances = suite.getEntry("search_command.m0").getInstances(null);
        for (String id : new ArrayList<>(instances.keySet())) instances.put(id, instances.get(id).initialize(data, id));
        RemoteQuerySessionManager manager = RemoteQuerySessionManager.buildQuerySessionManager(session, new EvaluationContext(null, instances), Collections.emptyList());
        assertNotNull(manager);
        return manager;
    }
    @Test public void actualAnswersProduceWholeQueriesAndComputedValidation() throws Exception {
        String[][] samples = {
            {"absent", null, null},
            {"empty", "", ""},
            {"plain", "Ada", "Jr"},
            {"single", "O'Connor", "Jr"},
            {"double", "The \"Boss\"", "Jr"},
            {"injection-single", "x' or match-all() or 'y", "Jr"},
            {"injection-double", "x\" or match-all() or \"y", "Jr"},
            {"multiline", "Line\nTwo\t雪", "Jr"},
            {"both", "it's \"quoted\"", "Jr"},
            {"computed-both", "Ada'", "Lovelace\""},
            {"unused-branch", "fallback", "unused'\""},
            {"cleared", null, null},
        };
        List<String> records = new ArrayList<>();
        for (boolean hq : new boolean[]{false, true}) {
            RemoteQuerySessionManager manager = manager(hq);
            for (String[] sample : samples) {
                manager.answerUserPrompt("query", sample[1]);
                manager.answerUserPrompt("suffix", sample[2]);
                manager.refreshInputDependentState();
                Set<String> errors = manager.getErrors().keySet();
                if (sample[0].equals("both")) assertEquals(new HashSet<>(Arrays.asList("query", "suffix")), errors);
                else if (sample[0].equals("computed-both")) assertEquals(new HashSet<>(Arrays.asList("query", "suffix")), errors);
                else assertTrue(sample[0] + errors, errors.isEmpty());
                List<String> queries = new ArrayList<>(manager.getRawQueryParams(false).get("_xpath_query"));
                assertEquals(sample[0], 6, queries.size());
                if (sample[0].equals("both")) {
                    for (int i = 0; i < 6; i++) assertEquals(sample[0] + i, REFUSAL, queries.get(i));
                } else if (sample[0].equals("computed-both")) {
                    assertEquals(REFUSAL, queries.get(5));
                    for (int i = 0; i < 5; i++) assertNotEquals(REFUSAL, queries.get(i));
                } else for (String query : queries) assertNotEquals(sample[0], REFUSAL, query);
                JSONObject record = new JSONObject();
                record.put("carrier", hq ? "hq" : "local");
                record.put("sample", sample[0]);
                record.put("input", sample[1] == null ? JSONObject.NULL : sample[1]);
                record.put("suffix", sample[2] == null ? JSONObject.NULL : sample[2]);
                record.put("queries", queries);
                record.put("errors", new TreeSet<>(errors));
                records.add(record.toString());
            }
        }
        Files.write(Paths.get("build/nova-quote-payloads.jsonl"), records, StandardCharsets.UTF_8);
    }
}
