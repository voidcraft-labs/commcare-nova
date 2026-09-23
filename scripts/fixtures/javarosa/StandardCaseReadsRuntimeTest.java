package nova.compatibility;

import java.util.Date;
import org.commcare.cases.model.Case;
import org.commcare.cases.model.CaseIndex;
import org.commcare.test.utilities.TestInstanceInitializer;
import org.commcare.util.mocks.MockDataUtils;
import org.commcare.util.mocks.MockUserDataSandbox;
import org.javarosa.core.model.FormDef;
import org.javarosa.core.model.data.StringData;
import org.javarosa.core.model.instance.*;
import org.javarosa.core.model.instance.utils.InstanceUtils;
import org.javarosa.core.test.FormParseInit;
import org.javarosa.test_utils.ExprEvalUtils;
import org.junit.Test;
import static org.junit.Assert.*;

/** Exact CCZ form reads real native Case instances, not hand-written casedb XML. */
public class StandardCaseReadsRuntimeTest {
 private static TreeElement node(String name, String value) {
  TreeElement n = new TreeElement(name, 0);
  if (value != null) n.setValue(new StringData(value));
  return n;
 }
 @Test public void selectedAndParentMetadataReadWithoutCustomDefinitions() throws Exception {
  MockUserDataSandbox sandbox = MockDataUtils.getStaticStorage();
  for (String type : new String[]{"visit", "household"}) {
   Case record = new Case(type + " name", type);
   record.setCaseId(type + "-1"); record.setUserId(type + "-owner");
   record.setExternalId(type + "-external"); record.setClosed("household".equals(type));
   record.setDateOpened(new Date(1776427200000L)); record.setLastModified(new Date(1776513600000L));
   if ("visit".equals(type)) record.setIndex(new CaseIndex("parent", "household", "household-1"));
   sandbox.getCaseStorage().write(record);
  }
  FormDef form = new FormParseInit("/standard-case-reads.xml").getFormDef();
  form.initialize(true, new TestInstanceInitializer(sandbox) {
   @Override public InstanceRoot generateRoot(ExternalDataInstance instance) {
    if (!"commcaresession".equals(instance.getInstanceId())) return super.generateRoot(instance);
    TreeElement session = node("session", null), context = node("context", null), data = node("data", null);
    for (String key : new String[]{"deviceid", "username", "userid", "appversion"}) context.addChild(node(key, "fixture-" + key));
    context.addChild(node("drift", "0")); data.addChild(node("case_id", "visit-1"));
    session.addChild(context); session.addChild(data);
    InstanceUtils.setUpInstanceRoot(session, instance.getInstanceId(), new InstanceBase(instance.getInstanceId()));
    return new ConcreteInstanceRoot(session);
   }
  });
  for (String type : new String[]{"visit", "household"}) {
   for (String[] pair : new String[][]{{"case_id",type+"-1"},{"case_name",type+" name"},{"owner_id",type+"-owner"},{"external_id",type+"-external"},{"status","visit".equals(type)?"open":"closed"}}) {
    assertEquals(type+"."+pair[0],pair[1],ExprEvalUtils.xpathEval(form.getEvaluationContext(),"string(/data/"+type+"_"+pair[0]+")"));
   }
   assertEquals("2026-04-17",((String)ExprEvalUtils.xpathEval(form.getEvaluationContext(),"string(/data/"+type+"_date_opened)")).substring(0,10));
   assertEquals("2026-04-18",((String)ExprEvalUtils.xpathEval(form.getEvaluationContext(),"string(/data/"+type+"_last_modified)")).substring(0,10));
  }
 }
}
