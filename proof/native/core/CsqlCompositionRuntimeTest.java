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
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Test;
import static org.junit.Assert.*;

/**
 * Core builds each search query of the csql family's scenarios from both
 * suites (Nova's local suite and HQ's regeneration of it) under each sending's
 * answers, as a worker's search sends it: {@code RemoteQuerySessionManager}
 * evaluates the remote request's {@code _xpath_query} data.
 *
 * The scenarios and their sendings are the fixture's
 * (lib/commcare/__tests__/csqlCompositionFixture.ts, written as
 * {@code /csql/scenarios.jsonl}); what HQ's search finds for each query is
 * proof/native/test_csql_payload.py's to judge, so this class states only
 * that every sending builds a query on both paths, and writes them.
 */
public class CsqlCompositionRuntimeTest {
    private static final class Parser extends SuiteParser {
        Parser(InputStream stream) throws IOException { super(stream, null, "nova-csql", null, true, true, false); }
    }
    private InputStream resource(String name) {
        InputStream stream = getClass().getResourceAsStream("/csql/" + name);
        assertNotNull(name, stream);
        return stream;
    }
    private List<String> lines(String name) throws IOException {
        List<String> lines = new ArrayList<>();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(resource(name), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) if (!line.isEmpty()) lines.add(line);
        }
        return lines;
    }
    private void localize(String scenario) throws Exception {
        Hashtable<String, String> strings = new Hashtable<>();
        for (String line : lines(scenario + ".strings.txt")) {
            int equals = line.indexOf('=');
            if (equals > 0) strings.put(line.substring(0, equals), line.substring(equals + 1));
        }
        LocalizerManager.init(true);
        Localizer localizer = LocalizerManager.getGlobalLocalizer();
        localizer.addAvailableLocale("en");
        localizer.registerLocaleResource("en", new TableLocaleSource(strings));
        localizer.setLocale("en");
    }
    @After public void cleanupLocale() { LocalizerManager.clearInstance(); }

    private RemoteQuerySessionManager manager(String scenario, boolean hq, String command) throws Exception {
        localize(scenario);
        Suite suite;
        try (InputStream stream = resource(scenario + (hq ? ".hq-suite.xml" : ".suite.xml"))) { suite = new Parser(stream).parse(); }
        CommCarePlatform platform = new CommCarePlatform(2, 53, 0);
        platform.registerSuite(suite);
        CommCareSession session = new CommCareSession(platform);
        session.setCommand(command);
        TestInstanceInitializer data = new TestInstanceInitializer(MockDataUtils.getStaticStorage()) {
            @Override public InstanceRoot generateRoot(ExternalDataInstance instance) {
                if (instance.getInstanceId().startsWith("search-input:")) return new ConcreteInstanceRoot(null);
                return super.generateRoot(instance);
            }
        };
        Entry entry = suite.getEntry(command);
        assertNotNull(scenario + " has no entry " + command, entry);
        Hashtable<String, DataInstance> instances = entry.getInstances(null);
        for (String id : new ArrayList<>(instances.keySet())) instances.put(id, instances.get(id).initialize(data, id));
        RemoteQuerySessionManager manager = RemoteQuerySessionManager.buildQuerySessionManager(session, new EvaluationContext(null, instances), Collections.emptyList());
        assertNotNull(scenario + " " + command + " builds no query", manager);
        return manager;
    }

    @Test public void everySendingBuildsItsQueryOnBothPaths() throws Exception {
        List<String> records = new ArrayList<>();
        for (String line : lines("scenarios.jsonl")) {
            JSONObject scenario = new JSONObject(line);
            String id = scenario.getString("id");
            JSONArray searches = scenario.getJSONArray("searches");
            for (int s = 0; s < searches.length(); s++) {
                JSONObject search = searches.getJSONObject(s);
                JSONArray sendings = search.getJSONArray("sendings");
                for (boolean hq : new boolean[]{false, true}) {
                    for (int n = 0; n < sendings.length(); n++) {
                        JSONObject sending = sendings.getJSONObject(n);
                        // A fresh manager per sending: no answer carries over.
                        RemoteQuerySessionManager manager = manager(id, hq, search.getString("command"));
                        JSONObject answers = sending.optJSONObject("answers");
                        if (answers != null) {
                            for (String key : answers.keySet()) {
                                manager.answerUserPrompt(key, answers.isNull(key) ? null : answers.getString(key));
                            }
                        }
                        manager.refreshInputDependentState();
                        String label = id + "/" + search.getString("id") + "/" + sending.getString("id") + (hq ? "@hq" : "@local");
                        assertTrue(label + " " + manager.getErrors(), manager.getErrors().isEmpty());
                        Collection<String> queries = manager.getRawQueryParams(false).get("_xpath_query");
                        assertNotNull(label + " sends no _xpath_query", queries);
                        assertFalse(label + " sends no _xpath_query", queries.isEmpty());
                        JSONObject record = new JSONObject();
                        record.put("scenario", id);
                        record.put("search", search.getString("id"));
                        record.put("sending", sending.getString("id"));
                        record.put("carrier", hq ? "hq" : "local");
                        record.put("queries", new JSONArray(new ArrayList<>(queries)));
                        records.add(record.toString());
                    }
                }
            }
        }
        assertFalse("The csql family holds no sending", records.isEmpty());
        Files.write(NativeProof.familyDirectory("csql").resolve("nova-csql-payloads.jsonl"), records, StandardCharsets.UTF_8);
    }
}
