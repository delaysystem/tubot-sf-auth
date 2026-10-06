/** Owned lifecycle for createServiceReport.
 * Live-proven recipe: fslfulfill lane (test2 2026-10-04). One bare owned
 * WorkOrder (zero required fields org-wide) grounds {entityId}; the native
 * serviceReportId + contentVersionId outputs are required and read back;
 * the created report, its document, and the fixture delete in order with a
 * marker sweep. No org IDs, aliases, or URLs. */
type Value = Record<string, any>;
type Result = { status: number; ok: boolean; body: any };
const id = (v: any): v is string => typeof v === 'string' && /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(v);
const successful = (r: Result) => r.ok && Array.isArray(r.body) && r.body.length === 1 && r.body[0]?.isSuccess === true && !r.body[0].errors?.length;
export const SERVICE_REPORT_ACTIONS = ['createServiceReport'];
export const SERVICE_REPORT_BUILDER_VERSION = 90;

export async function invokeServiceReportWithContext(input: {
  root: string; route: string; verificationWindowMs?: number;
  request: (path: string, method?: string, body?: any) => Promise<Result>;
  build: (name: string, marker: string, values: Value) => Promise<{ values: Value } | { failure: Result }>;
}): Promise<{status: number; body: any; cleanupError?: string; contextSchema?: Value}> {
  const {root,request} = input, action = input.route.split('/').at(-1)!;
  const fail = (errorCode: string, message: string): Result => ({status:422,ok:false,body:{errorCode,message}});
  if (!SERVICE_REPORT_ACTIONS.includes(action)) return fail('SERVICE_REPORT_ACTION_INVALID','A supported discovered service-report route is required.');
  const schema = await request(root+'/sobjects/WorkOrder/describe');
  if (!schema.ok) return schema;
  if (!schema.body?.createable || !schema.body?.queryable || !schema.body?.deletable || !Array.isArray(schema.body?.fields)) {
    return fail('SERVICE_REPORT_CONTEXT_PERMISSIONS_REQUIRED','Live owned WorkOrder fixtures require create, read and delete access.');
  }
  const fields = schema.body.fields as Value[];
  const subject = fields.find(f => f.name === 'Subject');
  if (!subject?.createable || !subject?.filterable) return fail('SERVICE_REPORT_MARKER_UNAVAILABLE','WorkOrder exposes no writable, filterable Subject marker.');
  const descriptor = await request(root+'/actions/standard/'+action);
  if (!descriptor.ok) return descriptor;
  const inputs = Array.isArray(descriptor.body?.inputs) ? descriptor.body.inputs : [];
  if (!inputs.some((f: Value) => f.name === 'entityId')) return fail('SERVICE_REPORT_INPUT_UNDECLARED','The live descriptor does not declare entityId.');
  const marker = 'AS srvcereport '+crypto.randomUUID();
  let workOrderId: string|undefined, reportId: string|undefined, documentId: string|undefined;
  let outcome: Result = fail('SERVICE_REPORT_CONTEXT_UNAVAILABLE','The owned service-report lifecycle could not be verified.');
  let cleanupError: string|undefined;
  try {
    outcome = await (async()=>{
      const built = await input.build('WorkOrder',marker,{Subject:marker});
      if ('failure' in built) return built.failure;
      const created = await request(root+'/sobjects/WorkOrder','POST',built.values);
      if (!created.ok || !id(created.body?.id)) return created;
      workOrderId = created.body.id;
      const read = await request(root+'/sobjects/WorkOrder/'+workOrderId);
      if (!read.ok || read.body?.Subject !== marker) return fail('SERVICE_REPORT_FIXTURE_UNVERIFIED','Actual owned WorkOrder readback failed.');
      const invoked = await request(input.route,'POST',{inputs:[{entityId:workOrderId}]});
      if (!successful(invoked)) return invoked;
      const outputs = invoked.body[0].outputValues as any;
      reportId = outputs?.serviceReportId;
      documentId = outputs?.contentVersionId;
      if (!id(reportId) || !id(documentId)) return fail('SERVICE_REPORT_OUTPUT_MISSING','Native accept lacks serviceReportId or contentVersionId.');
      const reread = await request(root+'/sobjects/WorkOrder/'+workOrderId);
      const reportRead = await request(root+'/sobjects/ServiceReport/'+reportId);
      if (!reread.ok || !reportRead.ok) return fail('SERVICE_REPORT_LIFECYCLE_UNVERIFIED','Owned report readback failed after native creation.');
      if (input.verificationWindowMs) await new Promise(r=>setTimeout(r,input.verificationWindowMs));
      return invoked;
    })();
  } catch { outcome = fail('SERVICE_REPORT_LIFECYCLE_UNVERIFIED','The owned service-report lifecycle could not be verified.'); }
  finally {
    try {
      // Reverse dependency order: owned report, then its document, then the fixture.
      if (reportId) {
        const gone = await request(root+'/sobjects/ServiceReport/'+reportId,'DELETE');
        if (!gone.ok) cleanupError ??= 'Owned ServiceReport cleanup failed.';
      }
      if (documentId) {
        const gone = await request(root+'/sobjects/ContentDocument/'+documentId,'DELETE');
        if (!gone.ok && gone.status !== 404) cleanupError ??= 'Owned report ContentDocument cleanup failed.';
      }
      if (workOrderId) {
        const gone = await request(root+'/sobjects/WorkOrder/'+workOrderId,'DELETE');
        if (!gone.ok) { cleanupError ??= 'Owned WorkOrder cleanup failed.'; }
        else {
          const reread = await request(root+'/sobjects/WorkOrder/'+workOrderId);
          if (reread.ok) cleanupError ??= 'Owned WorkOrder deletion could not be verified.';
        }
        const sweep = await request(root+'/query?q='+encodeURIComponent(`SELECT Id FROM WorkOrder WHERE Subject = '${marker}'`));
        const rows = sweep.ok && Array.isArray((sweep.body as any)?.records) ? (sweep.body as any).records : null;
        if (!sweep.ok || rows === null) cleanupError ??= 'Owned WorkOrder marker sweep could not be read back.';
        else if (rows.length) cleanupError ??= 'An owned WorkOrder marker row remains after cleanup.';
      }
    } catch { cleanupError ??= 'Owned service-report cleanup could not be independently read back.'; }
  }
  if (cleanupError) return {status:outcome.status,body:outcome.body,cleanupError};
  return successful(outcome)
    ? {...outcome, contextSchema:{source:'salesforce_live_native_service_report_action',verified:true,marker}}
    : outcome;
}
