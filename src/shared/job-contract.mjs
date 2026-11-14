import { createHash } from 'node:crypto';
import { isDeepStrictEqual as equal } from 'node:util';
const demand = value => { if (!value) throw new Error('Invalid job contract'); };
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && equal(Object.keys(v).sort(), keys.split(' ').sort());
const account = s => typeof s === 'string' && s.length >= 2 && s.length <= 64 && /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(s);
const amount = s => typeof s === 'string' && /^[1-9][0-9]{0,38}$/.test(s) && BigInt(s) < 2n**128n;
const text = s => typeof s === 'string' && s.length > 0 && s.length <= 2048;
const ids = ['company-records','background-research'];
export const quoteKey = q => Buffer.from(JSON.stringify(['haldir-local-v1',q.networkId,q.mandateId,q.orderId])).toString('base64url');
export const paymentOperationId = quoteId => createHash('sha256').update(JSON.stringify(['haldir-agent-payment-v1',quoteId])).digest('hex');
export function approvedSources(a) {
  const two = a?.schemaVersion === 'haldir.approved.two-source.v1', j = a?.job;
  demand(exact(a,two?'schemaVersion job sources':'job quote') && exact(j,'networkId mandateId purpose output budgetAtomic vendorIds expiresAt'));
  demand(typeof j.networkId === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(j.networkId) && account(j.mandateId) && text(j.purpose) && text(j.output) && amount(j.budgetAtomic) &&
    Array.isArray(j.vendorIds) && j.vendorIds.length >= 1 && j.vendorIds.length <= 4 && j.vendorIds.every(account) && new Set(j.vendorIds).size === j.vendorIds.length &&
    typeof j.expiresAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(j.expiresAt) && Number.isFinite(Date.parse(j.expiresAt)) && new Date(j.expiresAt).toISOString() === (j.expiresAt.includes('.')?j.expiresAt:j.expiresAt.replace('Z','.000Z')));
  const sources = two?a.sources:[{sourceId:'legacy',quote:a.quote}];
  demand(Array.isArray(sources) && sources.length === (two?2:1));
  const result = Array.from(sources,(s,i)=>{
    demand(exact(s,'sourceId quote') && s.sourceId === (two?ids[i]:'legacy'));
    const q=s.quote;
    demand(exact(q,'networkId mandateId vendorId amountAtomic orderId content') && q.networkId===j.networkId && q.mandateId===j.mandateId && j.vendorIds.includes(q.vendorId) && amount(q.amountAtomic) && typeof q.orderId==='string' && /^[a-zA-Z0-9_-]{1,64}$/.test(q.orderId) && text(q.content));
    return {sourceId:s.sourceId,quoteId:quoteKey(q),quote:structuredClone(q)};
  });
  const sum=result.reduce((n,s)=>n+BigInt(s.quote.amountAtomic),0n);
  demand(sum<2n**128n && sum<=BigInt(j.budgetAtomic));
  if(two) demand(equal(j.vendorIds,result.map(s=>s.quote.vendorId)) && new Set(result.map(s=>s.quote.vendorId)).size===2 && new Set(result.map(s=>s.quote.orderId)).size===2 && new Set(result.map(s=>s.quote.content)).size===2);
  return result;
}
export function jobSourceRefs(job) {
  if (!Object.hasOwn(job,'schemaVersion') && !Object.hasOwn(job,'sourceRefs')) { demand(typeof job.quoteId==='string' && job.quoteId.length>0 && job.quoteId.length<=2048); return [{sourceId:'legacy',quoteId:job.quoteId}]; }
  demand(job.schemaVersion==='haldir.job.two-source.v1' && Array.isArray(job.sourceRefs) && job.sourceRefs.length===2 && Array.from(job.sourceRefs).every((s,i)=>exact(s,'sourceId quoteId') && s.sourceId===ids[i] && typeof s.quoteId==='string' && s.quoteId.length>0 && s.quoteId.length<=2048) && job.sourceRefs[0].quoteId!==job.sourceRefs[1].quoteId && job.quoteId===job.sourceRefs[0].quoteId);
  return structuredClone(job.sourceRefs);
}
export function approvedInput(job, quoteId=job.quoteId) {
  const refs=jobSourceRefs(job); demand(refs.some(s=>s.quoteId===quoteId)); const s=job.scope;
  return {jobId:job.jobId,ownerId:job.ownerId,quoteId,qualification:job.qualification,networkId:s.networkId,mandateId:s.mandateId,purpose:s.purpose,output:s.output,budgetAtomic:s.budgetAtomic,vendorIds:structuredClone(s.vendorIds),expiresAt:s.expiresAt,...(job.schemaVersion?{sourceRefs:refs}:{})};
}
