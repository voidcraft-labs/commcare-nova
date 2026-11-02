package nova.compatibility;

import org.javarosa.core.model.*;
import org.javarosa.core.model.data.DecimalData;
import org.javarosa.core.model.data.IAnswerData;
import org.javarosa.core.model.data.IntegerData;
import org.javarosa.core.model.data.SelectOneData;
import org.javarosa.core.model.data.helper.Selection;
import org.javarosa.core.model.data.StringData;
import org.javarosa.core.model.instance.*;
import org.javarosa.core.model.instance.utils.InstanceUtils;
import org.javarosa.core.test.FormParseInit;
import org.javarosa.form.api.FormEntryController;
import org.javarosa.test_utils.ExprEvalUtils;
import org.junit.Test;
import static org.junit.Assert.*;

/**
 * Core counts a repeat's rows from each whole-number count Nova admits (part 04 §2.3, §2.4), on the local form
 * the expression producer writes (/expression/repeat-counts/counts.xml): a Hidden Value calculating an integer
 * (`planned`, `#form/n + 1`) and an integer single select (`pick`), each named directly by `jr:count`, and
 * `int(#form/weight div 2)` through its `nova_count_by_int` node. The retained control is the count Nova wrote
 * before: the same node calculating the unwrapped decimal (`half`'s own print), which Core truncates under the
 * node's `xsd:int` (`Recalculate.wrapData`; `int` truncates alike, `FunctionUtils.toInt`).
 *
 * A count is read as `IntegerData().cast(count.uncast())` (`FormEntryModel.createModelForGroup`,
 * `FormDef.canCreateRepeat`), which is `Integer.parseInt`. The plausible failure is a direct count Core reads as
 * a fraction: a Hidden Value whose integral result is held as `3.0`, which stops the form with "must be a number!",
 * or a select whose value text is not what `parseInt` reads.
 */
public class RepeatCountRuntimeTest {
 private static final String FORM="/expression/repeat-counts/counts.xml";
 private static TreeElement node(String name,String value) {
  TreeElement n=new TreeElement(name,0);
  if(value!=null)n.setValue(new StringData(value));
  return n;
 }
 private static InstanceInitializationFactory environment() {
  return new InstanceInitializationFactory() {
   @Override public InstanceRoot generateRoot(ExternalDataInstance instance) {
    if(!"commcaresession".equals(instance.getInstanceId()))throw new AssertionError(instance.getInstanceId());
    TreeElement root=node("session",null),context=node("context",null);
    for(String key:new String[]{"deviceid","username","userid","appversion"})context.addChild(node(key,"fixture-"+key));
    context.addChild(node("drift","0"));root.addChild(context);root.addChild(node("data",null));
    InstanceUtils.setUpInstanceRoot(root,instance.getInstanceId(),new InstanceBase(instance.getInstanceId()));
    return new ConcreteInstanceRoot(root);
   }
  };
 }
 private static Object eval(FormDef form,String expression)throws Exception{return ExprEvalUtils.xpathEval(form.getEvaluationContext(),expression);}
 private static org.javarosa.core.model.instance.TreeReference ref(FormDef form,String path)throws Exception {
  return ((org.javarosa.xpath.XPathNodeset)org.javarosa.xpath.XPathParseTool.parseXPath(path).eval(form.getMainInstance(),form.getEvaluationContext())).getRefAt(0);
 }
 private static void set(FormDef form,String path,IAnswerData value)throws Exception{form.setValue(value,ref(form,path));}

