package nova.compatibility;

import java.io.*;
import java.util.*;
import org.commcare.cases.model.Case;
import org.commcare.cases.model.CaseIndex;
import org.commcare.session.*;
import org.commcare.suite.model.*;
import org.commcare.test.utilities.TestInstanceInitializer;
import org.commcare.util.CommCarePlatform;
import org.commcare.util.mocks.*;
import org.commcare.xml.SuiteParser;
import org.javarosa.core.model.condition.EvaluationContext;
import org.javarosa.core.model.data.StringData;
import org.javarosa.core.model.instance.*;
import org.javarosa.core.model.instance.utils.InstanceUtils;
import org.javarosa.core.test.FormParseInit;
import org.javarosa.xpath.expr.FunctionUtils;
import org.junit.Test;
import static org.junit.Assert.*;

/** Native case selection and form calculations under real nested suite entries.
 * Storage is Core's in-memory Case implementation, not Nova's evaluator. */
public class NestedMenuRuntimeTest {
 private static TreeElement node(String name,String value,int multiplicity){TreeElement n=new TreeElement(name,multiplicity);if(value!=null)n.setValue(new StringData(value));return n;}
 private static final class Parser extends SuiteParser{Parser(InputStream in)throws IOException{super(in,null,"nested-proof",null,true,true,false);}}
 private static final class Runtime extends TestInstanceInitializer {
  final CommCareSession session;final String scenario;
  Runtime(CommCareSession session,String scenario){this(MockDataUtils.getStaticStorage(),session,scenario);}
  private Runtime(MockUserDataSandbox sandbox,CommCareSession session,String scenario){
   super(sandbox);this.session=session;this.scenario=scenario;
   for(String[] seed:new String[][]{{"p1","gold-fish"},{"p2","gold-fish"},{"c1","guppy"},{"c2","guppy"},{"wrong-parent","guppy"},{"inactive","guppy"},{"closed","guppy"},{"plan-one","plan"}}){
    Case c=new Case(seed[0],seed[1]);c.setCaseId(seed[0]);c.setProperty("care_status",seed[0].equals("inactive")?"inactive":seed[1].equals("gold-fish")&&!scenario.startsWith("same")?"parent-only":"active");
    if(seed[1].equals("guppy"))c.setIndex(new CaseIndex("parent","gold-fish",seed[0].equals("wrong-parent")?"outside":seed[0].equals("c2")?"p2":"p1"));
    if(seed[0].equals("closed"))c.setClosed(true);sandbox.getCaseStorage().write(c);
   }
  }
  @Override public InstanceRoot generateRoot(ExternalDataInstance instance){
   String id=instance.getInstanceId();TreeElement root;
   if(id.equals("commcaresession"))root=SessionInstanceBuilder.getSessionInstance(session.getFrame(),"device","1",0L,"worker","worker-id",new Hashtable<>(),"400","en");
   else if(id.startsWith("selected_cases")){
    root=node("results",null,0);String[] selected=id.endsWith("guppy")?new String[]{"c1","c2"}:new String[]{"p1","p2"};
    for(int i=0;i<selected.length;i++)root.addChild(node("value",selected[i],i));
   }else return super.generateRoot(instance);
   InstanceUtils.setUpInstanceRoot(root,id,instance.getBase());return new ConcreteInstanceRoot(root);
  }
 }
 @Test public void childSelectionAndFormReadUseTheirOwnNativeSessionIdentity()throws Exception{
  for(boolean hq:new boolean[]{false,true})for(String scenario:new String[]{"different","same","same-bare","same-multiple","same-smaller","parent","parent-multiple","previous","registration","registration-children"}){
   String base="/nested-menu-"+scenario;System.out.println("Nested scenario="+scenario+" hq="+hq);Suite suite;
   try(InputStream in=getClass().getResourceAsStream(base+(hq?".hq-suite.xml":".suite.xml"))){assertNotNull(in);suite=new Parser(in).parse();}
   CommCarePlatform platform=new CommCarePlatform(2,53,0);platform.registerSuite(suite);CommCareSession session=new CommCareSession(platform);session.setCommand("m1-f0");
   Entry entry=suite.getEntry("m1-f0");Runtime runtime=new Runtime(session,scenario);
   int selections=0;
   for(SessionDatum datum:entry.getSessionDataReqs())if(datum instanceof EntityDatum){
    selections++;
    String id=datum.getDataId();boolean parent=scenario.startsWith("parent")||scenario.equals("previous");
    if(id.startsWith("selected_cases"))session.setDatum(SessionFrame.STATE_MULTIPLE_DATUM_VAL,id,"selected-storage-"+id);
    else session.setEntityDatum(id,scenario.startsWith("same")?"p1":parent&&id.equals("case_id")?"p1":"c1");
   }
   assertEquals(scenario+" hq="+hq,scenario.startsWith("registration")?0:scenario.startsWith("parent")||scenario.equals("previous")?2:1,selections);
   EvaluationContext context=session.getEvaluationContext(runtime);
   if(!scenario.startsWith("registration")){
    EntityDatum child=(EntityDatum)entry.getSessionDataReqs().lastElement();List<String> ids=new ArrayList<>();
    for(TreeReference ref:context.expandReference(child.getNodeset()))ids.add((String)context.resolveReference(ref).getAttribute(null,"case_id").getValue().getValue());
    List<String> expected=scenario.startsWith("same")?List.of("p1","p2"):scenario.equals("parent")?List.of("c1"):scenario.equals("parent-multiple")?List.of("c1","c2"):scenario.equals("previous")?List.of("c1","inactive"):List.of("c1","c2","wrong-parent");
    if(hq && scenario.equals("parent-multiple")) {
     // Deliberately bypassed HQ refusal: its scalar parent join reads the
     // selection storage GUID and returns no children. Local output above
     // must return c1+c2 from the two selected parents.
     assertTrue("Refused HQ carrier must reproduce the documented lost relation",ids.isEmpty());
    } else assertEquals(scenario+" hq="+hq,expected,ids);
   }
   int computed=0;while(session.getNeededDatum() instanceof ComputedDatum){session.setComputedDatum(context);if(++computed>3)throw new AssertionError("Unexpected computed loop");}
   assertNull(scenario+" hq="+hq,session.getNeededDatum());
   assertEquals(scenario+" hq="+hq,scenario.equals("registration-children")?2:scenario.startsWith("registration")||scenario.equals("previous")?1:0,computed);
   FormParseInit parsed=new FormParseInit(base+(hq?".hq.xml":".xml"));parsed.getFormDef().initialize(true,runtime);
   TreeElement data=parsed.getFormDef().getInstance().getRoot();
   if(!scenario.startsWith("registration")){
    assertEquals((scenario.contains("multiple")||scenario.equals("same-smaller"))?"shared answer":"active",data.getChild("copied_status",0).getValue().getValue());
    Menu childMenu=suite.getMenus().stream().filter(menu->menu.getId().equals("m1")).findFirst().orElseThrow();
    if(childMenu.getCommandRelevance(0)!=null)assertTrue(FunctionUtils.toBoolean(childMenu.getCommandRelevance(0).eval(session.getEvaluationContext(runtime,"m1",null))));
   }else if(scenario.equals("registration-children")){
    String ownId=(String)data.getChild("case",0).getAttribute(null,"case_id").getValue().getValue();
    assertEquals(ownId,data.getChild("subcase_0",0).getChild("case",0).getChild("index",0).getChild("parent",0).getValue().getValue());
   }
  }
 }
 @Test public void localRequiresSmallerChildPromptAndRefusedHqCarrierBypassesIt()throws Exception{
  for(boolean hq:new boolean[]{false,true}){
   Suite suite;try(InputStream in=getClass().getResourceAsStream("/nested-menu-same-smaller"+(hq?".hq-suite.xml":".suite.xml"))){assertNotNull(in);suite=new Parser(in).parse();}
   CommCarePlatform platform=new CommCarePlatform(2,53,0);platform.registerSuite(suite);CommCareSession session=new CommCareSession(platform);
   session.setCommand("m0-f0");session.setDatum(SessionFrame.STATE_MULTIPLE_DATUM_VAL,"selected_cases","root-five-case-selection");
   session.setCommand("m1-f0");
   if(hq){assertNull("Deliberately bypassed HQ refusal reproduces skipped child bound",session.getNeededDatum());continue;}
   assertNotNull("Child maximum4 must require a new selection after root maximum5",session.getNeededDatum());
   assertEquals("selected_cases_gold-fish",session.getNeededDatum().getDataId());
   assertEquals(4,((MultiSelectEntityDatum)session.getNeededDatum()).getMaxSelectValue());
  }
 }

}
