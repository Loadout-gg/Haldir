import { fileURLToPath } from 'node:url'
import { test, expect, type Page } from '@playwright/test'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { reconcileTaskPanelHistoricalAgentWork } from './task-panel-historical-agent-work'
const root=process.env.HALDIR_EVIDENCE_DIR || fileURLToPath(new URL('../../../test-results/task-panel-refinement', import.meta.url))
if(process.env.HALDIR_PANEL_BASELINE==='1')throw new Error('Historical before metrics are immutable; baseline generation is not permitted')
const baseline=false
const stage=baseline?'before':'after'
mkdirSync(`${root}/${stage}`,{recursive:true})
const summary=(p:Page)=>p.getByRole('region',{name:'Task summary'})
const panel=(p:Page)=>p.getByRole('complementary',{name:'Working bar',exact:true})
async function send(p:Page,text:string){await p.getByLabel('Your message').fill(text);await p.getByRole('button',{name:'Send message'}).click()}
async function settle(p:Page){await p.evaluate(()=>new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r()))))}
for(const width of [1440,768,390,320]) for(const state of ['A02','DetailA','A05']) test(`${state} panel hierarchy and preservation at ${width}`,async({page,baseURL})=>{
 await page.setViewportSize({width,height:width>760?1000:844})
 const denied:string[]=[],errors:string[]=[]
 page.on('pageerror',e=>errors.push(e.message))
 await page.route('**/*',r=>{const u=new URL(r.request().url());if(u.origin!==new URL(baseURL!).origin||u.pathname.startsWith('/api/')){denied.push(u.href);return r.abort()}return r.continue()})
 await page.goto('/demo')
 if(state==='A05'){
  await page.getByText('Demo controls',{exact:true}).click();await page.getByRole('button',{name:'Open external proposal'}).click()
  await page.getByRole('button',{name:'Authorize mandate',exact:true}).click();await page.getByRole('button',{name:'Confirm funding',exact:true}).click()
  await page.getByRole('button',{name:'S03 · Deliver company records'}).click()
 }else await send(page,'Check Northwind Print before I sign. I need a short brief with the evidence.')
 if(state==='DetailA') await page.getByRole('region',{name:'Conversation',exact:true}).getByRole('button',{name:'Edit details',exact:true}).click()
 if(width<=760&&state!=='DetailA')await page.getByRole('button',{name:'Task panel',exact:true}).click()
 await page.evaluate(()=>window.scrollTo(0,0));await panel(page).evaluate(e=>e.scrollTop=0);await settle(page)
 if(!baseline){
  await expect(panel(page)).toHaveClass(/panel-refinement/)
  await expect(panel(page).locator('.working-bar-heading h2')).toHaveCSS('font-size','14px')
  for(const button of await panel(page).getByRole('button').all()){
   await expect(button).toHaveCSS('font-size','14px');await expect(button).toHaveCSS('line-height','20px')
  }
 }
 const metrics=await page.evaluate(()=>{
  const rect=(s:string)=>{const e=document.querySelector(s)!;const b=e.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height}}
  const styles=(s:string)=>{const cs=getComputedStyle(document.querySelector(s)!);return {font:cs.font,fontSize:cs.fontSize,lineHeight:cs.lineHeight,gap:cs.gap,padding:cs.padding}}
  return {conversation:rect('.restoration > .conversation'),composer:rect('.composer-area'),header:rect('.workspace-header'),message:rect('#message'),chatCopy:document.querySelector('.conversation')!.textContent,panel:rect('.restoration-panel'),term:document.querySelector('[aria-label="Task summary"] .terms')?styles('[aria-label="Task summary"] .terms'):null,editor:document.querySelector('.draft-field')?styles('.draft-field'):null}
 })
 writeFileSync(`${root}/${stage}/${state}-${width}-metrics.json`,JSON.stringify(metrics,null,2))
 await page.screenshot({path:`${root}/${stage}/${state}-${width}.png`})
 if(width===1440)await panel(page).screenshot({path:`${root}/${stage}/${state}-panel.png`})
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
 await expect(page.getByLabel('Your message')).toBeInViewport()
 // Authorized states retain full history behind the approved disclosure.
 await expect(page.getByRole('log',{includeHidden:true})).not.toContainText(/Assistant/i)
 await expect(page.getByRole('button',{name:'Shape',exact:true})).toHaveCount(0)
 if(!baseline){
  const old=JSON.parse(readFileSync(`${root}/before/${state}-${width}-metrics.json`,'utf8'))
  // Current product truth is checked on live DOM before historical-only inversion.
  const work=page.getByRole('region',{name:'Agent work',exact:true})
  await expect(work).toHaveCount(1)
  await expect(work).toHaveAttribute('data-tone','neutral')
  await expect(work.locator(':scope > .agent-name')).toHaveText('Haldir')
  await expect(work.getByRole('heading',{level:2})).toHaveText(state==='A05'?'Your supplier check':'Preparing your proposal')
  await expect(work.locator('li')).toHaveCount(2)
  await expect(work.locator('li').first()).toHaveText(state==='A05'?'✓Company records evidence received':'✓Request saved in this local draft')
  await expect(work.locator('.agent-work-current')).toHaveText(state==='A05'?'○Background research not started':'○Budget and expiry need your review')
  await expect(work.locator('.agent-work-notice')).toHaveText(state==='A05'?'Scripted simulation · Only observed local events are shown.':'No spending before your review and authorization.')
  // The finite inverse is comparison-only; mutations run on detached clones.
  const legacy = await page.locator('.conversation').evaluate(reconcileTaskPanelHistoricalAgentWork,{state,historical:old.chatCopy})
  writeFileSync(`${root}/after/${state}-${width}-reconciliation.json`,JSON.stringify(legacy,null,2))
  expect(legacy.liveUnchanged,'adapter/negative controls never change current DOM').toBe(true)
  expect(legacy.negativeControls.map(c=>c.name)).toEqual(['wrong work text','extra work content','unexpected outside content','changed financial or authorization copy','wrong speaker label','duplicate work block','unexpected work attribute'])
  for(const control of legacy.negativeControls)expect(control.rejected,`${control.name}: ${control.error}`).toBe(true)
  expect(legacy.headingCount).toBe(state === 'A05' ? 1 : 0)
  await expect(page.locator('.conversation-content > h2.sr-only').filter({hasText:/^Task progress$/})).toHaveCount(state === 'A05' ? 1 : 0)
  expect(legacy.copy.replace(/Earlier in this conversation · \d+ messages/,''),'historical conversation content').toEqual(old.chatCopy)
  for(const key of ['conversation','composer','header','message'] as const){
   for(const value of Object.values(old[key]))expect(Number.isFinite(value)).toBe(true)
   expect(metrics[key].width,key).toBeGreaterThan(0);expect(metrics[key].height,key).toBeGreaterThan(0)
  }
  const shell=await page.locator('.workspace-shell').boundingBox()
  expect(metrics.header.x).toBeGreaterThanOrEqual(shell!.x)
  expect(metrics.header.y+metrics.header.height).toBeLessThanOrEqual(metrics.conversation.y)
  expect(metrics.composer.x).toBeGreaterThanOrEqual(metrics.conversation.x)
  expect(metrics.composer.x+metrics.composer.width).toBeLessThanOrEqual(metrics.conversation.x+metrics.conversation.width)
  expect(metrics.message.y).toBeGreaterThanOrEqual(metrics.composer.y)
  expect(metrics.message.y+metrics.message.height).toBeLessThanOrEqual(metrics.composer.y+metrics.composer.height)
  await expect(panel(page)).toHaveCSS('background-color','rgb(249, 251, 248)')
  await expect(panel(page)).toHaveCSS('overflow-y','auto')
  if(width>760){expect(metrics.panel.x).toBe(metrics.conversation.x+metrics.conversation.width+8);expect(metrics.panel.height).toBe(metrics.conversation.height-8);expect(metrics.panel.width).toBe(width>1100?384:304)}
  writeFileSync(`${root}/after/${state}-${width}-comparison.json`,JSON.stringify({historical:old,current:metrics,geometryDisposition:'superseded by nine-frame continuous-white/lateral structure; current containment checked; historical-only detached inverse removes exact state-validated additive AgentWork/Haldir nodes plus unchanged approved Task progress h2/history-label handling; see per-case reconciliation.json'},null,2))
  if(state==='A02'){
   for(const label of ['Job','Output']){
    const boxes=await summary(page).getByText(label,{exact:true}).evaluate(e=>{const a=e.getBoundingClientRect(),b=e.nextElementSibling!.getBoundingClientRect();return {a:a.toJSON(),b:b.toJSON()}})
    expect(boxes.b.top).toBeGreaterThanOrEqual(boxes.a.bottom+3)
    expect(Math.abs(boxes.a.left-boxes.b.left)).toBeLessThan(1)
    expect(boxes.b.width).toBe(boxes.a.width)
    expect(boxes.b.width).toBe(await summary(page).getByText(label,{exact:true}).locator('../..').evaluate(e=>e.getBoundingClientRect().width))
   }
   const before=summary(page).getByRole('region',{name:'Before authorization'})
   await expect(before.getByRole('heading',{name:'Before authorization'})).toBeVisible()
   await expect(before.getByRole('button',{name:'Edit details',exact:true})).toBeVisible()
   for(const label of ['Purchase limit','Permission expires'])await expect(summary(page).getByText(label,{exact:true}).locator('..').locator('dd')).toHaveText('Not set')
   expect(await summary(page).locator(':scope > h3').evaluate(e=>parseFloat(getComputedStyle(e).fontSize))).toBe(13)
   await summary(page).getByRole('button',{name:'Edit details'}).click();await expect(page.getByRole('region',{name:'Edit draft details'})).toBeVisible()
  }
  if(state==='DetailA'){
   const editor=page.getByRole('region',{name:'Edit draft details'})
   const job=editor.getByLabel('Job',{exact:true})
   await editor.getByRole('button',{name:'Save draft'}).scrollIntoViewIfNeeded()
   const save=editor.getByRole('button',{name:'Save draft'})
   await expect(save).toBeInViewport();await save.focus();await expect(save).toBeFocused()
   const bounds=await save.boundingBox(),pane=await panel(page).boundingBox()
   expect(bounds!.y).toBeGreaterThanOrEqual(pane!.y)
   expect(bounds!.y+bounds!.height).toBeLessThanOrEqual(pane!.y+pane!.height)
   if(width===1440||width===320){await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:`${root}/after/DetailA-actions-${width}.png`});if(width===1440)await panel(page).screenshot({path:`${root}/after/DetailA-actions-panel.png`})}
   await expect(job).toHaveAccessibleDescription('From your request')
   const order=await job.evaluate(e=>e.nextElementSibling?.textContent)
   expect(order).toBe('From your request')
   await job.fill('Unsaved task panel check');await page.keyboard.press('Tab')
   await editor.getByRole('button',{name:'Cancel',exact:true}).click();await expect(editor.getByRole('alert')).toContainText('Unsaved changes')
   await editor.getByRole('button',{name:'Keep editing'}).click()
   await send(page,'job Changed in chat');await expect(editor.getByRole('button',{name:'Save draft'})).toBeDisabled()
   await editor.getByRole('button',{name:'Use latest chat values'}).click();await expect(job).toHaveValue('Changed in chat')
   await editor.getByRole('button',{name:'Cancel',exact:true}).click();await settle(page)
   await expect(panel(page).getByRole('button',{name:'Edit details',exact:true})).toBeFocused()
  }
  if(state==='A05'){
   const sections=panel(page).locator('.panel-details > section')
   expect(await sections.count()).toBe(4)
   expect(await sections.evaluateAll(es=>es.map(e=>e.getAttribute('aria-label')))).toEqual(['Task summary','Spending','Activity','Results and receipts'])
   for(const heading of await sections.locator(':scope > h3').all())expect(await heading.evaluate(e=>parseFloat(getComputedStyle(e).fontSize))).toBe(13)
   const l=panel(page).getByTestId('ledger');expect(await l.evaluate(e=>getComputedStyle(e.querySelector('dd')!).fontVariantNumeric)).toContain('tabular-nums')
   await expect(panel(page)).toContainText('Company records · Received');await expect(panel(page)).toContainText('Background research · Not started')
   const activity=panel(page).getByRole('region',{name:'Activity'})
   expect(await activity.locator('li').count()).toBe(6)
   const events=await activity.locator('li').allTextContents()
   for(const event of await activity.locator('li').all())await expect(event).toBeVisible()
   await expect(activity.locator('details, summary')).toHaveCount(0)
   await expect(activity.locator('li').last()).toContainText('Company records received')
   if(width===1440||width<=760){
    await activity.locator('h3').scrollIntoViewIfNeeded();await page.evaluate(()=>window.scrollTo(0,0))
    await page.screenshot({path:`${root}/after/A05-activity-${width}.png`})
    if(width===1440)await panel(page).screenshot({path:`${root}/after/A05-activity-panel.png`})
   }
   await panel(page).getByRole('button',{name:'Hide panel',exact:true}).click()
   await page.getByRole('button',{name:'Show task panel',exact:true}).click();await settle(page)
   expect(await activity.locator('li').allTextContents()).toEqual(events)
   for(const event of await activity.locator('li').all())await expect(event).toBeVisible()
   await expect(activity.locator('details, summary')).toHaveCount(0)
   await panel(page).getByRole('button',{name:/^(?:Open company records receipt|Open receipt — company records)$/}).click();await expect(page.getByRole('dialog')).toContainText('DEMO-RECORDS-01');await page.keyboard.press('Escape')
   const stop=page.locator('.conversation-spending-actions').getByRole('button',{name:'Stop new spending'})
   await expect(stop).toBeInViewport();await stop.focus();await expect(stop).toBeFocused()
   if(width<=760){
    const p=await panel(page).boundingBox(),s=await stop.boundingBox(),c=await page.locator('.composer-area').boundingBox()
    expect(p!.y+p!.height).toBeLessThanOrEqual(s!.y-4);expect(s!.height).toBeGreaterThanOrEqual(44)
    expect(s!.y+s!.height).toBeLessThanOrEqual(c!.y)
    writeFileSync(`${root}/correction-stop-${width}.json`,JSON.stringify({width,panel:p,stop:s,composer:c},null,2))
   }
   if(width===1440||width<=760){
    await panel(page).locator('.results').evaluate(e=>{const p=e.closest('aside')!;p.scrollTop+=e.getBoundingClientRect().top-p.getBoundingClientRect().top-16});await page.evaluate(()=>window.scrollTo(0,0))
    await page.screenshot({path:`${root}/after/A05-results${width===1440?'':'-'+width}.png`})
    if(width===1440)await panel(page).screenshot({path:`${root}/after/A05-results-panel.png`})
    if(width<=760){
     await panel(page).getByRole('button',{name:'Stop new spending',exact:true}).scrollIntoViewIfNeeded();await page.evaluate(()=>window.scrollTo(0,0))
     await page.screenshot({path:`${root}/after/A05-actions-${width}.png`})
    }
   }
  }
 }
 expect(denied).toEqual([]);expect(errors).toEqual([])
})