 /** The form Nova emits, or its retained control: the carrier's calculate replaced by `half`'s, the decimal
  * the count wraps in `int(...)`. */
 private FormDef load(boolean control)throws Exception {
  javax.xml.parsers.DocumentBuilderFactory factory=javax.xml.parsers.DocumentBuilderFactory.newInstance();factory.setNamespaceAware(true);
  org.w3c.dom.Document document;
  try(java.io.InputStream stream=getClass().getResourceAsStream(FORM)){
   assertNotNull("The expression producer wrote no "+FORM,stream);
   document=factory.newDocumentBuilder().parse(stream);
  }
  if(control){
   org.w3c.dom.Element half=null,carrier=null;
   org.w3c.dom.NodeList nodes=document.getElementsByTagNameNS("*","bind");
   for(int n=0;n<nodes.getLength();n++){
    org.w3c.dom.Element element=(org.w3c.dom.Element)nodes.item(n);
    if("/data/half".equals(element.getAttribute("nodeset")))half=element;
    if("/data/nova_count_by_int".equals(element.getAttribute("nodeset")))carrier=element;
   }
   assertNotNull("The count form holds no bind for /data/half",half);
   assertNotNull("The count form holds no carrier for by_int",carrier);
   assertEquals("xsd:int",carrier.getAttribute("type"));
   carrier.setAttribute("calculate",half.getAttribute("calculate"));
  }
  java.io.ByteArrayOutputStream bytes=new java.io.ByteArrayOutputStream();
  javax.xml.transform.TransformerFactory.newInstance().newTransformer().transform(new javax.xml.transform.dom.DOMSource(document),new javax.xml.transform.stream.StreamResult(bytes));
  try(java.io.InputStream input=new java.io.ByteArrayInputStream(bytes.toByteArray())){
   FormDef form=org.javarosa.xform.util.XFormUtils.getFormFromInputStream(input);form.initialize(true,environment());return form;
  }
 }
 private static void enter(FormDef form)throws Exception {
  FormEntryController controller=new FormParseInit(form).getFormEntryController();controller.jumpToIndex(FormIndex.createBeginningOfFormIndex());
  int steps=0;
  while(controller.stepToNextEvent()!=FormEntryController.EVENT_END_OF_FORM)if(++steps>200)throw new AssertionError("Entry did not terminate");
 }

 /** Each row is (n, weight, the select's value, the rows every count makes). The weights' halves are
  * fractions where they can be, so the carrier and its control both truncate. */
 @Test public void wholeCountsCountTheSameRowsAsTheRetainedFractionalCarrier()throws Exception {
  Object[][] cases={{2,6.6,"3",3},{0,2.9,"1",1},{1,4.0,"2",2}};
  for(Object[] item:cases)for(boolean control:new boolean[]{false,true}){
   String label=(control?"control ":"")+java.util.Arrays.toString(item);
   int expected=(Integer)item[3];
   FormDef form=load(control);
   set(form,"/data/n",new IntegerData((Integer)item[0]));
   set(form,"/data/weight",new DecimalData((Double)item[1]));
   set(form,"/data/pick",new SelectOneData(new Selection((String)item[2])));
   enter(form);
   // The direct counts hold integer text, which is what parseInt reads.
   assertEquals(label,String.valueOf(expected),eval(form,"string(/data/planned)"));
   assertEquals(label,String.valueOf(expected),eval(form,"string(/data/pick)"));
   assertEquals(label,String.valueOf(expected),eval(form,"string(/data/nova_count_by_int)"));
   for(String repeat:new String[]{"by_hidden","by_int","by_select"})
    assertEquals(label+" "+repeat,(double)expected,eval(form,"count(/data/"+repeat+")"));
  }
 }

 /** A direct Hidden Value count follows its answer as a carrier did: raising `n` makes the rows the new count
  * names, and lowering it removes none (`FormEntryModel` only creates). */
 @Test public void aDirectHiddenValueCountFollowsTheAnswerItCalculatesFrom()throws Exception {
  FormDef form=load(false);
  set(form,"/data/n",new IntegerData(1));enter(form);
  assertEquals(2.0,eval(form,"count(/data/by_hidden)"));
  set(form,"/data/n",new IntegerData(4));enter(form);
  assertEquals("5",eval(form,"string(/data/planned)"));
  assertEquals(5.0,eval(form,"count(/data/by_hidden)"));
  set(form,"/data/n",new IntegerData(0));enter(form);
  assertEquals(5.0,eval(form,"count(/data/by_hidden)"));
 }
}
