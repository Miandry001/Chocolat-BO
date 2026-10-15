// Assistant de connexion du compte Microsoft pour la sauvegarde OneDrive.
// À lancer plus tard, quand le compte sera connu :
//   set ONEDRIVE_CLIENT_ID=<id d'application>& npm run onedrive:login
// Affiche l'URL + le code à valider, puis enregistre le refresh_token
// dans ONEDRIVE_TOKEN_STORE (ou l'affiche pour le copier dans .env).
const fs = require('node:fs');
const path = require('node:path');

const SCOPE = 'Files.ReadWrite offline_access';

async function main() {
  const clientId = String(process.env.ONEDRIVE_CLIENT_ID || '').trim();
  const tenant = String(process.env.ONEDRIVE_TENANT || process.env.ONEDRIVE_TENANT_ID || 'common').trim() || 'common';
  if (!clientId) {
    console.error('ONEDRIVE_CLIENT_ID manquant. Créez une inscription d’application sur https://entra.microsoft.com (comptes personnels autorisés, plateforme « Mobile and desktop applications »), puis relancez avec ONEDRIVE_CLIENT_ID défini.');
    process.exit(1);
  }
  const deviceResponse = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/devicecode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, scope: SCOPE }).toString(),
    signal: AbortSignal.timeout(20_000),
  });
  if (!deviceResponse.ok) throw new Error(`Flux appareil refusé (${deviceResponse.status}).`);
  const device = await deviceResponse.json();
  console.log(device.message || `Ouvrez ${device.verification_uri} et saisissez le code ${device.user_code}.`);
  const deadline = Date.now() + Math.min(Number(device.expires_in || 900) * 1000, 15 * 60_000);
  const intervalMs = Math.max(5_000, Number(device.interval || 5) * 1000);
  for (;;) {
    if (Date.now() > deadline) throw new Error('Délai de validation dépassé, relancez la commande.');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    const tokenResponse = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: device.device_code,
      }).toString(),
      signal: AbortSignal.timeout(20_000),
    });
    const body = await tokenResponse.json().catch(() => ({}));
    if (tokenResponse.ok && body.refresh_token) {
      const store = process.env.ONEDRIVE_TOKEN_STORE || path.join(process.cwd(), 'onedrive-token.json');
      try {
        fs.writeFileSync(store, JSON.stringify({ refresh_token: body.refresh_token, updated_at: new Date().toISOString() }));
        console.log(`Compte Microsoft connecté. Jeton enregistré dans ${store} (référencez-le via ONEDRIVE_TOKEN_STORE ou copiez-le dans ONEDRIVE_REFRESH_TOKEN).`);
      } catch {
        console.log('Compte Microsoft connecté. Ajoutez dans .env :');
        console.log(`ONEDRIVE_REFRESH_TOKEN=${body.refresh_token}`);
      }
      return;
    }
    if (body.error !== 'authorization_pending' && body.error !== 'slow_down') {
      throw new Error(`Connexion refusée : ${body.error_description || body.error || tokenResponse.status}.`);
    }
  }
}

main().catch((error) => { console.error(error.message || error); process.exit(1); });
