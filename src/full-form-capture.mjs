import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {screenshotValue} from './screenshot-quality.mjs';

const chromeOnly = '#header_holder,#float_tool,#help_content,.floatTool';
const maskSelector = 'input:not([type=radio]):not([type=checkbox]):not([type=button]):not([type=submit]),textarea,select,.infoplus_labelControl,.infoplus_fileControl_link,.form_remark_title';

// Copy exact pixels from the high resolution source; crop geometry is recorded in its coordinate space.
export async function cropEvidence(page, source, target, box) {
  const bytes=await fs.readFile(source);
  const data=await page.evaluate(async ({data,box})=>{
    const img=new Image();img.src='data:image/png;base64,'+data;await img.decode();
    const canvas=document.createElement('canvas');canvas.width=box.width;canvas.height=box.height;
    if(box.x<0||box.y<0||box.x+box.width>img.naturalWidth||box.y+box.height>img.naturalHeight)throw Error('Crop exceeds source');
    canvas.getContext('2d').drawImage(img,box.x,box.y,box.width,box.height,0,0,box.width,box.height);
    return canvas.toDataURL('image/png').split(',')[1];
  },{data:bytes.toString('base64'),box});
  await fs.writeFile(target,Buffer.from(data,'base64'));
}

export async function captureFullForm(page, meta, {root}) {
  const folder=path.join(root,`${String(meta.index).padStart(2,'0')}-${meta.nodeId}`);
  await fs.mkdir(path.join(folder,'original'),{recursive:true});
  const originalViewport=page.viewportSize();const scroll=await page.evaluate(()=>({x:scrollX,y:scrollY}));
  const restores=[];
  try {
    await page.setViewportSize({width:1920,height:1080});
    await page.waitForTimeout(400);
    const candidates=[];
    for(const frame of page.frames()) {
      const locator=frame.locator('#form_holder').first();
      if(await locator.count() && await locator.isVisible()) candidates.push({frame,locator});
    }
    if(candidates.length!==1) throw Error('未找到唯一完整表单，不能以当前视口代替');
    const {frame,locator}=candidates[0];
    const layout=await frame.evaluate(()=>{
      const root=document.querySelector('#form_holder');
      const expanded=[];
      for(const e of [root,...root.querySelectorAll('*')]) {
        const c=getComputedStyle(e);
        if(e.getClientRects().length && /(auto|scroll)/.test(c.overflow+c.overflowX+c.overflowY) && (e.scrollHeight>e.clientHeight+2||e.scrollWidth>e.clientWidth+2)) {
          expanded.push({e,style:e.getAttribute('style'),scrollTop:e.scrollTop,scrollLeft:e.scrollLeft});
          e.style.setProperty('max-height','none','important');e.style.setProperty('max-width','none','important');
          e.style.setProperty('height',e.scrollHeight+'px','important');e.style.setProperty('width',e.scrollWidth+'px','important');e.style.setProperty('overflow','visible','important');
        }
      }
      window.__prdCaptureRestore=expanded;
      return {expanded:expanded.length,width:root.scrollWidth,height:root.scrollHeight};
    });
    restores.push(async()=>frame.evaluate(()=>{for(const s of window.__prdCaptureRestore||[]){s.style===null?s.e.removeAttribute('style'):s.e.setAttribute('style',s.style);s.e.scrollTop=s.scrollTop;s.e.scrollLeft=s.scrollLeft;}delete window.__prdCaptureRestore;}));
    if(frame!==page.mainFrame()) {
      const iframe=await frame.frameElement();const style=await iframe.getAttribute('style');
      await iframe.evaluate((e,size)=>{e.style.width=size.width+'px';e.style.height=size.height+'px';},layout);
      restores.push(async()=>iframe.evaluate((e,s)=>s===null?e.removeAttribute('style'):e.setAttribute('style',s),style));
    }
    if(layout.width>4000||layout.height>24000)throw Error('表单超出一次可靠采集尺寸；保留缺图，需专门分块拼接核验');
    await page.setViewportSize({width:Math.max(1920,Math.ceil(layout.width+100)),height:1080});
    const metrics=await locator.evaluate(root=>{
      const b=root.getBoundingClientRect();const visible=e=>e.getBoundingClientRect().height>0;
      const rows=[...root.querySelectorAll('tr')].filter(visible).map(e=>{
        const r=e.getBoundingClientRect();return {text:e.innerText.replace(/\s+/g,' ').trim(),y:r.top-b.top,height:r.height,cells:e.cells.length};
      }).filter(r=>r.height<350);
      const modules=rows.filter(r=>/基本信息|团组成员|出访报告|审批意见|审核意见|出访单位|行政负责人|党委负责人|国合处|回访|公示|保险|证照信息|实际出境|本人签名/.test(r.text) && r.text.length<250);
      return {width:Math.ceil(b.width),height:Math.ceil(b.height),scrollWidth:root.scrollWidth,scrollHeight:root.scrollHeight,
        businessContent:root.querySelectorAll('td').length>4,rows,modules,errorText:/Required request parameter/.test(root.innerText)?'Required request parameter':''};
    });
    const options={animations:'disabled',caret:'hide',timeout:30000,style:`${chromeOnly}{visibility:hidden!important}`};
    const original=path.join(folder,'original/full-page.png'),full=path.join(folder,'full-page.png');
    await locator.screenshot({...options,path:original});
    await locator.screenshot({...options,path:full,mask:[frame.locator(maskSelector)],maskColor:'#E2E7EC'});
    const data=await fs.readFile(full);const width=data.readUInt32BE(16),height=data.readUInt32BE(20);
    const scale=width/metrics.width;
    const complete=metrics.scrollWidth<=metrics.width+3 && metrics.scrollHeight<=metrics.height+3 && Math.abs(height-metrics.height*scale)<4;
    const checks={...metrics,rows:undefined,modules:undefined,nodeId:meta.nodeId,complete,obscured:false,expandedContainers:layout.expanded};
    const images=[];
    const add=async item=>{const b=await fs.readFile(item.file);const image={...item,nodeId:meta.nodeId,width:b.readUInt32BE(16),height:b.readUInt32BE(20),bytes:b.length,sha256:createHash('sha256').update(b).digest('hex')};image.quality=screenshotValue(image,checks);images.push(image);};
    await add({file:original,category:'full-page',sourceVariant:'original'});
    await add({file:full,category:'full-page',sourceVariant:'masked',title:'完整表单布局',capture:'measured-business-element'});
    // Use actual table rows to align each business module, never arbitrary viewport scroll positions.
    const boundaries=[{y:0,text:'申请信息与基本资料'},...metrics.modules.filter(r=>r.y>60).map(r=>({y:Math.floor(r.y),text:r.text}))];
    const unique=boundaries.filter((r,i)=>i===0||r.y-boundaries[i-1].y>40);
    let number=0;
    for(let i=0;i<unique.length;i++) {
      const start=unique[i].y,end=i+1<unique.length?unique[i+1].y:metrics.height;
      if(end-start<45)continue;
      const label=unique[i].text.split(/[A-Za-z]/)[0].replace(/[\d*：:]/g,'').trim().slice(0,32)||'表单业务信息';
      const box={x:0,y:Math.round(start*scale),width,height:Math.min(height-Math.round(start*scale),Math.round((end-start)*scale))};
      const file=path.join(folder,`module-${String(++number).padStart(2,'0')}.png`);
      await cropEvidence(page,full,file,box);
      await add({file,category:'business-module',sourceVariant:'masked',parentImage:full,crop:box,title:label,purpose:label});
    }
    return {...meta,folder,images,pageChecks:checks,metrics:checks,source:meta.pageType==='historical-snapshot'?'同一 Debug 实例历史只读表单':'当前 Debug 表单只读采集',buttonsDetected:[],buttonDetectionNote:'完整表单图不含平台工具栏；实际办理按钮另按已有同实例证据核对'};
  } finally {
    for(const restore of restores.reverse()) await restore().catch(()=>{});
    await page.setViewportSize(originalViewport).catch(()=>{});
    await page.evaluate(p=>scrollTo(p.x,p.y),scroll).catch(()=>{});
  }
}
