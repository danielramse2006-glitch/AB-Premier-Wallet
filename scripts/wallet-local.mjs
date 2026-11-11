import { readFile, mkdir, readdir } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { createWalletClient } from '../supabase/functions/_shared/google-wallet.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = resolve(root,'data/wallet-local');
const operator = '00000000-0000-4000-8000-000000000001';
const [action, value] = process.argv.slice(2);
const show = data => console.log(JSON.stringify(data, null, 2));

async function prepare(db) {
  const { rows } = await db.query("select to_regclass('public.clients') as clients");
  if (rows[0].clients) return;
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role;
    create schema auth;
    create schema storage;
    create table auth.users(id uuid primary key,email text,last_sign_in_at timestamptz);
    create function auth.uid() returns uuid language sql as
      $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth to authenticated,anon;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid,bucket_id text,name text);
    alter table storage.objects enable row level security;
    grant usage on schema storage to authenticated;
    grant select,insert on storage.objects to authenticated;
  `);
  const folder = resolve(root,'supabase/migrations');
  for (const file of (await readdir(folder)).filter(file => file.endsWith('.sql')).sort()) {
    await db.exec(await readFile(resolve(folder,file),'utf8'));
  }
  await db.query('insert into auth.users(id,email) values($1,$2)',[operator,'wallet-local@example.test']);
  await db.query("insert into public.profiles(id,full_name,role) values($1,'Operador local','admin')",[operator]);
}

async function call(db, fn, operation, params) {
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[operator]);
  await db.exec('set role authenticated');
  try {
    const result = await db.query(`select public.${fn}($1,$2::jsonb) as result`,[operation,JSON.stringify(params)]);
    return result.rows[0].result;
  } finally {
    await db.exec('reset role');
  }
}

async function loadIssuer() {
  const keyPath = process.env.AB_WALLET_KEY_FILE;
  if (!keyPath) throw Error('Configura AB_WALLET_KEY_FILE con la ruta de la clave JSON nueva.');
  const location = relative(root, resolve(keyPath));
  if (!location.startsWith('..'+sep) && !isAbsolute(location)) {
    throw Error('La clave de Google debe guardarse fuera del repositorio.');
  }
  if (location.endsWith('leafy-affinity-514403-s2-a5618a4c829f.json')) {
    throw Error('Usa una clave nueva. La clave anterior se compartió en el chat.');
  }
  const key = await readFile(keyPath,'utf8');
  return createWalletClient(name => ({
    WALLET_SERVICE_ACCOUNT_JSON: key,
    WALLET_ISSUER_ID: process.env.AB_WALLET_ISSUER_ID,
    WALLET_CLASS_SUFFIX: 'familia_ab_local',
    WALLET_LOGO_URL: 'https://abpremier.vercel.app/assets/logo-ab-premiere.png',
  })[name]);
}

async function main() {
  if (!['init','register','issue','lookup','visit','catalogs'].includes(action)) {
    throw Error('Usa init, register "Nombre", issue ID, lookup TOKEN, visit TOKEN BARBERO SERVICIO o catalogs.');
  }
  const issuer = action==='issue' ? await loadIssuer() : null;
  await mkdir(directory,{recursive:true});
  const db = new PGlite(directory);
  try {
    await prepare(db);
    if (action==='init') return console.log('Base local lista.');
    if (action==='register') return show(await call(db,'ab_api','register',{full_name:value}));
    if (action==='catalogs') return show(await call(db,'ab_api','catalogs',{}));
    if (action==='issue') {
      if (!/^\d+$/.test(value || '')) throw Error('Indica el ID del socio local.');
      const card = await call(db,'wallet_staff','issue',{client_id:Number(value)});
      console.log(await issuer.issue(card,true));
      await db.query(
        'update ab_private.wallet_cards set synced_revision=$2 where object_suffix=$1',
        [card.object_suffix,card.revision],
      );
      return;
    }
    const token = (value || '').replace(/^ABP:/i,'');
    if (action==='lookup') return show(await call(db,'wallet_staff','lookup',{token}));
    const [, , , , barber_id, service_id] = process.argv;
    const visit = await call(db,'wallet_staff','visit',{token,barber_id,service_id});
    show(visit);
    if (process.env.AB_WALLET_KEY_FILE) {
      try {
        const google = await loadIssuer();
        const { accessToken } = await google.googleAccount();
        const { rows } = await db.query(
          'select ab_private.wallet_snapshot(c) as card from ab_private.wallet_cards c where token=$1',
          [token],
        );
        const { card } = rows[0];
        await google.upsert(card,accessToken,true);
        await db.query(
          'update ab_private.wallet_cards set synced_revision=$2 where object_suffix=$1',
          [card.object_suffix,card.revision],
        );
      } catch (error) {
        console.error('Visita guardada. Actualización de Wallet pendiente: ' + error.message);
      }
    }
  } finally {
    await db.close();
  }
}

main().catch(error => { console.error(error.message); process.exitCode=1; });
