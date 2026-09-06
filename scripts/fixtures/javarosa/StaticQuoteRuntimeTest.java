package nova.compatibility;

import java.io.InputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Hashtable;
import java.util.List;
import org.commcare.xml.SuiteParser;
import org.commcare.suite.model.Suite;
import org.commcare.session.CommCareSession;
import org.commcare.session.RemoteQuerySessionManager;
import org.commcare.util.CommCarePlatform;
import org.commcare.test.utilities.TestInstanceInitializer;
import org.commcare.util.mocks.MockDataUtils;
import org.javarosa.core.model.condition.EvaluationContext;
import org.javarosa.core.model.instance.DataInstance;
import org.junit.Test;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;

public class StaticQuoteRuntimeTest {
    private static class Parser extends SuiteParser {
        Parser(InputStream stream) throws IOException {
            super(stream, null, "static-proof", null, true, true, false);
        }
    }

    private List<String> queries(String resource) throws Exception {
        Suite suite;
        try (InputStream stream = getClass().getResourceAsStream(resource)) {
            assertNotNull(resource, stream);
            suite = new Parser(stream).parse();
        }
        CommCarePlatform platform = new CommCarePlatform(2, 53, 0);
        platform.registerSuite(suite);
        CommCareSession session = new CommCareSession(platform);
        session.setCommand("search_command.m0");
        TestInstanceInitializer data = new TestInstanceInitializer(MockDataUtils.getStaticStorage());
        Hashtable<String, DataInstance> instances = suite.getEntry("search_command.m0").getInstances(null);
        for (String id : new ArrayList<>(instances.keySet())) {
            instances.put(id, instances.get(id).initialize(data, id));
        }
        RemoteQuerySessionManager manager = RemoteQuerySessionManager.buildQuerySessionManager(
            session, new EvaluationContext(null, instances), Collections.emptyList());
        return new ArrayList<>(manager.getRawQueryParams(false).get("_xpath_query"));
    }

    @Test public void formerlyAdmittedBranchesActuallyRefuseSearch() throws Exception {
        assertEquals(Collections.nCopies(4, "search-value-mixes-quote-marks()"),
            queries("/before-static-quote-branches.suite.xml"));
    }

    @Test public void admittedCounterpartsSelectSafeValuesOnBothCarriers() throws Exception {
        for (String source : Arrays.asList("/static-quotes.suite.xml", "/static-quotes.hq-suite.xml")) {
            assertEquals(source, Collections.nCopies(4, "first_name = \"safe\""), queries(source));
        }
    }
}
