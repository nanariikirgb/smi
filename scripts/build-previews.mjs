import {createServer} from 'node:http';
import {cp,mkdir,readFile,writeFile,stat} from 'node:fs/promises';
import {resolve,join,extname,sep} from 'node:path';
import {chromium} from 'playwright';
const root=process.cwd(),out=resolve(root,'_site'),generated=resolve(root,'.generated-previews');
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript','.json':'application/json','.zip':'application/zip','.png':'image/png'};
await mkdir(out,{recursive:true});await cp(join(root,'index.html'),join(out,'index.html'));await cp(join(root,'data'),join(out,'data'),{recursive:true});await writeFile(join(out,'.nojekyll'),'');
let cached=false;
try{const m=JSON.parse(await readFile(join(generated,'manifest.json'),'utf8'));cached=Array.isArray(m.ready)&&m.ready.length>0&&m.ready.length===m.expected-m.failed.length;if(cached){for(const k of m.ready)await stat(join(generated,k.replace(':','_')+'.png'));console.log('Restoring',m.ready.length,'generated previews')}}catch{cached=false}
if(!cached){
 await mkdir(generated,{recursive:true});
 const server=createServer(async(req,res)=>{try{const url=new URL(req.url,'http://127.0.0.1');const p=resolve(out,'.'+(url.pathname==='/'?'/index.html':decodeURIComponent(url.pathname)));if(!p.startsWith(out+sep))throw Error('bad path');const b=await readFile(p);res.writeHead(200,{'Content-Type':types[extname(p)]||'application/octet-stream','Content-Length':b.length});res.end(req.method==='HEAD'?undefined:b)}catch{res.writeHead(404);res.end()}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch({headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});try{
 const page=await browser.newPage();await page.route('https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',r=>r.fulfill({path:join(root,'node_modules/jszip/dist/jszip.min.js'),contentType:'text/javascript'}));
 page.on('pageerror',e=>console.error('Catalog page error:',e.message));
 await page.goto('http://127.0.0.1:'+server.address().port+'/?buildPreviews=1',{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>!!window.catalogBuild,null,{timeout:180000});
 const check=await page.evaluate(()=>{
  const texture=(overlay=false)=>{const c=document.createElement('canvas');c.width=c.height=4;const ctx=c.getContext('2d');if(!overlay){ctx.fillStyle='#0000ff';ctx.fillRect(0,0,4,4)}else{ctx.fillStyle='#ff0000';ctx.fillRect(2,2,2,2);ctx.fillStyle='rgba(0,255,0,.5)';ctx.fillRect(2,0,2,2)}return c};
  const face=(textureKey,z)=>({textureKey,p:[[-24,-24,z],[24,-24,z],[24,24,z],[-24,24,z]],uv:[0,0,16,16],rotation:0,depth:z});
  const rendered=drawNative([face('front',1),face('back',0)],new Map([['front',texture(true)],['back',texture()]]),64,1,0,0,0,1);
  if(!rendered)throw Error('Native WebGL renderer unavailable');
  const ctx=rendered.getContext('2d'),pixel=(x,y)=>Array.from(ctx.getImageData(x,y,1,1).data);
  const hole=pixel(20,32),solid=pixel(44,44),blend=pixel(44,20);
  if(hole[2]<240||hole[0]>15||solid[0]<240||solid[2]>15||blend[1]<100||blend[2]<100||blend[3]<240)throw Error('Depth/alpha regression: '+JSON.stringify({hole,solid,blend}));
  return {hole,solid,blend};
 });
 console.log('Native WebGL depth and transparency check passed',JSON.stringify(check));
 const info=await page.evaluate(()=>window.catalogBuild.manifest());if(!info.digest||!info.keys.length)throw Error('Catalog build failed');
 const ready=[],failed=[];let done=0;
 for(const key of info.keys){
  if(!/^[a-z0-9_]+:\d+$/.test(key)){failed.push(key);continue}
  try{const image=await page.evaluate(k=>window.catalogBuild.preview(k),key);if(typeof image!=='string'||!image.startsWith('data:image/png;base64,'))throw Error('No preview');const bytes=Buffer.from(image.slice(22),'base64');if(bytes.length>500000)throw Error('Preview too large');await writeFile(join(generated,key.replace(':','_')+'.png'),bytes);ready.push(key)}catch(e){failed.push(key);if(failed.length<=15)console.warn(key,e.message)}
  if(++done%250===0)console.log('Rendered',done,'/',info.keys.length);
 }
 if(!ready.length)throw Error('No previews generated');const {keys,...manifest}=info;await writeFile(join(generated,'manifest.json'),JSON.stringify({...manifest,ready,expected:keys.length,failed}));console.log('Generated',ready.length,'/',keys.length,'failed',failed.length);
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve))}
}
await cp(generated,join(out,'data/previews'),{recursive:true});console.log('Static public artifact:',out);
