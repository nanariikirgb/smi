const SITE_ORIGIN = "https://nanariikirgb.github.io";
const buckets = new Map();
const cors = {"Access-Control-Allow-Origin": SITE_ORIGIN,"Access-Control-Allow-Methods":"POST, OPTIONS","Access-Control-Allow-Headers":"Content-Type","Vary":"Origin","Cache-Control":"no-store"};
const reply = (status,data) => new Response(JSON.stringify(data),{status,headers:{...cors,"Content-Type":"application/json; charset=utf-8"}});
export default {
  async fetch(request, env) {
    if(request.method==="GET")return reply(200,{ok:true,service:"SMI SOUTH",configured:!!env.DISCORD_WEBHOOK_URL});
    if(request.headers.get("Origin")!==SITE_ORIGIN)return reply(403,{error:"Недопустимый источник"});
    if(request.method==="OPTIONS")return new Response(null,{status:204,headers:cors});
    if(request.method!=="POST")return reply(405,{error:"Требуется POST"});
    if(!env.DISCORD_WEBHOOK_URL)return reply(503,{error:"Сервис ещё не настроен"});
    if(!request.headers.get("Content-Type")?.startsWith("application/json"))return reply(415,{error:"Неверный формат"});
    const ip=request.headers.get("CF-Connecting-IP")||"unknown", now=Date.now();
    for(const [k,v] of buckets)if(now-v.start>60000)buckets.delete(k);
    const bucket=buckets.get(ip)||{start:now,count:0};
    if(bucket.count>=3)return reply(429,{error:"Слишком много запросов. Попробуйте позже."});
    bucket.count++;buckets.set(ip,bucket);
    if(env.RATE_LIMITER){const limit=await env.RATE_LIMITER.limit({key:ip});if(!limit.success)return reply(429,{error:"Слишком много запросов"});}
    if(Number(request.headers.get("Content-Length")||0)>1000000)return reply(413,{error:"Запрос слишком большой"});
    let data;
    try{const reader=request.body?.getReader();if(!reader)return reply(400,{error:"Пустой запрос"});const decoder=new TextDecoder();let text="",size=0;while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>1000000){await reader.cancel();return reply(413,{error:"Запрос слишком большой"})}text+=decoder.decode(value,{stream:true})}text+=decoder.decode();data=JSON.parse(text)}catch{return reply(400,{error:"Некорректный запрос"})}
    const {name,comment="",key,model,category,preview,honey=""}=data||{};
    if(honey||typeof name!=="string"||name.trim().length<2||name.trim().length>100||typeof comment!=="string"||comment.length>400||typeof key!=="string"||!/^[a-z0-9_]+:\d+$/i.test(key)||typeof model!=="string"||model.length>250||typeof category!=="string"||category.length>100||typeof preview!=="string"||preview.length>700000||!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(preview))return reply(400,{error:"Проверьте название и изображение модели"});
    let png;try{png=Uint8Array.from(atob(preview.slice(22)),c=>c.charCodeAt(0))}catch{return reply(400,{error:"Некорректное изображение"})}
    const sig=[137,80,78,71,13,10,26,10];if(png.length<24||png.length>500000||!sig.every((v,i)=>png[i]===v))return reply(400,{error:"Некорректное PNG"});
    const dv=new DataView(png.buffer);if(dv.getUint32(16)!==240||dv.getUint32(20)!==240)return reply(400,{error:"Неверный размер превью"});
    const safe=s=>String(s).replace(/[\u0000-\u001f\u007f]/g," ").trim();
    const fields=[{name:"Предложенное название",value:safe(name)},{name:"Категория",value:safe(category)||"—",inline:true},{name:"Материал / CMD",value:safe(key),inline:true},{name:"Модель",value:safe(model)||"—"}];if(safe(comment))fields.push({name:"Комментарий",value:safe(comment)});
    const payload={allowed_mentions:{parse:[]},embeds:[{title:"Новое предложение названия",color:11839487,fields,image:{url:"attachment://model.png"},timestamp:new Date().toISOString()}]};
    const form=new FormData();form.append("payload_json",JSON.stringify(payload));form.append("files[0]",new Blob([png],{type:"image/png"}),"model.png");
    try{const url=new URL(env.DISCORD_WEBHOOK_URL);if(url.protocol!=="https:"||url.hostname!=="discord.com"||!/^\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/.test(url.pathname))throw Error("Invalid configuration");url.searchParams.set("wait","true");const r=await fetch(url,{method:"POST",body:form,signal:AbortSignal.timeout(10000),redirect:"error"});if(!r.ok)return reply(r.status===429?429:502,{error:"Discord не принял предложение"});return reply(200,{ok:true})}catch{return reply(502,{error:"Не удалось отправить предложение"})}
  }
};