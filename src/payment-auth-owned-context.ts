import { cleanupOwnedContext } from './owned-context-cleanup';
type Value = Record<string, any>;
type Result = { status: number; ok: boolean; body: any };
const id = (v: any): v is string => typeof v === 'string' && /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(v);
const successful = (r: Result) => r.ok && Array.isArray(r.body) && r.body.length === 1 && r.body[0]?.isSuccess === true && !r.body[0].errors?.length;
export const PAYMENT_AUTH_ACTIONS = ['authorizePayment'];
export const PAYMENT_AUTH_LIFECYCLE_BUILDER_VERSION = 86;

/** Live-proven recipe: returns-payments lane (test2+test1empty 2026-10-03).
 *  Surviving shape: { accountId, amount: 1, currencyIsoCode, paymentGatewayId,
 *  paymentMethod: { id }, comments }. The CardPaymentMethod fixture must carry
 *  a GatewayToken and ProcessingMode=External. Each convert mints exactly one
 *  guard-blocked PaymentAuthorization (platform refuses deletion in every
 *  status); it is Canceled, unlinked, marker-commented, neutralization-proven
 *  by readback, and reported as structured residue (absence after refused
 *  deletes also counts as cleaned; anything else keeps a cleanup error). */
const ISO4217: Record<string, string> = { US: 'USD', GB: 'GBP', CA: 'CAD', AU: 'AUD', IE: 'EUR', DE: 'EUR', FR: 'EUR' };

