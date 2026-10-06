import { expect, test } from 'bun:test';
import { describeFlowScalarCreationContract, invokeFlowScalarCreationContract } from './flow-scalar-creation-contract';
const root='/services/data/v67.0', route=root+'/actions/custom/flow/TenantCreateRecord';
const schema={createable:true,deletable:true,queryable:true,fields:[{name:'Title',type:'string',length:255,filterable:true,createable:true},{name:'Body',type:'textarea',createable:true}]};
const descriptor={inputs:[{name:'ItemTitle',type:'STRING'},{name:'ItemBody',type:'STRING'},{name:'unrelatedContext',type:'STRING',required:false}],outputs:[{name:'createdItem',type:'SOBJECT',sobjectType:'Item',description:'The record created by the flow.'}]};
const request=async()=>({status:200,ok:true,body:schema});
test('scalar creation contract derives exact fields from a live typed output',async()=>{
 const result=await describeFlowScalarCreationContract({root,route,descriptor,request});
 expect(result.status).toBe(200);expect(result.contextSchema).toMatchObject({targetObject:'Item',markerField:'Title',omittedInputs:['unrelatedContext'],bindings:[{inputName:'ItemTitle',field:'Title'},{inputName:'ItemBody',field:'Body'}]});
 expect((await describeFlowScalarCreationContract({root,route,descriptor:{...descriptor,inputs:[...descriptor.inputs,{name:'missing',type:'STRING',required:true}]},request})).status).toBe(422);
 expect((await describeFlowScalarCreationContract({root,route,descriptor:{...descriptor,outputs:[]},request})).status).toBe(422);
});
test('scalar creation verifies genuine mutation and owned cleanup, preserving false success',async()=>{
 const plan=(await describeFlowScalarCreationContract({root,route,descriptor,request})).contextSchema!;
 for(const mutate of [true,false]){
 let row:any, deletes=0;
 const actual=async(path:string,method='GET',body?:any)=>{
  if(path===route){if(mutate)row={Id:'a01000000000001AAA',Title:body.inputs[0].ItemTitle,Body:body.inputs[0].ItemBody};return {status:200,ok:true,body:[{isSuccess:true,outputValues:{createdItem:row??{Id:'a01000000000001AAA'}}}]};}
  if(path.includes('/query?'))return {status:200,ok:true,body:{records:row?[row]:[]}};
  if(method==='DELETE'){deletes++;row=undefined;return {status:204,ok:true,body:null};}
  return {status:row?200:404,ok:!!row,body:row??[]};
 };
 const result=await invokeFlowScalarCreationContract({root,route,plan,request:actual});
 expect(result.contextSchema.verified).toBe(mutate);expect(result.status).toBe(mutate?200:422);expect(deletes).toBe(mutate?1:0);expect(result.cleanupError).toBeUndefined();
 }
});
test('scalar creation recovers only marker-owned records after lost execution response',async()=>{
 const plan=(await describeFlowScalarCreationContract({root,route,descriptor,request})).contextSchema!;let row:any,deletes=0;
 const actual=async(path:string,method='GET',body?:any)=>{if(path===route){row={Id:'a01000000000001AAA',Title:body.inputs[0].ItemTitle,Body:body.inputs[0].ItemBody};throw Error('lost response');}if(path.includes('/query?'))return {status:200,ok:true,body:{records:row?[row]:[]}};if(method==='DELETE'){deletes++;row=undefined;return {status:204,ok:true,body:null};}return {status:row?200:404,ok:!!row,body:row??[]};};
 const result=await invokeFlowScalarCreationContract({root,route,plan,request:actual});expect(result.status).toBe(502);expect(result.contextSchema.verified).toBe(false);expect(deletes).toBe(1);expect(result.cleanupError).toBeUndefined();
});
test('customer identity context is resolved from live provider output and target reference metadata',async()=>{
 const d={...descriptor,inputs:[...descriptor.inputs,{name:'verifiedCustomerID',type:'STRING',description:'The verified Customer ID'}]};
 const live=async(path:string)=>({status:200,ok:true,body:path.endsWith('/actions/custom/flow')?{actions:[{name:'IdentifyCustomer'}]}:path.endsWith('/IdentifyCustomer')?{outputs:[{name:'record',type:'SOBJECT',sobjectType:'Person',description:'The identified customer record'}]}:path.endsWith('/Person/describe')?{...schema,fields:[{name:'Name',nameField:true,type:'string',length:80,filterable:true,createable:true}]}:{...schema,fields:[...schema.fields,{name:'PersonId',type:'reference',referenceTo:['Person'],createable:true}]}});
 const result=await describeFlowScalarCreationContract({root,route,descriptor:d,request:live});
 expect(result.contextSchema).toMatchObject({referenceBindings:[{inputName:'verifiedCustomerID',objectName:'Person',field:'PersonId'}],fixtures:[{objectName:'Person',markerField:'Name'}],omittedInputs:['unrelatedContext']});
});
