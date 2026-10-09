type Result = {status:number;ok:boolean;body:any};
type Values = Record<string,unknown>;
export async function createOwnedStoreBuyer(input:{root:string;marker:string;storeType:string;request:(path:string,method?:string,body?:any)=>Promise<Result>;build:(objectName:string,marker:string,values:Values)=>Promise<{values:Values}|{failure:Result}>;capture:(objectName:string,id:string)=>void}):Promise<{storeId:string;accountId:string}|{failure:Result}>{
 const store=await input.build('WebStore',input.marker,{Name:input.marker,Type:input.storeType});
 if('failure' in store)return store;
 const buyer=await input.build('Account',input.marker,{Name:input.marker});
 if('failure' in buyer)return buyer;
 const failed=(message:string)=>({failure:{status:422,ok:false,body:{errorCode:'COMMERCE_CREATION_UNVERIFIED',message}}});
 if(store.values.Name!==input.marker||buyer.values.Name!==input.marker)return failed('Owned store and buyer markers were not preserved.');
 const result=await input.request(input.root+'/composite','POST',{allOrNone:true,compositeRequest:[
 {method:'POST',url:input.root+'/sobjects/WebStore',referenceId:'ownedStore',body:store.values},
 {method:'POST',url:input.root+'/sobjects/Account',referenceId:'ownedBuyer',body:buyer.values},
 {method:'GET',url:input.root+'/sobjects/WebStore/@{ownedStore.id}',referenceId:'storeProof'},
 {method:'GET',url:input.root+'/sobjects/Account/@{ownedBuyer.id}',referenceId:'buyerProof'}]});
 if(!result.ok)return {failure:result};
 const rows=result.body?.compositeResponse;
 if(!Array.isArray(rows))return failed('Salesforce returned no owned store and buyer composite results.');
 const byRef=(name:string)=>rows.find((row:any)=>row.referenceId===name);
 const storeId=byRef('ownedStore')?.body?.id,accountId=byRef('ownedBuyer')?.body?.id;
 const valid=(id:unknown):id is string=>typeof id==='string'&&/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(id);
 if(valid(storeId))input.capture('WebStore',storeId);
 if(valid(accountId))input.capture('Account',accountId);
 const error=rows.find((row:any)=>row.httpStatusCode<200||row.httpStatusCode>=300);
 if(error)return {failure:{status:error.httpStatusCode,ok:false,body:error.body}};
 if(!valid(storeId)||!valid(accountId)||byRef('storeProof')?.body?.Id!==storeId||byRef('storeProof')?.body?.Name!==input.marker||byRef('buyerProof')?.body?.Id!==accountId||byRef('buyerProof')?.body?.Name!==input.marker)return failed('Actual owned store and buyer readback failed.');
 return {storeId,accountId};
}