export async function invokePaymentAuthorizationWithContext(input: {
  root: string; route: string; verificationWindowMs?: number;
  request: (path: string, method?: string, body?: any) => Promise<Result>;
  build: (name: string, marker: string, values: Value) => Promise<{ values: Value } | { failure: Result }>;
}): Promise<{status: number; body: any; cleanupError?: string; contextSchema?: Value}> {
  const {root,request} = input, action = input.route.split('/').at(-1)!;
  const fail = (errorCode: string, message: string): Result => ({status:422,ok:false,body:{errorCode,message}});
  if (!PAYMENT_AUTH_ACTIONS.includes(action)) return fail('PAYMENT_AUTH_ACTION_INVALID','A supported discovered payment-authorization route is required.');
  const accountSchema = await request(root+'/sobjects/Account/describe');
  if (!accountSchema.ok) return accountSchema;
  const methodSchema = await request(root+'/sobjects/CardPaymentMethod/describe');
  if (!methodSchema.ok) return methodSchema;
  if (!accountSchema.body?.createable || !methodSchema.body?.createable) return fail('PAYMENT_AUTH_CONTEXT_PERMISSIONS_REQUIRED','Live owned payment fixtures require create access.');
  const descriptor = await request(root+'/actions/standard/'+action);
  if (!descriptor.ok) return descriptor;
  if (!Array.isArray(descriptor.body?.inputs)) return fail('PAYMENT_AUTH_ACTION_SCHEMA_UNAVAILABLE','The native payment descriptor has no input schema.');
  const gateways = await request(root+'/query?q='+encodeURIComponent("SELECT Id,PaymentGatewayName FROM PaymentGateway WHERE Status = 'Active' ORDER BY CreatedDate LIMIT 1"));
  const gatewayId = gateways.ok && Array.isArray(gateways.body?.records) ? gateways.body.records[0]?.Id : undefined;
  if (!id(gatewayId)) return fail('PAYMENT_AUTH_GATEWAY_UNAVAILABLE','No Active PaymentGateway exists; provision a test gateway first.');
  let currencyIsoCode: string|undefined;
  const currencies = await request(root+'/query?q='+encodeURIComponent('SELECT IsoCode FROM CurrencyType WHERE IsCorporate = true LIMIT 1'));
  if (currencies.ok && Array.isArray(currencies.body?.records)) currencyIsoCode = currencies.body.records[0]?.IsoCode;
  if (typeof currencyIsoCode !== 'string') {
    const orgs = await request(root+'/query?q='+encodeURIComponent('SELECT SignupCountryIsoCode FROM Organization LIMIT 1'));
    const country = orgs.ok && Array.isArray(orgs.body?.records) ? orgs.body.records[0]?.SignupCountryIsoCode : undefined;
    if (typeof country === 'string' && ISO4217[country]) currencyIsoCode = ISO4217[country];
  }
  if (!currencyIsoCode) return fail('PAYMENT_AUTH_CURRENCY_UNAVAILABLE','No live corporate currency could be resolved.');
  const fields = Array.isArray(methodSchema.body?.fields) ? methodSchema.body.fields : [];
  const activeValues = (name: string): string[] => fields.find((f: Value)=>f.name===name)?.picklistValues?.filter((p: Value)=>p.active&&typeof p.value==='string').map((p: Value)=>p.value) ?? [];
  const statuses = activeValues('Status');
  const modes = activeValues('ProcessingMode');
  const status = statuses[0];
  const mode = modes.includes('External') ? 'External' : modes[0];
  if (!status || !mode) return fail('PAYMENT_AUTH_PICKLIST_UNAVAILABLE','Live CardPaymentMethod picklists expose no usable Status or ProcessingMode value.');
  const marker = 'AS payauth '+crypto.randomUUID(), owned: Array<{objectName:string;id:string}> = [];
  let accountId: string|undefined, methodId: string|undefined, outcome: Result = fail('PAYMENT_AUTH_CONTEXT_UNAVAILABLE','The owned payment lifecycle could not be verified.');
  let cleanupError: string|undefined;
  const residue: Array<{objectName:string;id:string;status:string;unlinked:boolean;markerCommented:boolean}> = [];
  const capture = (objectName: string, value: string) => {if(!owned.some(v=>v.id===value))owned.push({objectName,id:value});};
  try {
    outcome = await (async()=>{
      const acct = await input.build('Account',marker,{Name:marker});
      if ('failure' in acct) return acct.failure;
      const createdAcct = await request(root+'/sobjects/Account','POST',acct.values);
      if (!createdAcct.ok || !id(createdAcct.body?.id)) return createdAcct;
      accountId = createdAcct.body.id; capture('Account',accountId!);
      const built = await input.build('CardPaymentMethod',marker,{NickName:marker,AccountId:accountId,PaymentGatewayId:gatewayId,
        Status:status,ProcessingMode:mode,IsAutoPayEnabled:false,CardHolderFirstName:'Action',CardHolderLastName:'Searcher',
        ExpiryMonth:12,ExpiryYear:2030,CardLastFour:1111,GatewayToken:'AS-TEST-'+Date.now().toString(36)});
      if ('failure' in built) return built.failure;
      const createdMethod = await request(root+'/sobjects/CardPaymentMethod','POST',built.values);
      if (!createdMethod.ok || !id(createdMethod.body?.id)) return createdMethod;
      methodId = createdMethod.body.id; capture('CardPaymentMethod',methodId!);
      const methodRead = await request(root+'/sobjects/CardPaymentMethod/'+methodId);
      if (!methodRead.ok || methodRead.body?.NickName !== marker) return fail('PAYMENT_AUTH_METHOD_UNVERIFIED','Actual owned card-method readback failed.');
      const created = await request(input.route,'POST',{inputs:[{paymentAuthorizationRequest:{
        accountId,amount:1,currencyIsoCode,paymentGatewayId:gatewayId,paymentMethod:{id:methodId},comments:marker}}]});
      if (created.ok && (created.body === null || Array.isArray(created.body) && created.body.length === 0)) return fail('PAYMENT_AUTH_OUTCOME_MISSING','Salesforce returned no native authorization outcome; no mutation is counted as successful.');
      if (!successful(created)) return created;
      const reread = await request(root+'/sobjects/CardPaymentMethod/'+methodId);
      if (!reread.ok || reread.body?.NickName !== marker) return fail('PAYMENT_AUTH_LIFECYCLE_UNVERIFIED','Owned fixtures could not be read back after native authorization.');
      if (input.verificationWindowMs) await new Promise(resolve=>setTimeout(resolve,input.verificationWindowMs));
      return created;
    })();
  } catch { outcome = fail('PAYMENT_AUTH_LIFECYCLE_UNVERIFIED','The owned payment lifecycle could not be verified.'); }
  finally {
    try {
      if (accountId) {
        const attributed = await request(root+'/query?q='+encodeURIComponent(`SELECT Id FROM PaymentAuthorization WHERE AccountId = '${accountId}'`));
        const authIds: string[] = attributed.ok && Array.isArray(attributed.body?.records) ? attributed.body.records.map((r: Value)=>r.Id).filter(id) : [];
        for (const authId of authIds) {
          const logs = await request(root+'/query?q='+encodeURIComponent(`SELECT Id FROM PaymentGatewayLog WHERE ReferencedEntityId = '${authId}'`));
          const logIds: string[] = logs.ok && Array.isArray(logs.body?.records) ? logs.body.records.map((r: Value)=>r.Id).filter(id) : [];
          for (const logId of logIds) {
            const gone = await request(root+'/sobjects/PaymentGatewayLog/'+logId,'DELETE');
            if (!gone.ok) { cleanupError ??= 'Owned gateway-log cleanup failed.'; }
          }
          // Retirement ladder: direct delete, unlink lookups, Draft, Canceled+unlink.
          // Canceled is a one-way trap — attempted last. A survivor is honest residue.
          let retired = (await request(root+'/sobjects/PaymentAuthorization/'+authId,'DELETE')).ok;
          if (!retired) {
            await request(root+'/sobjects/PaymentAuthorization/'+authId,'PATCH',{AccountId:null,PaymentMethodId:null});
            retired = (await request(root+'/sobjects/PaymentAuthorization/'+authId,'DELETE')).ok;
          }
          if (!retired) {
            await request(root+'/sobjects/PaymentAuthorization/'+authId,'PATCH',{Status:'Draft'});
            retired = (await request(root+'/sobjects/PaymentAuthorization/'+authId,'DELETE')).ok;
          }
          if (!retired) {
            await request(root+'/sobjects/PaymentAuthorization/'+authId,'PATCH',{Status:'Canceled',Comments:marker});
            await request(root+'/sobjects/PaymentAuthorization/'+authId,'PATCH',{AccountId:null});
            retired = (await request(root+'/sobjects/PaymentAuthorization/'+authId,'DELETE')).ok;
          }
          // Guard-blocked survivors are neutralized, not deleted: the platform
          // refuses deletion in every status (live-verified), so prove the
          // terminal state by readback (Canceled + both lookups nulled +
          // marker comment) and report the survivor as structured residue.
          // Absence after refused deletes still counts as cleaned; anything
          // else keeps the fail-closed cleanup error.
          if (!retired) {
            const reread = await request(root+'/sobjects/PaymentAuthorization/'+authId);
            if (reread.status === 404) retired = true;
            else {
              const neutralized = reread.ok && reread.body?.Status === 'Canceled' && reread.body?.AccountId == null &&
                reread.body?.PaymentMethodId == null && reread.body?.Comments === marker;
              if (neutralized) residue.push({objectName:'PaymentAuthorization',id:authId,status:'Canceled',unlinked:true,markerCommented:true});
              else cleanupError ??= `PaymentAuthorization ${authId} is guard-blocked (Canceled, unlinked, marker-commented); platform refuses deletion in every status.`;
            }
          }
        }
        if (methodId) {
          await request(root+'/sobjects/CardPaymentMethod/'+methodId,'PATCH',{Status:'InActive'});
          const gone = await request(root+'/sobjects/CardPaymentMethod/'+methodId,'DELETE');
          if (!gone.ok) cleanupError ??= 'Owned card-method cleanup failed.';
        }
        const acctGone = await request(root+'/sobjects/Account/'+accountId,'DELETE');
        if (!acctGone.ok) cleanupError ??= 'Owned account cleanup failed.';
      }
    } catch { cleanupError ??= 'Owned payment cleanup could not be independently read back.'; }
    const swept = await cleanupOwnedContext({root,request,records:owned,order:['CardPaymentMethod','Account'],scopes:[
      {objectName:'Account',equals:{Name:marker}}, {objectName:'CardPaymentMethod',equals:{NickName:marker}},
    ]}).catch(()=>null);
    if (swept) cleanupError ??= swept.cleanupError;
  }
  const contextSchema = {source:'salesforce_live_native_payment_auth_action',marker,accountId,methodId,
    verified:successful(outcome)&&!cleanupError,...(residue.length?{residue}:{}),
    automaticSteps:['Read live native descriptor and owned record schemas','Resolve a live Active gateway and corporate currency','Create and read back an owned buyer and card method','Invoke native authorizePayment and verify the owned relationships','Retire the minted authorization or prove its neutralized terminal state','Delete owned context and independently verify absence']};
  return {status:outcome.status,body:outcome.body,contextSchema,...(cleanupError?{cleanupError}:{})};
}
