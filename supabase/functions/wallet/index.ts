import { createClient } from 'npm:@supabase/supabase-js@2.57.4';
import { createWalletClient, type Card } from '../_shared/google-wallet.ts';

const wallet = createWalletClient(name => Deno.env.get(name));
const env = (name: string) => {
  const value = Deno.env.get(name);
  if (!value) throw new Error('Falta configurar ' + name + '.');
  return value;
};

Deno.serve(async request => {
  const origin = request.headers.get('Origin');
  const cors: Record<string, string> = { 'Vary': 'Origin' };
  if (origin && (Deno.env.get('WALLET_ALLOWED_ORIGINS') || '').split(',').map(s => s.trim()).includes(origin)) {
    cors['Access-Control-Allow-Origin'] = origin;
    cors['Access-Control-Allow-Headers'] = 'authorization, apikey, content-type, x-client-info';
    cors['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
  }
  const json = (body: unknown, status = 200) => Response.json(body, {
    status, headers: { ...cors, 'Cache-Control': 'no-store' },
  });
  if (origin && !cors['Access-Control-Allow-Origin']) return json({ error: 'Origen sin autorización.' }, 403);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return json({ error: 'Método inválido.' }, 405);
  try {
    const input = await request.json();
    const url = env('SUPABASE_URL');
    if (input.action === 'sync') {
      const secret = Deno.env.get('WALLET_SYNC_SECRET');
      if (!secret || request.headers.get('Authorization') !== `Bearer ${secret}`) {
        return json({ error: 'Acceso restringido.' }, 401);
      }
      const admin = createClient(url, env('SUPABASE_SERVICE_ROLE_KEY'));
      const { accessToken } = await wallet.googleAccount();
      const { data, error } = await admin.rpc('wallet_claim');
      if (error) throw new Error(error.message);
      const results = await Promise.allSettled((data as Card[]).map(async card => {
        await wallet.upsert(card, accessToken, true);
        const { error } = await admin.rpc('wallet_synced', { suffix: card.object_suffix, synced: card.revision });
        if (error) throw new Error(error.message);
      }));
      const failed = results.filter(result => result.status === 'rejected');
      return json({ synced: results.length - failed.length, failed: failed.length }, failed.length ? 502 : 200);
    }
    if (input.action !== 'issue' || !Number.isSafeInteger(input.client_id) || input.client_id < 1) {
      return json({ error: 'Selecciona un socio válido.' }, 400);
    }
    const authorization = request.headers.get('Authorization');
    if (!authorization?.startsWith('Bearer ')) return json({ error: 'Inicia sesión.' }, 401);
    const client = createClient(url, env('SUPABASE_ANON_KEY'), {
      global: { headers: { Authorization: authorization } },
    });
    const { data, error } = await client.rpc('wallet_staff', { action: 'issue', p: { client_id: input.client_id } });
    if (error) return json({ error: error.message }, error.code === '42501' ? 403 : 400);
    return json({ url: await wallet.issue(data as Card) });
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Wallet error');
    return json({ error: 'Wallet no pudo completar la operación. Revisa la configuración del servidor.' }, 502);
  }
});
