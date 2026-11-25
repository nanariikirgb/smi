const crypto=require('node:crypto');
const PREFIX='smi:moderation:v1:';
const K=s=>PREFIX+s;
const keyOk=s=>typeof s==='string'&&/^[a-z0-9_]+:\d+$/i.test(s);
const idOk=s=>typeof s==='string'&&/^[0-9a-f-]{36}$/.test(s);
const clean=s=>String(s??'').replace(/[\u0000-\u001f\u007f]/g,' ').trim();
function configured(){return !!(process.env.UPSTASH_REDIS_REST_URL&&process.env.UPSTASH_REDIS_REST_TOKEN)}
async function redis(...cmd){
  if(!configured())throw Error('Redis не настроен');
  const r=await fetch(process.env.UPSTASH_REDIS_REST_URL,{method:'POST',headers:{Authorization:'Bearer '+process.env.UPSTASH_REDIS_REST_TOKEN,'Content-Type':'application/json'},body:JSON.stringify(cmd),signal:AbortSignal.timeout(10000)});
  const d=await r.json();if(!r.ok||d.error)throw Error('Ошибка хранилища');return d.result;
}
const parse=v=>typeof v==='string'?JSON.parse(v):v;
async function limit(key,max,seconds){
 const n=await redis('EVAL',"local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return n",1,K('limit:'+key),seconds);
 return Number(n)<=max;
}
function ip(req){return crypto.createHash('sha256').update(String(req.headers['x-vercel-forwarded-for']||req.headers['x-forwarded-for']||req.socket?.remoteAddress||'unknown').split(',')[0].trim()).digest('hex')}
async function submit(data){
 const id=crypto.randomUUID(),createdAt=new Date().toISOString();
 const row={id,key:data.key,model:clean(data.model),category:clean(data.category),name:clean(data.name),comment:clean(data.comment),createdAt,status:'pending'};
 const fingerprint=crypto.createHash('sha256').update(row.key+'\n'+row.name.toLowerCase()+'\n'+row.comment.toLowerCase()).digest('hex');
 const result=await redis('EVAL',"local old=redis.call('GET',KEYS[4]); if old then return old end; redis.call('SET',KEYS[1],ARGV[1]); redis.call('SET',KEYS[2],ARGV[2]); redis.call('ZADD',KEYS[3],ARGV[3],ARGV[4]); redis.call('ZADD',KEYS[5],ARGV[3],ARGV[4]); redis.call('SET',KEYS[4],ARGV[4],'EX',86400); return ARGV[4]",5,K('row:'+id),K('png:'+id),K('all'),K('dedup:'+fingerprint),K('pending'),JSON.stringify(row),data.preview,Date.now(),id);
 return {id:result,duplicate:result!==id};
}
async function row(id){return parse(await redis('GET',K('row:'+id)))}
async function list(offset=0,mode='pending'){const index=K(mode==='history'?'history':'pending');const ids=await redis('ZREVRANGE',index,offset,offset+19);const rows=ids.length?await redis('MGET',...ids.map(id=>K('row:'+id))):[];return {rows:rows.map(parse).filter(Boolean),total:Number(await redis('ZCARD',index))}}
async function lock(id){const token=crypto.randomUUID();return await redis('SET',K('lock:'+id),token,'NX','EX',90)==='OK'?token:null}
async function unlock(id,token){await redis('EVAL',"if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0",1,K('lock:'+id),token)}
async function finish(row,decision,token){const updated={...row,...decision,decidedAt:new Date().toISOString()};const ok=await redis('EVAL',"if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end; redis.call('SET',KEYS[2],ARGV[2]); redis.call('ZREM',KEYS[3],ARGV[3]); redis.call('ZADD',KEYS[4],ARGV[4],ARGV[3]); redis.call('DEL',KEYS[1]); return 1",4,K('lock:'+row.id),K('row:'+row.id),K('pending'),K('history'),token,JSON.stringify(updated),row.id,Date.now());if(!ok)throw Error('Блокировка истекла. Повторите действие.');return updated}
const sessionHash=t=>crypto.createHash('sha256').update(t).digest('hex');
function secretOk(password){const secret=process.env.ADMIN_PASSWORD||'';if(secret.length<16||typeof password!=='string'||password.length>256)return false;return crypto.timingSafeEqual(Buffer.from(sessionHash(password),'hex'),Buffer.from(sessionHash(secret),'hex'))}
function cookie(req){return (req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('smi_admin='))?.slice(10)||''}
async function authenticated(req){const token=cookie(req);return /^[a-f0-9]{64}$/.test(token)&&!!await redis('GET',K('session:'+sessionHash(token)))}
async function login(res){const token=crypto.randomBytes(32).toString('hex');await redis('SET',K('session:'+sessionHash(token)),'1','EX',28800);res.setHeader('Set-Cookie','smi_admin='+token+'; Path=/api/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=28800')}
async function logout(req,res){const t=cookie(req);if(/^[a-f0-9]{64}$/.test(t))await redis('DEL',K('session:'+sessionHash(t)));res.setHeader('Set-Cookie','smi_admin=; Path=/api/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=0')}
async function github(method,body){
 if(!process.env.GITHUB_CONTENTS_TOKEN)throw Error('GITHUB_CONTENTS_TOKEN не настроен');
 const r=await fetch('https://api.github.com/repos/nanariikirgb/smi/contents/data/community-items.json'+(method==='GET'?'?ref=main':''),{method,headers:{Authorization:'Bearer '+process.env.GITHUB_CONTENTS_TOKEN,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','Content-Type':'application/json','User-Agent':'smi-moderation'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10000)});
 const d=await r.json();return {status:r.status,data:d,ok:r.ok}
}
async function previouslyPublished(row){const get=await github('GET');if(!get.ok)throw Error('Не удалось проверить базу GitHub: '+get.status);const old=JSON.parse(Buffer.from(get.data.content,'base64').toString('utf8')).items?.[row.key];return old?.sourceId===row.id?old:null}
async function publish(row,fields){
 for(let attempt=0;attempt<4;attempt++){
  const get=await github('GET');if(!get.ok)throw Error('Не удалось прочитать community-items.json: '+get.status);
  const db=JSON.parse(Buffer.from(get.data.content,'base64').toString('utf8'));if(!db.items||typeof db.items!=='object'||Array.isArray(db.items))throw Error('Неверный формат базы');
  const old=db.items[row.key];if(old?.sourceId===row.id)return old;
  if(old)throw Error('Для этой модели уже одобрено другое название. Отклоните дубликат.');
  const entry={name:fields.name,price:fields.price,rarity:fields.rarity,sourceId:row.id,updatedAt:new Date().toISOString()};
  db.items[row.key]=entry;
  const put=await github('PUT',{message:'Approve community item '+row.key,branch:'main',sha:get.data.sha,content:Buffer.from(JSON.stringify(db,null,2)+'\n').toString('base64')});
  if(put.ok)return entry;if(![409,422].includes(put.status))throw Error('GitHub не сохранил название: '+put.status);
 }
 throw Error('База изменилась. Повторите одобрение.');
}
module.exports={K,redis,parse,clean,keyOk,idOk,configured,limit,ip,submit,row,list,lock,unlock,finish,secretOk,authenticated,login,logout,publish,previouslyPublished};