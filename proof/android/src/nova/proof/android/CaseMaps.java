package nova.proof.android;

import com.google.android.gms.maps.model.LatLng;
import org.commcare.cases.entity.Entity;
import org.commcare.gis.EntityMapDisplayInfo;
import org.commcare.gis.EntityMapUtils;
import org.commcare.suite.model.Detail;
import org.commcare.suite.model.EntityDatum;
import org.javarosa.core.model.instance.TreeReference;
import org.json.JSONArray;
import org.json.JSONObject;

/** Read the native projection EntityMapActivity.addEntityData hands to the map SDK. */
final class CaseMaps {
    private CaseMaps() {}

    static JSONArray read(EntityDatum datum, Detail detail) throws Exception {
        JSONArray cases = new JSONArray();
        for (Entity<TreeReference> entity : EntityMapUtils.getEntities(detail, datum.getNodeset())) {
            EntityMapDisplayInfo info = EntityMapUtils.getDisplayInfoForEntity(entity, detail);
            if (info == null) continue;
            JSONObject item = new JSONObject().put("label", entity.getFieldString(0))
                .put("invalid", info.getErrorEncountered());
            if (info.getLocation() != null) item.put("location", point(info.getLocation()));
            JSONArray boundary = new JSONArray();
            if (info.getBoundary() != null) for (LatLng p : info.getBoundary()) boundary.put(point(p));
            item.put("boundary", boundary);
            if (info.getBoundaryColorHex() != null) item.put("boundaryColor", info.getBoundaryColorHex());
            JSONArray points = new JSONArray();
            if (info.getPoints() != null) for (LatLng p : info.getPoints()) points.put(point(p));
            item.put("points", points);
            if (info.getPointColorsHex() != null) item.put("pointColors", new JSONArray(info.getPointColorsHex()));
            cases.put(item);
        }
        return cases;
    }

    private static JSONArray point(LatLng point) throws Exception {
        return new JSONArray().put(point.latitude).put(point.longitude);
    }
}
