import { sb } from './supabase.js';

export async function walletStaff(action, p) {
  const { data, error } = await sb.rpc('wallet_staff', { action, p });
  if (error) throw Error(error.message);
  return data;
}

export async function issueWallet(clientId) {
  const { data, error } = await sb.functions.invoke('wallet', {
    body: { action: 'issue', client_id: clientId },
  });
  if (error) {
    const body = await error.context?.json?.().catch(() => null);
    throw Error(body?.error || 'No se pudo emitir la tarjeta. Verifica la conexión con Wallet.');
  }
  const url = new URL(data.url);
  if (url.origin !== 'https://pay.google.com' || !url.pathname.startsWith('/gp/v/save/')) {
    throw Error('El servidor devolvió un enlace inválido.');
  }
  return url.href;
}
