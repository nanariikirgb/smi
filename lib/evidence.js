const crypto=require('node:crypto');
const TTL=90*24*60*60,MAX_BYTES=450000,MAX_EDGE=1920;
function validatePhoto(value){
 if(typeof value!=='string'||value.length>Math.ceil(MAX_BYTES/3)*4+32||!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(value))throw Error('Допустимы только подготовленные JPEG-изображения до 450 КБ');
 const encoded=value.slice(23),b=Buffer.from(encoded,'base64');
 if(b.length>MAX_BYTES||b.length<16||b.toString('base64')!==encoded||b[0]!==255||b[1]!==216)throw Error('Некорректное JPEG-изображение');
 // Remove APP and COM metadata from every marker segment, including after scans.
 const chunks=[b.subarray(0,2)];let pos=2,width=0,height=0,scans=0,inScan=false;
 while(pos<b.length){
  if(inScan){const start=pos;while(pos<b.length){if(b[pos]!==255){pos++;continue}const mark=pos;while(pos<b.length&&b[pos]===255)pos++;if(pos>=b.length)throw Error('Повреждённый JPEG');const code=b[pos];if(code===0||(code>=208&&code<=215)){pos++;continue}pos=mark;break}chunks.push(b.subarray(start,pos));inScan=false;continue}
  if(b[pos]!==255)throw Error('Повреждённый JPEG');
  while(pos<b.length&&b[pos]===255)pos++;
  if(pos>=b.length)throw Error('Повреждённый JPEG');
  const marker=b[pos++],start=pos-2;
  if(marker===217){if(!width||!height||!scans)throw Error('Некорректное JPEG-изображение');chunks.push(Buffer.from([255,217]));return Buffer.concat(chunks)}
  if(marker===216||marker===0||marker===1||(marker>=208&&marker<=215)||pos+2>b.length)throw Error('Некорректный JPEG');
  const len=b.readUInt16BE(pos),end=pos+len;
  if(len<2||end>b.length)throw Error('Повреждённый JPEG');
  if([192,193,194].includes(marker)){if(len<8||width)throw Error('Некорректный JPEG');height=b.readUInt16BE(pos+3);width=b.readUInt16BE(pos+5);if(!width||!height||width>MAX_EDGE||height>MAX_EDGE)throw Error('Скриншот превышает допустимый размер')}
  else if((marker>=192&&marker<=207)&&![196,204].includes(marker))throw Error('Неподдерживаемый JPEG');
  if(marker===218){if(!width||++scans>64)throw Error('Некорректный JPEG');inScan=true}
  if(!(marker>=224&&marker<=239)&&marker!==254)chunks.push(b.subarray(start,end));
  pos=end;
 }
 throw Error('Повреждённый JPEG');
}
function validatePhotos(values){if(!Array.isArray(values)||values.length>3)throw Error('Можно прикрепить до трёх фотографий');return values.map(validatePhoto)}
function photoFingerprint(photos){return crypto.createHash('sha256').update(photos.map(b=>crypto.createHash('sha256').update(b).digest('hex')).join(':')).digest('hex')}
function validImageUrl(value){try{const u=new URL(value);return u.protocol==='https:'&&u.hostname==='i.ibb.co'&&!u.username&&!u.password&&!u.port&&u.pathname.length>1&&u.href.length<400}catch{return false}}
async function uploadPhotos(photos){
 if(!photos.length)return [];
 const key=process.env.IMGBB_API_KEY;if(!key)throw Error('Хранилище скриншотов ещё не подключено');
 return Promise.all(photos.map(async bytes=>{
  const url=new URL('https://api.imgbb.com/1/upload');url.searchParams.set('expiration',String(TTL));url.searchParams.set('key',key);
  const form=new FormData();form.append('image',bytes.toString('base64'));form.append('name','rpm-'+crypto.randomUUID());
  const response=await fetch(url,{method:'POST',body:form,signal:AbortSignal.timeout(15000),redirect:'error'});const result=await response.json();
  if(!response.ok||!result.success||!validImageUrl(result.data?.url))throw Error('Не удалось загрузить скриншот');
  return {url:result.data.url,expiresAt:new Date(Date.now()+TTL*1000).toISOString()};
 }));
}
module.exports={validatePhotos,photoFingerprint,uploadPhotos,validImageUrl,TTL};