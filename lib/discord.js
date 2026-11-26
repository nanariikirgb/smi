const ADMIN='https://smi-pearl.vercel.app/admin.html';
const EDITOR='https://smi-pearl.vercel.app/?edit=1';
const shortId=id=>String(id||'').split('-')[0].toUpperCase();const requestNumber=row=>String(row.number||shortId(row.id));
const safe=value=>String(value??'').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/[\\*_~|\x60<>#\[\]]/g,'\\$&').slice(0,900)||'—';
const price=v=>v==null?'—':String(v).replace(/\B(?=(\d{3})+(?!\d))/g,'.')+'$';
const text=content=>({type:10,content});
const separator=()=>({type:14,divider:true,spacing:1});
const gallery=urls=>({type:12,items:urls.map(url=>({media:{url}}))});
const buttons=(label,url)=>({type:1,components:[{type:2,style:5,label,url}]});
const payload=(components,color=0xb4a3ff)=>({flags:32768,allowed_mentions:{parse:[]},components:[{type:17,accent_color:color,components}]});
function suggestion(data){
 const {name,category,key,model,comment,rarity,photos=[],id}=data;
 const content=['## Новое предложение'+(id?' · Заявка №'+shortId(id):''),'**Название:** '+safe(name),'**Категория:** '+safe(category),...(data.price!=null?['**Гос. цена:** '+price(data.price)]:[]),...(rarity?['**Редкость:** '+safe(rarity)]:[]),...(comment?['**Комментарий:** '+safe(comment)]:[])].join('\n');
 const components=[gallery(['attachment://model.png']),separator(),text(content),buttons('Открыть заявку',ADMIN+(id?'?id='+encodeURIComponent(id):''))];
 if(photos.length)components.push(separator(),gallery(photos.slice(0,3).map(p=>p.url)));
 return {...payload(components),attachments:[{id:0,filename:'model.png'}]};
}
async function send(value,options={}){
 const raw=options.log?(process.env.DISCORD_LOG_WEBHOOK_URL||process.env.DISCORD_WEBHOOK_URL):process.env.DISCORD_WEBHOOK_URL;
 if(!raw)return {ok:false,status:0,configured:false};
 try{
  const url=new URL(raw);if(url.protocol!=='https:'||url.hostname!=='discord.com'||url.port||url.username||url.password||!/^\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/.test(url.pathname))throw Error('Invalid webhook');
  url.searchParams.set('wait','true');url.searchParams.set('with_components','true');
  let body,headers;const files=options.files||(options.png?[{name:'model.png',bytes:options.png}]:[]);if(files.length){body=new FormData();body.append('payload_json',JSON.stringify(value));for(const [i,file] of files.entries())body.append('files['+i+']',new Blob([file.bytes],{type:'image/png'}),file.name)}else{body=JSON.stringify(value);headers={'Content-Type':'application/json'}}
  const response=await fetch(url,{method:'POST',body,headers,signal:AbortSignal.timeout(7000),redirect:'error'});
  if(!response.ok)console.warn('Discord webhook status',response.status);
  return {ok:response.ok,status:response.status,configured:true};
 }catch{console.warn('Discord webhook delivery failed');return {ok:false,status:0,configured:true}}
}
function decisionLog(row,hasPreview=false){const approved=row.status==='approved';const components=[...(hasPreview?[gallery(['attachment://model.png']),separator()]:[]),text('## Заявка №'+requestNumber(row)+(approved?' одобрена':' отклонена')),separator(),text('**Предмет:** '+safe(row.approvedName||row.name)+(approved?'\n**Гос. цена:** '+price(row.price)+'\n**Редкость:** '+safe(row.rarity):'\n**Причина:** '+safe(row.reason))),buttons('Открыть заявку',ADMIN+'?id='+encodeURIComponent(row.number||row.id))];return {...payload(components,approved?0x62c48c:0xe47787),...(hasPreview?{attachments:[{id:0,filename:'model.png'}]}:{})}}
const labels={name:'Название',price:'Гос. цена',rarity:'Редкость',category:'Категория',subcategory:'Подкатегория',description:'Описание',hidden:'Скрыт'};
const display=(k,v)=>v===undefined?'Исходное значение':k==='price'?price(v):k==='hidden'?(v?'Да':'Нет'):safe(v);
const PREVIEW_ROOT='https://nanariikirgb.github.io/smi/data/previews/';
const countWord=n=>n%100>=11&&n%100<=14?'предметов':n%10===1?'предмет':[2,3,4].includes(n%10)?'предмета':'предметов';
function editName(result,key,index,names={}){const row=result.history?.[key]?.at(-1);return row?.after?.name||row?.before?.name||names[key]||'Предмет '+(index+1)}
async function editPreviews(result,names={}){
 const keys=Object.keys(result.updated||{}).slice(0,10);
 const files=await Promise.all(keys.map(async(key,index)=>{
  if(!/^[a-z0-9_]+:\d+$/i.test(key))return null;
  try{
   const response=await fetch(PREVIEW_ROOT+encodeURIComponent(key.replace(':','_'))+'.png',{signal:AbortSignal.timeout(3500),redirect:'error'});
   if(!response.ok||!/^image\/png(?:;|$)/i.test(response.headers.get('content-type')||'')||Number(response.headers.get('content-length')||0)>500000||!response.body)return null;
   const reader=response.body.getReader(),chunks=[];let length=0;
   while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>500000){await reader.cancel();return null}chunks.push(Buffer.from(value))}
   const bytes=Buffer.concat(chunks);if(bytes.length<24||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return null;
   return {name:'item-'+(index+1)+'.png',bytes,description:editName(result,key,index,names).slice(0,100)};
  }catch{return null}
 }));
 return files.filter(Boolean);
}
function editLog(result,files=[],names={}){
 const keys=Object.keys(result.updated||{});
 const records=keys.map((key,index)=>{
  const row=result.history?.[key]?.at(-1),name=safe(editName(result,key,index,names));
  if(!row||(!result.updated[key]&&row.action!=='restore'))return '**'+name+'** — без изменений';
  const before=row.before||{},after=row.after||{};
  const diff=Object.keys(labels).filter(k=>before[k]!==after[k]).map(k=>labels[k]+': '+display(k,before[k])+' → '+display(k,after[k])).join('\n');
  const action=row.action==='restore'?'Восстановление':!row.before?'Добавление данных':after.hidden===true&&before.hidden!==true?'Скрытие':after.hidden===false&&before.hidden===true?'Возврат в каталог':'Редактирование';
  return '**'+name+' · '+action+'**\n'+(diff||'Данные сохранены');
 });
 const content=records.join('\n\n'),components=[];
 if(files.length)components.push({type:12,items:files.map(file=>({media:{url:'attachment://'+file.name},description:file.description}))},separator());
 components.push(text('## Изменение каталога · '+keys.length+' '+countWord(keys.length)),separator(),text(content.length>3200?content.slice(0,3100)+'\n… Остальные изменения в истории каталога.':content||'Нет изменений'));
 if(keys.length>10)components.push(text('-# Галерея: до 10 первых предметов.'));
 components.push(buttons('Редактор каталога',EDITOR));
 return {...payload(components,0xb4a3ff),...(files.length?{attachments:files.map((f,i)=>({id:i,filename:f.name}))}:{})};
}
function gameDecisionLog(row,files=[]){
 const approved=row.status==='approved',name=row.approvedName||row.name;
 const content=['**Предмет:** '+safe(name)];
 if(approved){
  if(row.name!==name)content.push('**Название из игры:** '+safe(row.name));
  content.push('**Гос. цена:** '+price(row.price),'**Редкость:** '+safe(row.rarity));
 }else{
  content.push('**Гос. цена из игры:** '+price(row.suggestedPrice),'**Редкость из игры:** '+safe(row.suggestedRarity));
  if(row.reason)content.push('**Причина:** '+safe(row.reason));
 }
 const components=[];
 if(files.length)components.push({type:12,items:files.map(file=>({media:{url:'attachment://'+file.name},description:file.description}))},separator());
 components.push(text(approved?'## RPM Archive Sync · Предмет добавлен в каталог':'## RPM Archive Sync · Предмет отклонён'),separator(),text(content.join('\n')),buttons('Открыть админ-панель',ADMIN));
 return {...payload(components,approved?0x62c48c:0xe47787),...(files.length?{attachments:files.map((f,i)=>({id:i,filename:f.name}))}:{})};
}
module.exports={shortId,suggestion,send,decisionLog,editLog,editPreviews,gameDecisionLog};