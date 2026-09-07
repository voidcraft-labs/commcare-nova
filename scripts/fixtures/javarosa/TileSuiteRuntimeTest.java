package nova.compatibility;

import java.io.InputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import org.commcare.xml.SuiteParser;
import org.commcare.suite.model.*;
import org.javarosa.core.model.Constants;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.junit.runners.Parameterized;
import static org.junit.Assert.*;

/** Uses Core's real parser and parsed layout model, without installing resources. */
@RunWith(Parameterized.class)
public class TileSuiteRuntimeTest {
    @Parameterized.Parameters(name = "{0} {1}")
    public static Collection<Object[]> files() {
        List<Object[]> files = new ArrayList<>();
        for (String scenario : new String[]{"plain", "tile", "boxed", "persistent", "grouped-one", "grouped-two", "grouped-search", "grouped-browse"}) {
            for (String suffix : new String[]{"suite.xml", "hq-details.xml"}) files.add(new Object[]{scenario, suffix});
        }
        return files;
    }
    private final String scenario;
    private final String suffix;
    public TileSuiteRuntimeTest(String scenario, String suffix) { this.scenario = scenario; this.suffix = suffix; }
    private static final class ReadOnlyParser extends SuiteParser {
        ReadOnlyParser(InputStream stream) throws IOException { super(stream, null, "nova-proof", null, true, true, false); }
    }
    @Test public void readsLayoutGroupingAndSelectionContract() throws Exception {
        Suite suite;
        try (InputStream input = getClass().getResourceAsStream("/" + scenario + "." + suffix)) {
            assertNotNull("Missing generated suite", input);
            suite = new ReadOnlyParser(input).parse();
        }
        boolean grouped = scenario.startsWith("grouped-");
        boolean tiled = !scenario.equals("plain");
        int headerRows = scenario.equals("grouped-two") ? 2 : 1;
        String[] detailIds = scenario.equals("grouped-search")
            ? new String[]{"m0_case_short", "m0_case_long", "m0_search_short", "m0_search_long"}
            : new String[]{"m0_case_short", "m0_case_long"};
        for (String id : detailIds) {
            Detail detail = suite.getDetail(id);
            assertNotNull(id, detail);
            boolean shortDetail = id.endsWith("short");
            DetailField[] fields = detail.getFields();
            assertEquals(shortDetail ? 4 : 3, fields.length);
            for (int index = 0; index < fields.length; index++) {
                assertEquals(shortDetail && tiled && index < 3, fields[index].isCaseTileField());
                assertEquals(shortDetail && scenario.equals("boxed") && index == 0, fields[index].getShowBorder());
                assertEquals(shortDetail && scenario.equals("boxed") && index == 0, fields[index].getShowShading());
            }
            if (shortDetail && tiled) {
                assertEquals(Integer.valueOf(4), detail.getMaxWidthHeight().first);
                assertEquals(Integer.valueOf(headerRows + 1), detail.getMaxWidthHeight().second);
                assertEquals("large", fields[0].getFontSize());
                assertNull(fields[1].getFontSize());
                assertEquals("start", fields[0].getVerticalAlign());
                assertEquals("center", fields[1].getVerticalAlign());
                assertEquals("end", fields[2].getVerticalAlign());
                assertEquals("left", fields[0].getHorizontalAlign());
                assertEquals("center", fields[1].getHorizontalAlign());
                assertEquals("right", fields[2].getHorizontalAlign());
                assertEquals(headerRows, fields[0].getGridHeight());
                assertEquals(headerRows, fields[1].getGridY());
                assertEquals(2, fields[2].getGridX());
            }
            if (shortDetail) {
                assertEquals("0", fields[3].getHeaderWidthHint());
                assertEquals("0", fields[3].getTemplateWidthHint());
                assertEquals(1, fields[3].getSortOrder());
                assertEquals(Constants.DATATYPE_TEXT, fields[3].getSortType());
                assertEquals(DetailField.DIRECTION_ASCENDING, fields[3].getSortDirection());
            }
            if (shortDetail && grouped) {
                assertNotNull(detail.getGroup());
                assertEquals(Integer.valueOf(headerRows), detail.getGroup().getHeaderRows());
            } else assertNull(detail.getGroup());
        }
        if (suffix.equals("hq-details.xml")) return; // HQ artifact contains only native regenerated details.
        Entry entry = suite.getEntry(scenario.equals("grouped-browse") ? "m0-case-list" : "m0-f0");
        assertNotNull(entry);
        SessionDatum first = entry.getSessionDataReqs().firstElement();
        assertTrue(first instanceof EntityDatum);
        EntityDatum selected = (EntityDatum)first;
        assertEquals("m0_case_short", selected.getShortDetail());
        assertEquals("m0_case_long", selected.getLongDetail());
        assertEquals(scenario.equals("persistent") ? "m0_case_short" : null, selected.getPersistentDetail());
        boolean companion = grouped && !scenario.equals("grouped-browse");
        assertEquals(companion ? 2 : 1, entry.getSessionDataReqs().size());
        if (companion) {
            SessionDatum ids = entry.getSessionDataReqs().elementAt(1);
            assertTrue(ids instanceof ComputedDatum);
            assertEquals("case_id_parent_ids", ids.getDataId());
            assertEquals("join(' ', distinct-values(instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/case_id]/index/parent))", ids.getValue());
        }
        if (scenario.equals("grouped-browse")) assertNull(entry.getXFormNamespace());
        else {
            Entry registration = suite.getEntry("m0-f1");
            assertEquals(1, registration.getSessionDataReqs().size());
            assertTrue(registration.getSessionDataReqs().firstElement() instanceof ComputedDatum);
            assertEquals("uuid()", registration.getSessionDataReqs().firstElement().getValue());
        }
    }
}
