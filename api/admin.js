const m=require('../lib/moderation');
module.exports=async function(req,res){
 res.setHeader('Cache-Control','no-store, private');res.setHeader('X-Content-Type-Options','nosniff');
 const fail=(s,error)=>res.status(s).json({error});
 const action=String(req.query?.action||'');
 try{
  if(!m.configured()||!(process.env.ADMIN_PASSWORD||'').length||!process.env.GITHUB_CONTENTS_TOKEN)return fail(503,'Админ-панель ещё не настроена');
  if(req.method==='POST'&&req.headers.origin!=='https://smi-pearl.vercel.app')return fail(403,'Недопустимый источник');
  if(req.method==='POST'&&!String(req.headers['content-type']||'').startsWith('application/json'))return fail(415,'Требуется JSON');
  let data=req.body||{};if(typeof data==='string'){try{data=JSON.parse(data)}catch{return fail(400,'Некорректный JSON')}}
  if(action==='login'&&req.method==='POST'){
   if(!await m.limit('login:'+m.ip(req),5,600))return fail(429,'Слишком много попыток. Повторите через 10 минут.');
   if(!m.secretOk(data.password))return fail(401,'Неверный пароль');
   await m.login(res);return res.json({ok:true});
  }
  if(!await m.authenticated(req))return fail(401,'Войдите в админ-панель');
  if(req.method==='POST'&&action==='logout'){await m.logout(req,res);return res.json({ok:true})}
  if(req.method==='GET'&&action==='list'){const offset=Math.min(100000,Math.max(0,Math.floor(Number(req.query.offset)||0)));return res.json(await m.list(offset,req.query.mode==='history'?'history':'pending'))}
  if(req.method==='GET'&&action==='preview'){
   const id=req.query.id;if(!m.idOk(id))return fail(400,'Неверный ID');
   const p=await m.redis('GET',m.K('png:'+id));if(!p)return fail(404,'Изображение отсутствует');
   res.setHeader('Content-Type','image/png');return res.status(200).send(Buffer.from(p.slice(22),'base64'));
  }
  if(req.method==='POST'&&['approve','reject'].includes(action)){
   const id=data.id;if(!m.idOk(id))return fail(400,'Неверный ID');
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
    return res.json({ok:true,row:await m.finish(row,decision,token)});
   }finally{await m.unlock(id,token)}
  }
  return fail(405,'Неизвестное действие');
 }catch(e){console.error('Moderation error',e.message);return fail(500,e.message||'Ошибка сервера')}
};