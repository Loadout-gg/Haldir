import {expect,test} from 'vitest'
import {draftFromPreview,draftMatchesPreview,emptyPublicDraft,readPublicDraft,type PublicApprovalPreview} from '../src/integration/public-draft'
const preview:PublicApprovalPreview={contractVersion:'haldir.public.v2',approvalId:'approved',manifestId:'manifest',ownerId:'owner.testnet',ownerCreationRequired:true,approved:{schemaVersion:'haldir.approved.two-source.v1',job:{networkId:'testnet',mandateId:'mandate.testnet',purpose:'Fictional review',output:'Brief',budgetAtomic:'340282366920938463463374607431768211455',vendorIds:['first.testnet','second.testnet'],expiresAt:'2026-11-16T23:00:00.123Z'},sources:[{sourceId:'company-records',quote:{networkId:'testnet',mandateId:'mandate.testnet',vendorId:'first.testnet',orderId:'first',content:'First sample',amountAtomic:'1'}},{sourceId:'background-research',quote:{networkId:'testnet',mandateId:'mandate.testnet',vendorId:'second.testnet',orderId:'second',content:'Second sample',amountAtomic:'2'}}]}}
test('characterization: exact local draft preserves atomic integer and millisecond UTC without authority',()=>{
 const d=draftFromPreview(preview)
 expect(d.budgetAtomic).toBe(preview.approved.job.budgetAtomic);expect(d.expiresAt).toBe(preview.approved.job.expiresAt)
 expect(Object.keys(d).sort()).toEqual(['budgetAtomic','expiresAt','output','purpose','sourceIds'])
 expect(draftMatchesPreview(d,preview)).toBe(true)
})
for(const field of ['purpose','output','budgetAtomic','expiresAt','sourceIds'] as const)test(`characterization: changed ${field} cannot match trusted approval`,()=>{
 const d=draftFromPreview(preview)
 if(field==='sourceIds')d.sourceIds.reverse();else d[field]+='changed'
 expect(draftMatchesPreview(d,preview)).toBe(false)
})
for(const saved of ['{broken',JSON.stringify({...emptyPublicDraft(),ownerId:'forged'}),JSON.stringify({...emptyPublicDraft(),budgetAtomic:12}),JSON.stringify({...emptyPublicDraft(),sourceIds:['background-research','company-records']})])test('characterization: malformed local storage is preparation only and resets safely: '+saved,()=>{
 expect(readPublicDraft({getItem:()=>saved},'https://closed.invalid')).toEqual(emptyPublicDraft())
})
test('characterization: persisted draft read is origin-scoped and has no wallet/backend side effects',()=>{
 const d=draftFromPreview(preview);let key=''
 expect(readPublicDraft({getItem:k=>{key=k;return JSON.stringify(d)}},'https://closed.invalid')).toEqual(d)
 expect(key).toBe('haldir-public-draft-v1:https://closed.invalid')
})
