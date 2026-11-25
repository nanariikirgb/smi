const buckets=new Map();
module.exports=async function(req,res){
  const origin=req.headers.origin||'';
  const allowed='https://nanariikirgb.github.io';
  const sameOrigin='https://'+req.headers.host;
  if(origin===allowed||origin===sameOrigin){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin')}
  res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type');res.setHeader('Cache-Control','no-store');
  if(origin!==allowed&&origin!==sameOrigin)return res.status(403).json({error:'Недопустимый источник запроса'});
  if(req.method==='OPTIONS')return res.status(204).end();
  if(req.method!=='POST')return res.status(405).json({error:'Требуется POST'});
  if(!process.env.DISCORD_WEBHOOK_URL)return res.status(503).json({error:'Отправка ещё не настроена'});
  if(Number(req.headers['content-length']||0)>1000000)return res.status(413).json({error:'Слишком большой запрос'});
  let data=req.body;try{if(typeof data==='string')data=JSON.parse(data)}catch{return res.status(400).json({error:'Некорректный запрос'})}
  const {name,comment='',key,model,category,preview,honey=''}=data||{};
  if(honey||typeof name!=='string'||name.trim().length<2||name.trim().length>100||typeof comment!=='string'||comment.length>400||typeof key!=='string'||!/^[a-z0-9_]+:\d+$/i.test(key)||typeof model!=='string'||model.length>250||typeof category!=='string'||category.length>100||typeof preview!=='string'||!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(preview)||preview.length>700000)return res.status(400).json({error:'Проверьте название и изображение модели'});
  const png=Buffer.from(preview.slice(22),'base64');
  if(png.length<24||png.length>500000||!png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||png.readUInt32BE(16)!==240||png.readUInt32BE(20)!==240)return res.status(400).json({error:'Некорректное PNG-превью'});
  const now=Date.now(),ip=String(req.headers['x-forwarded-for']||req.socket?.remoteAddress||'unknown').split(',')[0].trim();
  for(const [k,v] of buckets)if(now-v.start>60000)buckets.delete(k);
  const bucket=buckets.get(ip)||{start:now,count:0};if(bucket.count>=3)return res.status(429).json({error:'Слишком много предложений. Попробуйте позже.'});bucket.count++;buckets.set(ip,bucket);
  const safe=s=>String(s).replace(/[\u0000-\u001f\u007f]/g,' ').trim();
  const payload={allowed_mentions:{parse:[]},embeds:[{title:'Новое предложение названия',color:11839487,fields:[{name:'Предложенное название',value:safe(name)},{name:'Категория',value:safe(category)||'—',inline:true},{name:'Материал / CMD',value:safe(key),inline:true},{name:'Модель',value:safe(model)||'—'},...(comment.trim()?[{name:'Комментарий',value:safe(comment)}]:[])],image:{url:'attachment://model.png'},timestamp:new Date().toISOString()}]};
  const form=new FormData();form.append('payload_json',JSON.stringify(payload));form.append('files[0]',new Blob([png],{type:'image/png'}),'model.png');
  try{const url=new URL(process.env.DISCORD_WEBHOOK_URL);if(url.protocol!=='https:'||url.hostname!=='discord.com'||!/^\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/.test(url.pathname))throw Error('Invalid webhook configuration');url.searchParams.set('wait','true');const response=await fetch(url,{method:'POST',body:form,signal:AbortSignal.timeout(10000)});if(!response.ok)return res.status(response.status===429?429:502).json({error:'Discord не принял предложение. Попробуйте позже.'});return res.status(200).json({ok:true})}catch{return res.status(502).json({error:'Не удалось отправить предложение'})}
};