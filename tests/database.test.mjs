import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { rewards } from '../src/rewards.js';

test('Database authorization, visit rules, courtesies and audit',async()=>{
 const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;create schema storage;
 create table auth.users(id uuid primary key,email text,last_sign_in_at timestamptz);
 create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
 grant usage on schema auth to authenticated,anon;grant execute on function auth.uid() to authenticated,anon;
 create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 create table storage.objects(id uuid,bucket_id text,name text);alter table storage.objects enable row level security;
 grant usage on schema storage to authenticated;grant select,insert on storage.objects to authenticated;`);
 await db.exec(fs.readFileSync('supabase/migrations/202609060001_initial.sql','utf8'));
 const admin='00000000-0000-0000-0000-000000000001',reader='00000000-0000-0000-0000-000000000002',outsider='00000000-0000-0000-0000-000000000003',barber='00000000-0000-0000-0000-000000000004';
 await db.exec(`insert into auth.users(id,email) values('${admin}','admin@example.test'),('${reader}','reader@example.test'),('${outsider}','outsider@example.test'),('${barber}','barber@example.test');insert into public.profiles(id,full_name,role) values('${admin}','Admin','admin'),('${reader}','Reader','consulta');`);
 const login=async(id,role='authenticated')=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);await db.exec('set role '+role);};
 const rpc=async(action,p={})=>(await db.query('select public.ab_api($1,$2::jsonb) result',[action,JSON.stringify(p)])).rows[0].result;
 await login('', 'anon');await assert.rejects(()=>rpc('dashboard'),/permission denied/);
 await login(outsider);await assert.rejects(()=>rpc('dashboard'),/Acceso restringido/);
 await assert.rejects(()=>db.exec("insert into public.profiles values('00000000-0000-0000-0000-000000000003','Hacker','admin',true,now())"),/permission denied/);
 await login(admin);await assert.rejects(()=>db.exec('select * from public.clients'),/permission denied/);
 const c=await rpc('register',{full_name:'Cliente de prueba',birth_date:'1990-01-01'});assert.match(c.code,/^\d{4}$/);
 let visit=await rpc('visit',{code:c.code,barber_id:1,service_id:1,points:999999,courtesy_won:true});
 assert.equal(visit.points_earned,50);assert.equal(visit.courtesy_won,false);
 await assert.rejects(()=>rpc('visit',{code:c.code,barber_id:1,service_id:1}),/ya tiene una visita/);
 assert.equal((await rpc('lookup',{code:c.code})).client.points,50);
 for(let i=2;i<=5;i++){
  await db.exec('reset role');await db.exec("update public.visits set visit_day=visit_day-1,visited_at=visited_at-interval '1 day'");await login(admin);
  visit=await rpc('visit',{code:c.code,barber_id:1,service_id:1});
 }
 assert.equal(visit.visit_number,5);assert.equal(visit.courtesy_won,true);assert.equal(visit.total_points,250);
 const courtesy=(await rpc('courtesies')).courtesies[0];await rpc('redeem',{id:courtesy.id});await assert.rejects(()=>rpc('redeem',{id:courtesy.id}),/ya fue entregada/);
 await login(reader);await assert.rejects(()=>rpc('visit',{code:c.code,barber_id:1,service_id:1}),/solo tiene permiso/);
 await assert.rejects(()=>rpc('save_catalog',{type:'barber',name:'Unauthorized'}),/Solo el administrador/);
 await assert.rejects(()=>rpc('save_admin',{username:'reader@example.test',role:'admin'}),/Solo el administrador/);
 assert.equal((await rpc('dashboard')).clients.length,1);
 await assert.rejects(()=>db.exec("insert into storage.objects(bucket_id,name) values('client-photos','1/x.jpg')"),/row-level security/);
 await login(outsider);assert.equal((await db.query('select * from storage.objects')).rows.length,0);
 await login(admin);assert.ok((await rpc('audit_log')).entries.length>=8);
 await assert.rejects(()=>rpc('set_admin',{id:admin,active:false}),/propia cuenta/);
 await db.exec('reset role');await db.exec(`update public.profiles set active=false where id='${reader}'`);await login(reader);
 await assert.rejects(()=>rpc('dashboard'),/Acceso restringido/);
 await db.exec('reset role');
 await db.exec(fs.readFileSync('supabase/migrations/202609060002_rewards.sql','utf8'));
 await db.exec(fs.readFileSync('supabase/migrations/202609060002_rewards.sql','utf8'));
 await db.exec(fs.readFileSync('supabase/migrations/202609100001_barber_role.sql','utf8'));
 await db.exec(fs.readFileSync('supabase/migrations/202609100001_barber_role.sql','utf8'));
 await db.exec(fs.readFileSync('supabase/demo/01_datos_prueba.sql','utf8'));
 await login(admin);
 await rpc('save_admin',{username:'barber@example.test',full_name:'Barbero Kiosco',role:'barbero'});
 await login(barber);
 assert.equal((await rpc('session')).user.role,'barbero');
 const barberClient=await rpc('register',{full_name:'Cliente creado por barbero',birth_date:'1992-02-02'});
 assert.match(barberClient.code,/^\d{4}$/);
 const barberVisit=await rpc('visit',{code:barberClient.code,barber_id:1,service_id:1});
 assert.equal(barberVisit.visit_number,1);
 assert.equal((await rpc('lookup',{code:barberClient.code})).client.full_name,'Cliente creado por barbero');
 await assert.rejects(()=>rpc('dashboard'),/solo puede usar el kiosco/);
 await assert.rejects(()=>rpc('visits'),/solo puede usar el kiosco/);
 await assert.rejects(()=>rpc('export'),/solo puede usar el kiosco/);
 await assert.rejects(()=>rpc('courtesies'),/solo puede usar el kiosco/);
 await assert.rejects(()=>rpc('audit_log'),/solo puede usar el kiosco/);
 await assert.rejects(()=>rpc('save_client',{id:barberClient.id,full_name:'Hack',active:true}),/solo puede usar el kiosco/);
 await assert.rejects(()=>rpc('save_catalog',{type:'barber',name:'Hack'}),/solo puede usar el kiosco/);
 await assert.rejects(()=>rpc('admin_catalogs'),/solo puede usar el kiosco/);
 await db.exec("insert into storage.objects(bucket_id,name) values('client-photos','1/barber.jpg')");
 await login(admin);
 const milestones=[5,10,15,20,25,28,32,35];
 assert.equal((await rpc('rewards')).version,2);
 for(const target of milestones){
  const code='91'+String(target).padStart(2,'0');
  const before=(await rpc('lookup',{code})).client;
  assert.equal(before.visits,target-1);assert.equal(before.next_courtesy,target);assert.equal(before.one_away,true);
  const v=await rpc('visit',{code,barber_id:1,service_id:1,prize_name:'Hacked',points:9999});
  assert.equal(v.visit_number,target);assert.equal(v.courtesy_won,true);assert.equal(v.prize_name,rewards.find(([cut])=>cut===target)[1]);assert.equal(v.points_earned,0);assert.equal(v.premium,false);assert.equal(v.membership_tier,'Membership');
  await assert.rejects(()=>rpc('visit',{code,barber_id:1,service_id:1}),/ya tiene una visita/);
 }
 assert.equal((await rpc('lookup',{code:'9135'})).client.next_courtesy,null);
 assert.ok((await rpc('export')).visits.some(v=>v.prize_name==='Bebidas gratis'));
 // Seed can be rerun without resetting earned rewards or duplicating demo clients.
 await db.exec('reset role');await db.exec(fs.readFileSync('supabase/demo/01_datos_prueba.sql','utf8'));
 assert.equal((await db.query('select count(*)::int n from public.clients where is_demo')).rows[0].n,8);
 await db.exec(fs.readFileSync('supabase/demo/02_reset_demos_a_un_corte.sql','utf8'));
 await db.exec(fs.readFileSync('supabase/demo/02_reset_demos_a_un_corte.sql','utf8'));
 assert.equal((await db.query('select count(*)::int n from public.clients where is_demo')).rows[0].n,10);
 await login(admin);
 const panchitos=[[1,5],[2,10],[3,15],[4,20],[5,25],[6,28],[7,32],[8,35],[9,5],[10,10]];
 for(const [demoNo,target] of panchitos){
  const resetClient=(await rpc('lookup',{code:'90'+String(demoNo).padStart(2,'0')})).client;
  assert.equal(resetClient.full_name,'Panchito '+demoNo);
  assert.equal(resetClient.visits,target-1);
  assert.equal(resetClient.next_courtesy,target);
  assert.equal(resetClient.one_away,true);
 }
 await db.exec('reset role');await db.exec(fs.readFileSync('supabase/demo/03_borrar_demos.sql','utf8'));
 assert.equal((await db.query('select count(*)::int n from public.clients where is_demo')).rows[0].n,0);
 assert.ok((await db.query('select count(*)::int n from public.clients')).rows[0].n>=2);
 // An unlisted cut (30) must not award the old every-five reward.
 await login(admin);const extra=await rpc('register',{full_name:'Non milestone'});
 await db.exec('reset role');
 await db.query(`insert into public.visits(client_id,barber_id,service_id,visited_at,visit_day,points_earned,visit_number,courtesy_won,created_by)
 select $1,1,1,now()-make_interval(days=>30-i),(now() at time zone 'America/Matamoros')::date-(30-i),0,i,false,$2 from generate_series(1,29) i`,[extra.id,admin]);
 await login(admin);const non=await rpc('visit',{code:extra.code,barber_id:1,service_id:1});assert.equal(non.visit_number,30);assert.equal(non.courtesy_won,false);assert.equal(non.prize_name,null);
 assert.equal((await rpc('lookup',{code:extra.code})).client.next_courtesy,32);
 await login(outsider);await assert.rejects(()=>rpc('rewards'),/Acceso restringido/);
 await db.exec('reset role');await db.exec(fs.readFileSync('supabase/maintenance/01_borrar_todos_los_clientes.sql','utf8'));
 assert.equal((await db.query('select count(*)::int n from public.clients')).rows[0].n,0);
 assert.equal((await db.query('select count(*)::int n from public.visits')).rows[0].n,0);
 assert.equal((await db.query('select count(*)::int n from public.courtesies')).rows[0].n,0);
 assert.ok((await db.query("select count(*)::int n from storage.objects where bucket_id='client-photos'")).rows[0].n>0);
 assert.ok((await db.query('select count(*)::int n from public.barbers')).rows[0].n>0);
 assert.ok((await db.query('select count(*)::int n from public.services')).rows[0].n>0);
 assert.ok((await db.query('select count(*)::int n from public.profiles')).rows[0].n>0);

 // Wallet uses the same visit transaction and keeps one pass per client.
 await db.exec('reset role');
 await db.exec(fs.readFileSync('supabase/migrations/202609230002_wallet.sql','utf8'));
 const wallet = async (action,p) => (await db.query(
  'select public.wallet_staff($1,$2::jsonb) result',[action,JSON.stringify(p)]
 )).rows[0].result;
 await login(barber);
 const member = await rpc('register',{full_name:'Socio Wallet'});
 const card = await wallet('issue',{client_id:member.id});
 assert.equal((await wallet('issue',{client_id:member.id})).object_suffix,card.object_suffix);
 assert.equal((await wallet('lookup',{token:card.token})).client.id,member.id);
 const request={token:card.token,barber_id:1,service_id:1,request_id:'00000000-0000-4000-8000-000000000001'};
 const firstVisit=await wallet('visit',request);
 assert.equal(firstVisit.visit_number,1);
 assert.equal(firstVisit.remaining_to_next,4);
 assert.deepEqual(await wallet('visit',request),firstVisit);
 await assert.rejects(()=>wallet('visit',{token:card.token,barber_id:1,service_id:1}),/ya tiene una visita/);
 await assert.rejects(()=>db.exec('select * from public.wallet_claim()'),/permission denied/);
 await login(reader);
 await assert.rejects(()=>wallet('issue',{client_id:member.id}),/personal autorizada/);
 await login(barber);
 await wallet('revoke',{client_id:member.id});
 await assert.rejects(()=>wallet('lookup',{token:card.token}),/revocada/);
 const reissued = await wallet('issue',{client_id:member.id});
 assert.notEqual(reissued.token,card.token);
 assert.equal(reissued.object_suffix,card.object_suffix);
 await login('', 'service_role');
 const pending = (await db.query('select public.wallet_claim() card')).rows[0].card;
 assert.equal(pending.visits,1);
 assert.equal(pending.token,reissued.token);
 await db.query('select public.wallet_synced($1,$2)',[pending.object_suffix,pending.revision]);
 assert.equal((await db.query('select public.wallet_claim()')).rows.length,0);

 await db.close();
});
