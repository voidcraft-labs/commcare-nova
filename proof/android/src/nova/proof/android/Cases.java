package nova.proof.android;

import org.commcare.CommCareApplication;
import org.commcare.android.database.user.models.ACase;
import org.commcare.cases.model.CaseIndex;
import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.Hashtable;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The cases the device's own case storage holds, written so two devices compare: each case's type, name,
 * whether it is closed, its owner, its properties and its indices, in the order of their ids. An id the device
 * drew for itself (a UUID no restore brought) is written by its place among the cases the device made, ordered
 * by what each holds, since a real device draws another each time.
 */
final class Cases {
    private static final Pattern UUID = Pattern.compile(
            "[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}");
    /** The ids the restore brought, which are the document's own and stay as they are. */
    private static final Map<String, Boolean> restored = new HashMap<>();

    private Cases() {
    }

    /** Remembers the ids the device holds now as the restore's own. */
    static void restored() {
        restored.clear();
        for (ACase held : CommCareApplication.instance().getUserStorage(ACase.STORAGE_KEY, ACase.class)) {
            restored.put(held.getCaseId(), Boolean.TRUE);
        }
    }

    static JSONArray read() throws Exception {
        List<ACase> cases = new ArrayList<>();
        for (ACase held : CommCareApplication.instance().getUserStorage(ACase.STORAGE_KEY, ACase.class)) {
            cases.add(held);
        }
        // The restore's cases by their ids; the device's own after them, by what each holds (its type, its
        // name, its properties), then by the order the device made them: two forms that make the same cases in
        // another order make the same cases.
        Collections.sort(cases, (a, b) -> {
            boolean ownA = !restored.containsKey(a.getCaseId());
            boolean ownB = !restored.containsKey(b.getCaseId());
            if (ownA != ownB) {
                return ownA ? 1 : -1;
            }
            if (!ownA) {
                return a.getCaseId().compareTo(b.getCaseId());
            }
            int held = signature(a).compareTo(signature(b));
            return held != 0 ? held : Integer.compare(a.getID(), b.getID());
        });
        Map<String, String> drawn = new HashMap<>();
        for (ACase held : cases) {
            if (!restored.containsKey(held.getCaseId())) {
                drawn.put(held.getCaseId(), "@device-case:" + (drawn.size() + 1));
            }
        }
        JSONArray found = new JSONArray();
        for (ACase held : cases) {
            JSONObject entry = new JSONObject();
            entry.put("id", named(held.getCaseId(), drawn));
            entry.put("type", Screens.orNull(held.getTypeId()));
            entry.put("name", Screens.orNull(named(held.getName(), drawn)));
            entry.put("closed", held.isClosed());
            entry.put("owner", Screens.orNull(named(held.getUserId(), drawn)));
            JSONObject properties = new JSONObject();
            Hashtable<?, ?> all = held.getProperties();
            TreeMap<String, String> ordered = new TreeMap<>();
            for (Map.Entry<?, ?> property : all.entrySet()) {
                ordered.put(String.valueOf(property.getKey()), String.valueOf(property.getValue()));
            }
            for (Map.Entry<String, String> property : ordered.entrySet()) {
                properties.put(property.getKey(), named(property.getValue(), drawn));
            }
            entry.put("properties", properties);
            JSONObject indices = new JSONObject();
            for (CaseIndex index : held.getIndices()) {
                JSONObject target = new JSONObject();
                target.put("type", index.getTargetType());
                target.put("target", named(index.getTarget(), drawn));
                target.put("relationship", index.getRelationship());
                indices.put(index.getName(), target);
            }
            entry.put("indices", indices);
            found.put(entry);
        }
        return found;
    }

    /** What a case the device made holds, without any id the device drew. */
    private static String signature(ACase held) {
        TreeMap<String, String> ordered = new TreeMap<>();
        for (Map.Entry<?, ?> property : ((Hashtable<?, ?>)held.getProperties()).entrySet()) {
            ordered.put(String.valueOf(property.getKey()),
                    UUID.matcher(String.valueOf(property.getValue())).replaceAll("@"));
        }
        return held.getTypeId() + "\u0000" + UUID.matcher(String.valueOf(held.getName())).replaceAll("@")
                + "\u0000" + held.isClosed() + "\u0000" + ordered;
    }

    /** A value with each id the device drew written by its order, and any other UUID as one. */
    private static String named(String value, Map<String, String> drawn) {
        if (value == null) {
            return null;
        }
        Matcher matcher = UUID.matcher(value);
        StringBuffer written = new StringBuffer();
        while (matcher.find()) {
            String id = matcher.group();
            String name = drawn.containsKey(id) ? drawn.get(id) : restored.containsKey(id) ? id : null;
            if (name == null) {
                name = "@device-uuid";
            }
            matcher.appendReplacement(written, Matcher.quoteReplacement(name));
        }
        matcher.appendTail(written);
        return written.toString();
    }
}