test('Activity remains visible initially, through new events, Hide Show and Continue',async({page,baseURL})=>{
 await page.setViewportSize({width:1440,height:1000})
 await page.route('**/*',r=>{const u=new URL(r.request().url());return u.origin===new URL(baseURL!).origin&&!u.pathname.startsWith('/api/')?r.continue():r.abort()})
 await page.goto('/demo')
 await page.getByText('Demo controls',{exact:true}).click()
 for(const name of ['Open external proposal','Authorize mandate','Confirm funding'])await page.getByRole('button',{name,exact:true}).click()
 const activity=()=>panel(page).getByRole('region',{name:'Activity',exact:true})
 const visibleEvents=async(count:number)=>{
  await expect(activity().locator('li')).toHaveCount(count)
  for(const event of await activity().locator('li').all())await expect(event).toBeVisible()
  await expect(activity().locator('details, summary')).toHaveCount(0)
 }
 await visibleEvents(3)
 for(const [index,name] of ['Start company records payment','Confirm company records payment','Deliver company records response'].entries()){
  await page.getByRole('button',{name,exact:true}).click();await visibleEvents(index+4)
 }
 const retained=await activity().locator('li').allTextContents()
 await panel(page).getByRole('button',{name:'Hide panel',exact:true}).click()
 await page.getByRole('button',{name:'Show task panel',exact:true}).click();await visibleEvents(6)
 expect(await activity().locator('li').allTextContents()).toEqual(retained)
 await page.getByRole('button',{name:'S04 · Excluded recipient request',exact:true}).click()
 await page.getByRole('region',{name:'Conversation',exact:true}).getByRole('button',{name:'Continue without this purchase',exact:true}).click()
 await expect(activity().getByRole('button',{name:'View details',exact:true})).toBeVisible()
 await activity().getByRole('button',{name:'View details',exact:true}).click()
 await expect(panel(page).getByRole('region',{name:'Payment blocked details'})).toContainText('No funds moved')
})

test('native panel buttons use installed shadcn 14px 20px typography',async({page,baseURL})=>{
 await page.setViewportSize({width:1440,height:1000})
 await page.route('**/*',r=>{const u=new URL(r.request().url());return u.origin===new URL(baseURL!).origin&&!u.pathname.startsWith('/api/')?r.continue():r.abort()})
 await page.goto('/demo')
 await send(page,'Check Northwind Print before I sign. I need a short brief with the evidence.')
 await expect(panel(page)).toHaveClass(/panel-refinement/)
 await expect(panel(page).locator('h2')).toHaveCSS('font-size','14px')
 for(const button of await panel(page).getByRole('button').all()){
  await expect(button).toHaveCSS('font-size','14px')
  await expect(button).toHaveCSS('line-height','20px')
  await expect(button).toHaveCSS('font-weight','500')
 }
})
