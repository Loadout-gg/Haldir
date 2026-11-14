import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
const root = process.env.HALDIR_EVIDENCE_DIR!
const viewports = [[320,844],[390,844],[759,900],[760,900],[761,900],[768,1024],[1099,900],[1100,900],[1101,900],[1440,1000],[1920,1080],[2560,1440],[844,390]] as const
for (const [width,height] of viewports) test(`Brand Light responsive boundary ${width}x${height}: actual controller, contrast and native controls`, async ({page,baseURL,browser}) => {
  const denied:string[]=[], errors:string[]=[]
  page.on('pageerror', e=>errors.push(e.message))
  await page.route('**/*', r=>{const u=new URL(r.request().url()); if(u.origin!==new URL(baseURL!).origin||u.pathname.startsWith('/api/')){denied.push(u.href);return r.abort()}return r.continue()})
  await page.setViewportSize({width,height}); await page.goto('/demo')
  await expect(page.getByLabel('Your message')).toBeVisible()
  const platform = await page.evaluate(()=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches}))
  expect(platform).toEqual({width,height,dpr:1,reducedMotion:true})
  await page.getByLabel('Your message').fill('job Check Northwind; output Brief; budget 30; expiry 2026-11-12T18:00')
  await page.getByLabel('Your message').press('Enter')
  const authorize=page.getByRole('button',{name:'Authorize mandate',exact:true})
  await expect(authorize).toHaveCSS('background-color','rgb(213, 231, 163)')
  await authorize.click()
  await page.getByText('Demo controls',{exact:true}).click()
  for(const name of ['Confirm funding','S03 · Deliver company records','S04 · Excluded recipient request'])await page.getByRole('button',{name,exact:true}).click()
  await page.evaluate(()=>window.scrollTo(0,0))
  if(height<600)await page.getByLabel('Your message').scrollIntoViewIfNeeded()
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
  const composition=await page.locator('.conversation').evaluate(el=>{const selectors=['.conversation-stream','.conversation-spending-actions','.composer-area'];return selectors.map(selector=>{const node=el.querySelector(selector)!;const b=node.getBoundingClientRect();return {selector,box:b.toJSON(),client:node.clientWidth,scroll:node.scrollWidth}})})
  for(const row of composition)expect(row.scroll).toBeLessThanOrEqual(row.client+1)
  const stop=page.locator('.conversation-spending-actions').getByRole('button',{name:'Stop new spending'})
  const sb=await stop.boundingBox(), cb=await page.locator('.composer-area').boundingBox()
  expect(sb!.y+sb!.height).toBeLessThanOrEqual(cb!.y)
  await expect(page.locator('.block-optional-actions').getByRole('button',{name:'Request mandate change'})).toHaveAccessibleDescription('Requires a new authorization. Opens a separate proposal. Even after authorization, it will not change this task in the demo.')
  const pairs=await page.evaluate(()=>{
    const rgb=(s:string)=>s.match(/[\d.]+/g)!.slice(0,3).map(Number)
    const luminance=(s:string)=>rgb(s).map(v=>{const c=v/255;return c<=.04045?c/12.92:((c+.055)/1.055)**2.4}).reduce((v,c,i)=>v+c*[.2126,.7152,.0722][i],0)
    return ['.preview-notice','.panel-status','.panel-amendment-note','.composer-limit','.blocked-request','.blocked-request h3','.mandate-change-requirement','.composer-actions button[aria-label="Send message"]'].flatMap(selector=>{
      const node=document.querySelector(selector); if(!node||!(node as HTMLElement).getClientRects().length||(node as HTMLButtonElement).disabled)return []
      const cs=getComputedStyle(node);let p:Element|null=node,bg=''
      while(p){const c=getComputedStyle(p).backgroundColor;if(c!=='rgba(0, 0, 0, 0)'&&c!=='transparent'){bg=c;break}p=p.parentElement}
      const a=luminance(cs.color),b=luminance(bg);return [{selector,color:cs.color,background:bg,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05),font:cs.font,fontSize:cs.fontSize,lineHeight:cs.lineHeight}]
    })
  })
  for(const pair of pairs)expect(pair.ratio,JSON.stringify(pair)).toBeGreaterThanOrEqual(4.5)
  const axe=await new AxeBuilder({page}).analyze();expect(axe.violations).toEqual([])
  const controls=await page.locator('button').evaluateAll(nodes=>nodes.filter(n=>n.getClientRects().length&&!n.closest('.demo-controls')).map(n=>{const s=getComputedStyle(n),r=n.getBoundingClientRect();return {text:n.textContent,slot:n.getAttribute('data-slot'),font:s.fontSize,lineHeight:s.lineHeight,height:r.height,backgroundImage:s.backgroundImage}}))
  for(const c of controls){expect(c.backgroundImage).toBe('none');if(width<=760)expect(c.height).toBeGreaterThanOrEqual(44)}
  await page.evaluate(()=>window.scrollTo(0,0));mkdirSync(root,{recursive:true})
  await page.screenshot({path:`${root}/boundary-${width}x${height}.png`})
  writeFileSync(`${root}/boundary-${width}x${height}.json`,JSON.stringify({browser:browser.version(),platform,composition,pairs,controls,axeViolations:axe.violations,denied,errors,shortLandscape:height<600?'Incumbent min-height requires vertical page scrolling; not an initial-viewport composer guarantee':null},null,2))
  expect(denied).toEqual([]);expect(errors).toEqual([])
})
