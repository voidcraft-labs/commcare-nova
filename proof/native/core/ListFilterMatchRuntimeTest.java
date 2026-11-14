package nova.compatibility;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import org.commcare.cases.util.StringUtils;
import org.commcare.modern.util.Pair;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

/**
 * Core's two string functions of the case list filter, over the vectors
 * Preview's port is held to in Vitest
 * (lib/preview/__tests__/fixtures/listFilterMatch.ts, written by the
 * expression producer as /expression/list-filter-match.json).
 *
 * Android's list and Formplayer's both filter through
 * EntitySortUtil.sortEntities, which folds each field and each typed term
 * with StringUtils.normalize and, with fuzzy search on, matches a term against
 * a sort field's words with StringUtils.fuzzyMatch. Each row's expected value
 * is Preview's (lib/preview/listFilterMatch.ts): Core must normalize each text
 * to the same text, and give each fuzzy pair the same verdict and distance
 * (-1 where it does not match).
 *
 * Plausible failures: a port that misreads the combining-mark block or the
 * order of NFD, mark removal and lower case; a port that counts characters
 * where Core counts UTF-16 code units; a cut of the target at another length;
 * a threshold or a minimum source length other than Core's.
 */
public class ListFilterMatchRuntimeTest {
    private static JSONObject vectors() throws Exception {
        try (InputStream input = ListFilterMatchRuntimeTest.class.getResourceAsStream("/expression/list-filter-match.json")) {
            assertNotNull("The expression producer did not supply list-filter-match.json", input);
            JSONObject result = new JSONObject(new String(input.readAllBytes(), StandardCharsets.UTF_8));
            assertEquals("Unknown list filter vectors version", 1, result.getInt("schemaVersion"));
            return result;
        }
    }

    @Test
    public void normalizeFoldsEachTextAsPreviewDoes() throws Exception {
        JSONArray rows = vectors().getJSONArray("normalize");
        assertTrue("The normalize vectors are empty", rows.length() > 0);
        for (int i = 0; i < rows.length(); i++) {
            JSONObject row = rows.getJSONObject(i);
            String text = row.getString("text");
            assertEquals("StringUtils.normalize of \"" + text + "\"",
                row.getString("normalized"), StringUtils.normalize(text));
        }
    }

    @Test
    public void fuzzyMatchGivesEachPairPreviewsVerdictAndDistance() throws Exception {
        JSONArray rows = vectors().getJSONArray("fuzzy");
        assertTrue("The fuzzy vectors are empty", rows.length() > 0);
        boolean sawMatch = false;
        boolean sawMiss = false;
        for (int i = 0; i < rows.length(); i++) {
            JSONObject row = rows.getJSONObject(i);
            String source = row.getString("source");
            String target = row.getString("target");
            Pair<Boolean, Integer> match = StringUtils.fuzzyMatch(source, target);
            String pair = "StringUtils.fuzzyMatch(\"" + source + "\", \"" + target + "\")";
            assertEquals(pair + " verdict", row.getBoolean("matches"), match.first);
            assertEquals(pair + " distance", row.getInt("distance"), match.second.intValue());
            sawMatch |= match.first;
            sawMiss |= !match.first;
        }
        assertTrue("The fuzzy vectors hold no pair Core matches", sawMatch);
        assertTrue("The fuzzy vectors hold no pair Core refuses", sawMiss);
    }
}
