import { nextReward } from './rewards.js';
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './config.js';
export const sb=createClient(SUPABASE_URL,SUPABASE_PUBLISHABLE_KEY);
const matamoros='America/Matamoros';
export const formatMatamorosDate=s=>s?new Intl.DateTimeFormat('es-MX',{timeZone:matamoros,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(s)):'';
export const formatMatamorosTime=s=>new Intl.DateTimeFormat('es-MX',{timeZone:matamoros,hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(new Date(s));
export const formatMatamorosDateTime=s=>s?new Intl.DateTimeFormat('es-MX',{timeZone:matamoros,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(s)):'';
export function notice(message){
 let el=document.getElementById('appNotice');
 if(!el){el=document.createElement('div');el.id='appNotice';el.className='message error';el.setAttribute('role','alert');document.querySelector('main').prepend(el);}
 el.textContent=message;el.scrollIntoView({block:'nearest'});
}
function explain(error){
 if(error.code==='PGRST202'||error.code==='42P01')return 'Falta activar la base de datos: ejecuta el archivo SQL de instalación en Supabase.';
 if(error.message==='Invalid login credentials')return 'Correo o contraseña incorrectos.';
 if(error.message==='Email not confirmed')return 'Confirma tu correo para iniciar sesión.';
 if(/fetch|network/i.test(error.message))return 'No se pudo conectar con Supabase. Revisa tu conexión e inténtalo de nuevo.';
 return error.message;
}
async function rpc(action,p={}){
 const {data,error}=await sb.rpc('ab_api',{action,p});
 if(error)throw Error(explain(error));return data;
}
export function dashboard(data){
 const {clients,days,today}=data,month=today.slice(0,7),daily={};
 for(let i=30;i>=0;i--){const d=new Date(today+'T12:00:00Z');d.setUTCDate(d.getUTCDate()-i);daily[d.toISOString().slice(0,10)]=0;}
 const weekday=Array(7).fill(0);let monthVisits=0;
 for(const x of days){if(x.day in daily){daily[x.day]=x.total;weekday[new Date(x.day+'T12:00:00Z').getUTCDay()]+=x.total;}if(x.day.startsWith(month))monthVisits+=x.total;}
 const total=weekday.reduce((a,b)=>a+b,0);
 const localDay=s=>s?new Intl.DateTimeFormat('en-CA',{timeZone:matamoros,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(s)):'';
 const lists={new:clients.filter(c=>localDay(c.created_at).startsWith(month)),absent:clients.filter(c=>c.days_absent>=30),monthly:clients.filter(c=>c.month_visits>=1),frequent:clients.filter(c=>c.month_visits>=2&&c.month_visits<=3),upcoming:clients.filter(c=>nextReward(c.visits)?.[0]===c.visits+1),birthdays:clients.filter(c=>c.birth_date?.slice(5,7)===month.slice(5)),today:clients.filter(c=>localDay(c.last_visit)===today)};
 return {clients,lists,daily,weekday_percentages:weekday.map(n=>total?Math.round(n*1000/total)/10:0),metrics:{active:clients.filter(c=>c.active).length,today:daily[today]||0,month_visits:monthVisits,...Object.fromEntries(Object.entries(lists).filter(([k])=>k!=='today').map(([k,v])=>[k,v.length]))}};
}
export async function api(action,data=null,query=''){
 const p={...Object.fromEntries(new URLSearchParams(query.replace(/^&/,''))),...data};
 if(action==='admin_login'){
  const {error}=await sb.auth.signInWithPassword({email:p.username.trim(),password:p.password});
  if(error)throw Error(explain(error));
  try{return await rpc('session');}catch(e){await sb.auth.signOut();throw e;}
 }
 if(action==='admin_logout'){await sb.auth.signOut();return {ok:true};}
 const {data:{session}}=await sb.auth.getSession();
 if(!session)throw Error('Inicia sesión como encargado para atender a los socios.');
 if(action==='admin_session')return rpc('session');
 if(action==='register'){
  const {photo,...fields}=p;const result=await rpc(action,fields);
  if(photo)try{await uploadPhoto(result.id,photo);}catch(e){result.photoWarning='El socio se creó, pero la foto no pudo guardarse: '+e.message;}
  return result;
 }
 const result=await rpc(action,p);
 if(action==='lookup'&&result.client.photo_path){
  const {data,error}=await sb.storage.from('client-photos').createSignedUrl(result.client.photo_path,120);
  if(!error)result.client.photo_url=data.signedUrl;
 }
 if(action==='dashboard')return dashboard(result);
 if(action==='export'){
  const {default:ExcelJS}=await import('exceljs');const workbook=new ExcelJS.Workbook();
  const sheet=workbook.addWorksheet('Visitas');
  sheet.columns=[['Fecha','visited_at'],['Cliente','full_name'],['Código','code'],['Barbero','barber'],['Servicio','service'],['Visita','visit_number'],['Premio','prize_name']].map(([header,key])=>({header,key,width:23}));
  sheet.addRows(result.visits.map(v=>({...v,visited_at:formatMatamorosDateTime(v.visited_at),courtesy_won:v.courtesy_won?'Sí':'No'})));sheet.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'}};sheet.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF123B2B'}};sheet.views=[{state:'frozen',ySplit:1}];
  const blob=new Blob([await workbook.xlsx.writeBuffer()],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
  const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='AB-Premier-visitas.xlsx';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
 }
 return result;
}
