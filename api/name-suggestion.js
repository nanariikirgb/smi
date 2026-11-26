const moderation=require('../lib/moderation');
const evidence=require('../lib/evidence');
const discord=require('../lib/discord');
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
  if(!moderation.configured()&&!process.env.DISCORD_WEBHOOK_URL)return res.status(503).json({error:'Отправка ещё не настроена'});
  if(Number(req.headers['content-length']||0)>2600000)return res.status(413).json({error:'Слишком большой запрос'});
  let data=req.body;try{if(typeof data==='string')data=JSON.parse(data)}catch{return res.status(400).json({error:'Некорректный запрос'})}
  const {name,comment='',price=null,rarity='',key,model,category,preview,photos=[],honey=''}=data||{};
  let photoBytes;try{photoBytes=evidence.validatePhotos(photos)}catch(e){return res.status(400).json({error:e.message})}
  if(photoBytes.length&&(!moderation.configured()||!process.env.IMGBB_API_KEY))return res.status(503).json({error:'Хранилище скриншотов ещё не подключено. Можно отправить заявку без фотографий.'});
  if((price!==null&&(!Number.isSafeInteger(price)||price<0||price>1000000000000))||typeof rarity!=='string'||rarity.length>50)return res.status(400).json({error:'Проверьте цену и редкость'});
  if(honey||typeof name!=='string'||name.trim().length<2||name.trim().length>100||typeof comment!=='string'||comment.length>400||typeof key!=='string'||!/^[a-z0-9_]+:\d+$/i.test(key)||typeof model!=='string'||model.length>250||typeof category!=='string'||category.length>100||typeof preview!=='string'||!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(preview)||preview.length>700000)return res.status(400).json({error:'Проверьте название и изображение модели'});
  const png=Buffer.from(preview.slice(22),'base64');
  if(png.length<24||png.length>500000||!png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||png.readUInt32BE(16)!==240||png.readUInt32BE(20)!==240)return res.status(400).json({error:'Некорректное PNG-превью'});
  const now=Date.now(),ip=String(req.headers['x-forwarded-for']||req.socket?.remoteAddress||'unknown').split(',')[0].trim();
  for(const [k,v] of buckets)if(now-v.start>60000)buckets.delete(k);
  const bucket=buckets.get(ip)||{start:now,count:0};if(bucket.count>=3)return res.status(429).json({error:'Слишком много предложений. Попробуйте позже.'});bucket.count++;buckets.set(ip,bucket);
  let saved=null,uploaded=[];if(moderation.configured()){try{if(!await moderation.limit('submit:'+moderation.ip(req),3,60)||!await moderation.limit('submit-global',120,3600))return res.status(429).json({error:'Слишком много предложений. Попробуйте позже.'});const entry={name,comment,price,rarity,key,model,category,preview,...(photoBytes.length?{photoFingerprint:evidence.photoFingerprint(photoBytes)}:{})};const duplicate=await moderation.duplicateSubmission(entry);if(duplicate)return res.status(200).json({ok:true,id:duplicate,duplicate:true});if(photoBytes.length){if(!await moderation.limit('photos:'+moderation.ip(req),6,3600)||!await moderation.limit('photos-global',60,3600))return res.status(429).json({error:'Лимит заявок со скриншотами. Попробуйте позже.'});try{uploaded=await evidence.uploadPhotos(photoBytes)}catch{return res.status(502).json({error:'Не удалось загрузить фотографии. Попробуйте ещё раз.'})}}saved=await moderation.submit({...entry,photos:uploaded});}catch{return res.status(503).json({error:'Не удалось сохранить заявку. Попробуйте позже.'})}
  if(saved.duplicate)return res.status(200).json({ok:true,id:saved.id,duplicate:true});}
  if(!process.env.DISCORD_WEBHOOK_URL)return res.status(200).json({ok:true,id:saved.id,notified:false});
  const notification=await discord.send(discord.suggestion({name,comment,price,rarity,key,model,category,photos:uploaded,id:saved?.id}),{png});
  if(saved)return res.status(200).json({ok:true,id:saved.id,notified:notification.ok});
  if(!notification.ok)return res.status(notification.status===429?429:502).json({error:'Discord не принял предложение'});
  return res.status(200).json({ok:true,legacy:true});
};