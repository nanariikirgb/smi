const m=require('../lib/moderation');
const discord=require('../lib/discord');
const analytics=require('../lib/analytics');
const gameItems=require('../lib/game-items');
module.exports=async function(req,res){
 res.setHeader('Cache-Control','no-store, private');res.setHeader('X-Content-Type-Options','nosniff');
 const fail=(s,error)=>res.status(s).json({error});
 const action=String(req.query?.action||'');
 try{
  if(!m.configured()||!(process.env.ADMIN_PASSWORD||'').length||!process.env.GITHUB_CONTENTS_TOKEN)return fail(503,'Админ-панель ещё не настроена');
  if(req.method==='POST'&&req.headers.origin!==(process.env.ADMIN_ORIGIN||'https://smi-pearl.vercel.app'))return fail(403,'Недопустимый источник');
  if(req.method==='POST'&&!String(req.headers['content-type']||'').startsWith('application/json'))return fail(415,'Требуется JSON');
  let data=req.body||{};if(typeof data==='string'){try{data=JSON.parse(data)}catch{return fail(400,'Некорректный JSON')}}
  if(action==='login'&&req.method==='POST'){
   if(!await m.limit('login:'+m.ip(req),5,600))return fail(429,'Слишком много попыток. Повторите через 10 минут.');
   if(!m.secretOk(data.password))return fail(401,'Неверный пароль');
   await m.login(res);return res.json({ok:true});
  }
  if(!await m.authenticated(req))return fail(401,'Войдите в админ-панель');
  if(req.method==='POST'&&action==='logout'){await m.logout(req,res);return res.json({ok:true})}
  if(req.method==='GET'&&action==='game-list'){
   const offset=Math.max(0,Math.floor(Number(req.query.offset)||0));
   if(!Number.isSafeInteger(offset))return fail(400,'Некорректная страница');
   return res.json(await gameItems.list(offset,req.query.mode));
  }
  if(req.method==='POST'&&(action==='game-approve'||action==='game-reject')){
   return res.json({ok:true,row:await gameItems.decide(action,data)});
  }
  if(req.method==='GET'&&action==='analytics')return res.json(await analytics.report(req.query.days));
  if(req.method==='GET'&&action==='session')return res.json({ok:true});
  if(req.method==='GET'&&action==='catalog'){const db=await m.community();return res.json({items:db.items})}
  if(req.method==='GET'&&action==='item-history'){const key=req.query.key;if(!m.keyOk(key))return fail(400,'Неверная модель');const db=await m.community();return res.json({history:db.history[key]||[],current:db.items[key]||null})}
  if(req.method==='POST'&&action==='edit-catalog'){
   if(Number(req.headers['content-length']||0)>100000)return fail(413,'Слишком большой запрос');
   if(!await m.limit('catalog-edit:'+m.ip(req),30,60))return fail(429,'Слишком много изменений');
   const result=await m.editCatalog(data);const names=Object.create(null);for(const key of Object.keys(result.updated||{})){const value=data.names?.[key];if(typeof value==='string')names[key]=m.clean(value).slice(0,100)}let notification={ok:false};try{const files=await discord.editPreviews(result,names);notification=await discord.send(discord.editLog(result,files,names),{log:true,files})}catch{console.warn('Catalog edit log delivery failed')}return res.json({ok:true,...result,logNotified:notification.ok});
  }
  if(req.method==='GET'&&action==='submission'){const id=req.query.id;if(!m.idOk(id))return fail(400,'Неверный ID');const row=await m.row(id);return row?res.json({row}):fail(404,'Заявка не найдена')}
  if(req.method==='GET'&&action==='list'){const offset=Math.min(100000,Math.max(0,Math.floor(Number(req.query.offset)||0)));return res.json(await m.list(offset,req.query.mode==='history'?'history':'pending'))}
  if(req.method==='GET'&&action==='preview'){
   const id=req.query.id;if(!m.idOk(id))return fail(400,'Неверный ID');
   const resolved=await m.resolveId(id);const p=await m.redis('GET',m.K('png:'+resolved));if(!p)return fail(404,'Изображение отсутствует');
   res.setHeader('Content-Type','image/png');return res.status(200).send(Buffer.from(p.slice(22),'base64'));
  }
  if(req.method==='POST'&&['approve','reject'].includes(action)){
   const requestId=String(data.id??'');if(!m.idOk(requestId))return fail(400,'Неверный ID');const id=await m.resolveId(requestId);
   const token=await m.lock(id);if(!token)return fail(409,'Заявка уже обрабатывается');
   try{
    const row=await m.row(id);if(!row)return fail(404,'Заявка не найдена');
    if(row.status!=='pending')return fail(409,'Заявка уже рассмотрена');
    let decision;
    if(action==='approve'){
     const name=m.clean(data.name),rarity=m.clean(data.rarity),price=data.price===null||data.price===''||data.price===undefined?null:Number(data.price);
     if(name.length<2||name.length>100||rarity.length>50||(price!==null&&(!Number.isSafeInteger(price)||price<0||price>1000000000000)))return fail(400,'Проверьте название, цену и редкость');
     const entry=await m.publish(row,{name,price,rarity});
     decision={status:'approved',approvedName:entry.name,price:entry.price,rarity:entry.rarity};
    }else {const entry=await m.previouslyPublished(row);decision=entry?{status:'approved',approvedName:entry.name,price:entry.price,rarity:entry.rarity}:{status:'rejected',reason:m.clean(data.reason).slice(0,400)}};
    const finished=await m.finish(row,decision,token);let png;try{const saved=await m.redis('GET',m.K('png:'+finished.id));if(typeof saved==='string'&&saved.startsWith('data:image/png;base64,'))png=Buffer.from(saved.slice(22),'base64')}catch{}const notification=await discord.send(discord.decisionLog(finished,!!png),{log:true,png});return res.json({ok:true,row:finished,logNotified:notification.ok});
   }finally{await m.unlock(id,token)}
  }
  return fail(405,'Неизвестное действие');
 }catch(e){console.error('Moderation error',e.message);return fail(e.status||500,e.message||'Ошибка сервера')}
};