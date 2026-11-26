const crypto=require('node:crypto');
const PREFIX='smi:moderation:v1:';
const K=s=>PREFIX+s;
const keyOk=s=>typeof s==='string'&&/^[a-z0-9_]+:\d+$/i.test(s);
const idOk=s=>typeof s==='string'&&/^(?:[1-9]\d{0,11}|[0-9a-f-]{36})$/.test(s);
const clean=s=>String(s??'').replace(/[\u0000-\u001f\u007f]/g,' ').trim();
const redisUrl=()=>process.env.UPSTASH_REDIS_REST_URL||process.env.KV_REST_API_URL||process.env.STORAG_KV_REST_API_URL;
const redisToken=()=>process.env.UPSTASH_REDIS_REST_TOKEN||process.env.KV_REST_API_TOKEN||process.env.STORAG_KV_REST_API_TOKEN;
function configured(){return !!(redisUrl()&&redisToken())}
async function redis(...cmd){
  if(!configured())throw Error('Redis не настроен');
  const r=await fetch(redisUrl(),{method:'POST',headers:{Authorization:'Bearer '+redisToken(),'Content-Type':'application/json'},body:JSON.stringify(cmd),signal:AbortSignal.timeout(10000)});
  const d=await r.json();if(!r.ok||d.error)throw Error('Ошибка хранилища');return d.result;
}
const parse=v=>typeof v==='string'?JSON.parse(v):v;
async function limit(key,max,seconds){
 const n=await redis('EVAL',"local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return n",1,K('limit:'+key),seconds);
 return Number(n)<=max;
}
function ip(req){return crypto.createHash('sha256').update(String(req.headers['x-vercel-forwarded-for']||req.headers['x-forwarded-for']||req.socket?.remoteAddress||'unknown').split(',')[0].trim()).digest('hex')}
function submissionFingerprint(data){const base=data.key+'\n'+clean(data.name).toLowerCase()+'\n'+clean(data.comment).toLowerCase()+'\n'+String(data.price??'')+'\n'+clean(data.rarity).toLowerCase();return crypto.createHash('sha256').update(base+(data.photoFingerprint?'\n'+data.photoFingerprint:'')).digest('hex')}
async function ensureNumbers(){
 await redis('EVAL',"if redis.call('EXISTS',KEYS[1])==1 then return 1 end; local ids=redis.call('ZRANGE',KEYS[2],0,-1); local n=0; for _,id in ipairs(ids) do n=n+1; redis.call('SET',ARGV[1]..id,tostring(n)); redis.call('SET',ARGV[2]..n,id); end; redis.call('SET',KEYS[1],n); return 1",2,K('sequence'),K('all'),K('number:'),K('legacy:'));
}
async function resolveId(id){if(!idOk(id))return null;await ensureNumbers();if(/^\d+$/.test(id))return await redis('GET',K('legacy:'+id))||id;return id}
async function numbered(r){if(!r)return null;return {...r,number:/^\d+$/.test(r.id)?Number(r.id):Number(await redis('GET',K('number:'+r.id)))||null}}
async function duplicateSubmission(data){const id=await redis('GET',K('dedup:'+submissionFingerprint(data)));if(!id)return null;await ensureNumbers();return /^\d+$/.test(id)?id:String(await redis('GET',K('number:'+id))||id)}
async function submit(data){
 await ensureNumbers();
 const createdAt=new Date().toISOString(),record={key:data.key,model:clean(data.model),category:clean(data.category),name:clean(data.name),comment:clean(data.comment),suggestedPrice:data.price??null,suggestedRarity:clean(data.rarity),photos:data.photos||[],createdAt,status:'pending'};
 const fingerprint=submissionFingerprint(data);
 const result=await redis('EVAL',"local old=redis.call('GET',KEYS[1]); if old then return {old,1} end; local id=tostring(redis.call('INCR',KEYS[2])); local row=cjson.decode(ARGV[1]); row.id=id; row.number=tonumber(id); redis.call('SET',ARGV[4]..id,cjson.encode(row)); redis.call('SET',ARGV[5]..id,ARGV[2]); redis.call('ZADD',KEYS[3],ARGV[3],id); redis.call('ZADD',KEYS[4],ARGV[3],id); redis.call('SET',KEYS[1],id,'EX',86400); return {id,0}",4,K('dedup:'+fingerprint),K('sequence'),K('all'),K('pending'),JSON.stringify(record),data.preview,Date.now(),K('row:'),K('png:'));
 const raw=String(result[0]),number=/^\d+$/.test(raw)?raw:String(await redis('GET',K('number:'+raw))||raw);
 return {id:number,duplicate:Number(result[1])===1};
}
async function row(id){const resolved=await resolveId(id);return resolved?numbered(parse(await redis('GET',K('row:'+resolved)))):null}
async function list(offset=0,mode='pending'){await ensureNumbers();const index=K(mode==='history'?'history':'pending');const ids=await redis('ZREVRANGE',index,offset,offset+19);const rows=ids.length?await redis('MGET',...ids.map(id=>K('row:'+id))):[];const parsed=rows.map(parse).filter(Boolean);const legacy=parsed.filter(r=>!(/^\d+$/.test(r.id)));const numbers=legacy.length?await redis('MGET',...legacy.map(r=>K('number:'+r.id))):[];const lookup=new Map(legacy.map((r,i)=>[r.id,Number(numbers[i])||null]));return {rows:parsed.map(r=>({...r,number:/^\d+$/.test(r.id)?Number(r.id):lookup.get(r.id)})),total:Number(await redis('ZCARD',index))}}
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
async function publish(row,fields,checkCatalog){
 for(let attempt=0;attempt<4;attempt++){
  const get=await github('GET');if(!get.ok)throw Error('Не удалось прочитать community-items.json: '+get.status);
  const db=JSON.parse(Buffer.from(get.data.content,'base64').toString('utf8'));if(!db.items||typeof db.items!=='object'||Array.isArray(db.items))throw Error('Неверный формат базы');
  const old=db.items[row.key];if(old?.sourceId===row.id)return old;
  if(checkCatalog)checkCatalog(db);
  if(old?.name?.trim())throw Error('Для этой модели уже есть название. Отклоните дубликат.');
  const entry={...old,name:fields.name,price:fields.price,rarity:fields.rarity,sourceId:row.id,updatedAt:new Date().toISOString()};
  db.items[row.key]=entry;db.history=db.history||{};audit(db,row.key,old,entry,'approve',entry.updatedAt);
  const put=await github('PUT',{message:'Data',branch:'main',sha:get.data.sha,content:Buffer.from(JSON.stringify(db,null,2)+'\n').toString('base64')});
  if(put.ok)return entry;if(![409,422].includes(put.status))throw Error('GitHub не сохранил название: '+put.status);
 }
 throw Error('База изменилась. Повторите одобрение.');
}

