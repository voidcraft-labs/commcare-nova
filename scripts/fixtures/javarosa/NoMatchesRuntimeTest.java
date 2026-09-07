package nova.compatibility;

import java.io.*;
import java.util.*;
import org.commcare.session.*;
import org.commcare.suite.model.*;
import org.commcare.test.utilities.TestInstanceInitializer;
import org.commcare.util.CommCarePlatform;
import org.commcare.util.mocks.MockDataUtils;
import org.commcare.xml.SuiteParser;
import org.javarosa.core.model.condition.EvaluationContext;
import org.javarosa.core.model.data.StringData;
import org.javarosa.core.model.instance.*;
import org.javarosa.core.model.instance.utils.InstanceUtils;
import org.javarosa.core.test.FormParseInit;
import org.junit.Test;
import static org.junit.Assert.*;

/** Actual Core Register action, native default calculation and completion frame.
 * Search result/input fixtures substitute returned data, not runtime behavior.
 * No query HTTP or case-transaction persistence is performed. */
public class NoMatchesRuntimeTest {
 private static TreeElement node(String name,String value){TreeElement node=new TreeElement(name,0);if(value!=null)node.setValue(new StringData(value));return node;}
 private static final class Parser extends SuiteParser{Parser(InputStream in)throws IOException{super(in,null,"no-matches-proof",null,true,true,false);}}
 private static final class Runtime extends TestInstanceInitializer {
  final CommCareSession session;final int matches;
  Runtime(CommCareSession session,int matches){super(MockDataUtils.getStaticStorage());this.session=session;this.matches=matches;}
  @Override public InstanceRoot generateRoot(ExternalDataInstance instance){
   TreeElement root;String id=instance.getInstanceId();
   if(id.equals("commcaresession"))root=SessionInstanceBuilder.getSessionInstance(session.getFrame(),"device","1",0L,"worker","worker-id",new Hashtable<>(),"400","en");
   else if(id.equals("results:inline")){root=node("results",null);if(matches>0){TreeElement result=node("case",null);result.setAttribute(null,"case_id","existing-case");root.addChild(result);}}
   else if(id.equals("search-input:results:inline")){root=node("input",null);TreeElement field=node("field","Ada & Bea");field.setAttribute(null,"name","patient_name");root.addChild(field);}
   else return super.generateRoot(instance);
   InstanceUtils.setUpInstanceRoot(root,id,instance.getBase());return new ConcreteInstanceRoot(root);
  }
 }
 @Test public void registerAppearsOnlyForEmptyResultsCarriesSearchAnswerAndReturnsAsConfigured()throws Exception{
  for(boolean hq:new boolean[]{false,true})for(String scenario:new String[]{"basic","bare","parent","parent-bare","home","multiple-home"}){
   String resource="/no-matches-"+scenario;Suite suite;
   try(InputStream in=getClass().getResourceAsStream(resource+(hq?".hq-suite.xml":".suite.xml"))){assertNotNull(in);suite=new Parser(in).parse();}
   CommCarePlatform platform=new CommCarePlatform(2,53,0);platform.registerSuite(suite);CommCareSession session=new CommCareSession(platform);
   session.setCommand(scenario.endsWith("bare")?"m0-case-list":"m0-f0");
   if(scenario.startsWith("parent"))session.setEntityDatum("parent_id","household-one");
   Runtime empty=new Runtime(session,0),found=new Runtime(session,1);
   Detail detail=suite.getDetail("m0_case_short");assertNotNull(detail);
   EvaluationContext emptyContext=session.getEvaluationContext(empty),foundContext=session.getEvaluationContext(found);
   assertEquals(scenario+" hq="+hq,0,detail.getCustomActions(foundContext).size());
   Vector<Action> actions=detail.getCustomActions(emptyContext);assertEquals(1,actions.size());
   session.executeStackOperations(actions.firstElement().getStackOperations(),emptyContext);
   assertEquals(scenario.startsWith("parent")?"m2-f0":"m1-f0",session.getCommand());
   String created=session.getData().get("case_id_new_patient_0");assertNotNull(created);assertTrue(created.matches("[0-9a-f-]{36}"));
   assertEquals("m0",session.getData().get("return_to"));
   if(scenario.startsWith("parent")){assertEquals("household-one",session.getData().get("parent_id"));assertNull(session.getData().get("case_id"));}
   assertNull(session.getNeededDatum());
   FormParseInit form=new FormParseInit(resource+(hq?".hq.xml":".xml"));form.getFormDef().initialize(true,empty);
   assertEquals("Ada & Bea",form.getFormDef().getInstance().getRoot().getChild("case_name",0).getValue().getValue());
   assertTrue(session.finishExecuteAndPop(session.getEvaluationContext(empty)));
   boolean home=scenario.endsWith("home");
   assertEquals(scenario+" hq="+hq,home?null:"m0",session.getCommand());
   List<StackFrameStep> queries=new ArrayList<>();for(StackFrameStep step:session.getFrame().getSteps())if(step.getType().equals(SessionFrame.STATE_QUERY_REQUEST))queries.add(step);
   if(home||scenario.endsWith("bare"))assertTrue(queries.isEmpty());
   else {assertEquals(1,queries.size());assertEquals("https://www.commcarehq.org/a/test-domain/phone/case_fixture/no-matches-evidence/",queries.get(0).getValue());assertEquals(List.of(created),new ArrayList<>(queries.get(0).getExtras().get("case_id")));}
  }
 }
}
