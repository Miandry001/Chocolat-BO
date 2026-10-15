#!/usr/bin/env bash
# Génère une autorité locale (CA) Chocolat et un certificat serveur signé par elle.
#
#   scripts/generate-tls-cert.sh [nom-ou-ip ...]
#
# Le certificat couvre localhost, 127.0.0.1, ::1, le nom de la machine et les noms/IP passés en argument.
# Fichiers créés dans certs/ :
#   chocolat-ca.pem          -> à copier sur les postes clients (CHOCOLAT_TLS_CA)
#   chocolat-ca-key.pem      -> clé de la CA : ne jamais la diffuser
#   chocolat-server.pem      -> CHOCOLAT_TLS_CERT du poste serveur
#   chocolat-server-key.pem  -> CHOCOLAT_TLS_KEY du poste serveur
# La CA existante est réutilisée : relancer le script renouvelle seulement le certificat serveur.
set -euo pipefail

mkdir -p "$(dirname "$0")/../certs"
cd "$(dirname "$0")/../certs"
umask 077

if [ ! -f chocolat-ca.pem ] || [ ! -f chocolat-ca-key.pem ]; then
  echo "Création de l'autorité locale chocolat-ca.pem (10 ans)..."
  openssl req -x509 -newkey rsa:3072 -nodes -sha256 -days 3650 \
    -subj "/O=Chocolat Backoffice/CN=Chocolat Backoffice CA ($(hostname))" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -keyout chocolat-ca-key.pem -out chocolat-ca.pem
fi

host="$(hostname)"
san="DNS:localhost,IP:127.0.0.1,IP:::1,DNS:${host},DNS:${host}.local"
for name in "$@"; do
  if [[ "$name" =~ ^[0-9.]+$ || "$name" == *:* ]]; then san+=",IP:${name}"; else san+=",DNS:${name}"; fi
done

echo "Création de chocolat-server.pem pour : ${san}"
openssl req -newkey rsa:2048 -nodes -sha256 -subj "/O=Chocolat Backoffice/CN=${host}" \
  -keyout chocolat-server-key.pem -out chocolat-server.csr
openssl x509 -req -in chocolat-server.csr -CA chocolat-ca.pem -CAkey chocolat-ca-key.pem -CAcreateserial \
  -days 825 -sha256 -out chocolat-server.pem -extfile <(printf '%s\n' \
    "basicConstraints=critical,CA:FALSE" \
    "keyUsage=critical,digitalSignature,keyEncipherment" \
    "extendedKeyUsage=serverAuth" \
    "subjectAltName=${san}")
rm -f chocolat-server.csr chocolat-ca.srl
chmod 644 chocolat-ca.pem chocolat-server.pem

echo
echo "Dans le .env du poste serveur :"
echo "  CHOCOLAT_TLS_CERT=$(pwd)/chocolat-server.pem"
echo "  CHOCOLAT_TLS_KEY=$(pwd)/chocolat-server-key.pem"
echo "  CHOCOLAT_TLS_CA=$(pwd)/chocolat-ca.pem"
echo "Sur les postes clients : copiez chocolat-ca.pem et définissez CHOCOLAT_TLS_CA vers ce fichier."
