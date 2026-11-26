const ADMIN='https://smi-pearl.vercel.app/admin.html';
const EDITOR='https://smi-pearl.vercel.app/?edit=1';
const shortId=id=>String(id||'').split('-')[0].toUpperCase();
const safe=value=>String(value??'').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/[\\*_~|\x60<>#\[\]]/g,'\\$&').slice(0,900)||'—';
const price=v=>v==null?'—':String(v).replace(/\B(?=(\d{3})+(?!\d))/g,'.')+'$';
const text=content=>({type:10,content});
const separator=()=>({type:14,divider:true,spacing:1});
const gallery=urls=>({type:12,items:urls.map(url=>({media:{url}}))});
const buttons=(label,url)=>({type:1,components:[{type:2,style:5,label,url}]});
const payload=(components,color=0xb4a3ff)=>({flags:32768,allowed_mentions:{parse:[]},components:[{type:17,accent_color:color,components}]});
function suggestion(data){
 const {name,category,key,model,comment,rarity,photos=[],id}=data;
 const content=['## Новое предложение'+(id?' · #'+shortId(id):''),'**Название:** '+safe(name),'**Категория:** '+safe(category),'**Материал / CMD:** '+safe(key),'**Модель:** '+safe(model),...(data.price!=null?['**Гос. цена:** '+price(data.price)]:[]),...(rarity?['**Редкость:** '+safe(rarity)]:[]),...(comment?['**Комментарий:** '+safe(comment)]:[])].join('\n');
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
  let body,headers;if(options.png){body=new FormData();body.append('payload_json',JSON.stringify(value));body.append('files[0]',new Blob([options.png],{type:'image/png'}),'model.png')}else{body=JSON.stringify(value);headers={'Content-Type':'application/json'}}
  const response=await fetch(url,{method:'POST',body,headers,signal:AbortSignal.timeout(7000),redirect:'error'});
  if(!response.ok)console.warn('Discord webhook status',response.status);
  return {ok:response.ok,status:response.status,configured:true};
 }catch{console.warn('Discord webhook delivery failed');return {ok:false,status:0,configured:true}}
}
function decisionLog(row){const approved=row.status==='approved';return payload([text('## '+(approved?'Заявка одобрена':'Заявка отклонена')+' · #'+shortId(row.id)),separator(),text('**Предмет:** '+safe(row.approvedName||row.name)+'\n**ID:** '+safe(row.key)+(approved?'\n**Гос. цена:** '+price(row.price)+'\n**Редкость:** '+safe(row.rarity):'\n**Причина:** '+safe(row.reason))),buttons('Открыть заявку',ADMIN+'?id='+encodeURIComponent(row.id))],approved?0x62c48c:0xe47787)}
const labels={name:'Название',price:'Гос. цена',rarity:'Редкость',category:'Категория',subcategory:'Подкатегория',description:'Описание',hidden:'Скрыт'};
const display=(k,v)=>v===undefined?'Исходное значение':k==='price'?price(v):k==='hidden'?(v?'Да':'Нет'):safe(v);
function editLog(result){const keys=Object.keys(result.updated||{});const records=keys.map(key=>{const row=result.history?.[key]?.at(-1);if(!row||!result.updated[key]&&row.action!=='restore')return '**'+safe(key)+'** — без изменений';const before=row.before||{},after=row.after||{};const diff=Object.keys(labels).filter(k=>before[k]!==after[k]).map(k=>labels[k]+': '+display(k,before[k])+' → '+display(k,after[k])).join('\n');const action=row.action==='restore'?'Восстановление':!row.before?'Добавление данных':after.hidden===true&&before.hidden!==true?'Скрытие':after.hidden===false&&before.hidden===true?'Возврат в каталог':'Редактирование';return '**'+safe(key)+' · '+action+'**\n'+(diff||'Данные сохранены')});const content=records.join('\n\n');return payload([text('## Изменение каталога · '+keys.length+' предмет(ов)'),separator(),text(content.length>3200?content.slice(0,3100)+'\n… Остальные изменения в истории каталога.':content||'Нет изменений'),buttons('Редактор каталога',EDITOR)],0xb4a3ff)}
module.exports={shortId,suggestion,send,decisionLog,editLog};