function decodeCommunity(get){
 if(!get.ok)throw Error('Не удалось прочитать community-items.json: '+get.status);
 const db=JSON.parse(Buffer.from(get.data.content,'base64').toString('utf8'));
 if(!db.items||typeof db.items!=='object'||Array.isArray(db.items))throw Error('Неверный формат базы');
 if(!db.history||typeof db.history!=='object'||Array.isArray(db.history))db.history={};
 return db;
}
async function community(){return decodeCommunity(await github('GET'))}
const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
function editorFields(input){
 if(!input||typeof input!=='object'||Array.isArray(input))throw Error('Неверные поля');
 const out={};
 for(const [k,v] of Object.entries(input)){
  if(k==='hidden'){if(typeof v!=='boolean')throw Error('Некорректная видимость');out[k]=v;continue}
  if(k==='price'){if(v!==null&&(!Number.isSafeInteger(v)||v<0||v>1000000000000))throw Error('Некорректная цена');out[k]=v;continue}
  const limits={name:100,rarity:50,category:80,subcategory:80,description:800};const max=own(limits,k)?limits[k]:0;
  if(!max||typeof v!=='string')throw Error('Неизвестное или некорректное поле: '+k);
  const val=clean(v);if(val.length>max||(k==='name'&&val.length===1))throw Error('Некорректная длина поля: '+k);
  out[k]=val;
 }
 return out;
}
function audit(db,key,before,after,action,at){
 const list=Array.isArray(db.history[key])?db.history[key]:[];
 list.push({at,action,before:before||null,after:after||null});
 db.history[key]=list.slice(-30);
}
async function editCatalog(request){
 if(!Array.isArray(request.changes)||!request.changes.length||request.changes.length>50)throw Error('Выберите от 1 до 50 предметов');
 const seen=new Set();
 const changes=request.changes.map(c=>{
  if(!c||!keyOk(c.key)||seen.has(c.key)||!(c.expected===null||typeof c.expected==='string'))throw Error('Некорректная запись');seen.add(c.key);
  if(c.restore===true)return {key:c.key,expected:c.expected,restore:true};
  const fields=editorFields(c.fields);if(!Object.keys(fields).length)throw Error('Нет изменений');
  return {key:c.key,expected:c.expected,fields};
 });
 for(let i=0;i<4;i++){
  const get=await github('GET'),db=decodeCommunity(get),at=new Date().toISOString(),updated={};
  for(const c of changes){
   const before=db.items[c.key]||null;
   if((before?.updatedAt||null)!==c.expected)throw Object.assign(Error('Предмет '+c.key+' уже изменён. Обновите каталог и повторите.'),{status:409});
   if(c.restore){if(before){delete db.items[c.key];audit(db,c.key,before,null,'restore',at)}updated[c.key]=null;continue}
   const after={...before,...c.fields,updatedAt:at};
   db.items[c.key]=after;audit(db,c.key,before,after,'edit',at);updated[c.key]=after;
  }
  const put=await github('PUT',{message:'Data',branch:'main',sha:get.data.sha,content:Buffer.from(JSON.stringify(db,null,2)+'\n').toString('base64')});
  if(put.ok)return {updated,history:Object.fromEntries(changes.map(c=>[c.key,db.history[c.key]||[]]))};
  if(![409,422].includes(put.status))throw Error('GitHub не сохранил изменения: '+put.status);
 }
 throw Object.assign(Error('База изменилась. Повторите сохранение.'),{status:409});
}

module.exports={K,redis,parse,clean,keyOk,idOk,configured,limit,ip,submit,duplicateSubmission,resolveId,row,list,lock,unlock,finish,secretOk,authenticated,login,logout,publish,previouslyPublished,community,editCatalog};