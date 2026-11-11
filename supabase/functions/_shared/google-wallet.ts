import { sign as rsaSign } from 'node:crypto';
import { Buffer } from 'node:buffer';

export type Card = {
  token: string; object_suffix: string; revision: number; revoked: boolean;
  full_name: string; visits: number; tier: string; next_cut: number | null;
  next_prize: string | null; available: number;
};

const api = 'https://walletobjects.googleapis.com/walletobjects/v1';
const tokenUrl = 'https://oauth2.googleapis.com/token';
export function createWalletClient(readSetting: (name: string) => string | undefined) {
  const env = (name: string) => {
    const value = readSetting(name);
    if (!value) throw new Error(`Falta configurar ${name}.`);
    return value;
  };

  function objectId(card: Card) {
    return `${env('WALLET_ISSUER_ID')}.${card.object_suffix}`;
  }

  function pass(card: Card) {
    const text = (id: string, header: string, body: string) => ({ id, header, body });
    return {
      id: objectId(card),
      classId: `${env('WALLET_ISSUER_ID')}.${env('WALLET_CLASS_SUFFIX')}`,
      state: card.revoked ? 'INACTIVE' : 'ACTIVE',
      accountId: card.object_suffix,
      accountName: card.full_name,
      barcode: { type: 'QR_CODE', value: `ABP:${card.token}` },
      loyaltyPoints: { label: 'Cortes acumulados', balance: { int: card.visits } },
      textModulesData: [
        text('tier', 'Membresía', card.tier),
        text('progress', 'Próximo beneficio', card.next_cut
          ? `${card.visits}/${card.next_cut} cortes · ${card.next_prize}`
          : 'Todos los beneficios desbloqueados'),
        text('available', 'Cortesías disponibles', String(card.available)),
      ],
    };
  }

  async function googleAccount() {
    const { client_email: email, private_key: pem } = JSON.parse(env('WALLET_SERVICE_ACCOUNT_JSON'));
    const sign = (claims: Record<string, unknown>) => {
      const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
      const input = encode({ alg: 'RS256', typ: 'JWT' }) + '.' +
        encode({ ...claims, iss: email, iat: Math.floor(Date.now()/1000) });
      return input + '.' + rsaSign('RSA-SHA256', Buffer.from(input), pem).toString('base64url');
    };
    const assertion = sign({
      scope: 'https://www.googleapis.com/auth/wallet_object.issuer',
      aud: tokenUrl,
      exp: Math.floor(Date.now()/1000)+3600,
    });
    const response = await fetch(tokenUrl, {
      method: 'POST',
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`Google rechazó la credencial (${response.status}).`);
    const { access_token: accessToken } = await response.json();
    return { accessToken, sign };
  }

  async function ensureClass(accessToken: string) {
    const id = `${env('WALLET_ISSUER_ID')}.${env('WALLET_CLASS_SUFFIX')}`;
    const headers = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
    const path = api + '/loyaltyClass/' + id;
    const existing = await fetch(path, { headers, signal: AbortSignal.timeout(10000) });
    if (existing.ok) return;
    if (existing.status !== 404) throw new Error(`Google no pudo consultar la clase (${existing.status}).`);
    const logo = new URL(env('WALLET_LOGO_URL'));
    if (logo.protocol !== 'https:') throw new Error('El logo requiere una URL HTTPS pública.');
    const response = await fetch(api + '/loyaltyClass', {
      method: 'POST', headers, signal: AbortSignal.timeout(10000),
      body: JSON.stringify({
        id, issuerName: 'AB Premier', programName: 'Familia AB', countryCode: 'MX',
        accountNameLabel: 'Socio', hexBackgroundColor: '#0a2318', reviewStatus: 'UNDER_REVIEW',
        programLogo: {
          sourceUri: { uri: logo.href },
          contentDescription: { defaultValue: { language: 'es-MX', value: 'Logo AB Premier' } },
        },
      }),
    });
    if (!response.ok && response.status !== 409) {
      throw new Error(`Google no pudo crear la clase (${response.status}).`);
    }
  }

  async function upsert(card: Card, accessToken: string, update: boolean) {
    const body = pass(card);
    const send = (method: string, path: string) => fetch(api + path, {
      method, body: JSON.stringify(body),
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    const path = `/loyaltyObject/${body.id}`;
    const insert = await send('POST', '/loyaltyObject');
    if (insert.ok || (insert.status === 409 && !update)) return;
    if (insert.status === 409) {
      const patch = await send('PATCH', path);
      if (patch.ok) return;
      throw new Error(`Google Wallet no actualizó la tarjeta (${patch.status}).`);
    }
    throw new Error(`Google Wallet no creó la tarjeta (${insert.status}).`);
  }

  async function issue(card: Card, update = false) {
    const { accessToken, sign } = await googleAccount();
    await ensureClass(accessToken);
    await upsert(card, accessToken, update);
    const jwt = sign({
      aud: 'google', typ: 'savetowallet', payload: { loyaltyObjects: [{ id: objectId(card) }] },
    });
    return 'https://pay.google.com/gp/v/save/' + jwt;
  }

  return { issue, googleAccount, upsert };
}
