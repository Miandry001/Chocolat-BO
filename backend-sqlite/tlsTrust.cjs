const crypto = require('node:crypto');
const fs = require('node:fs');
const tls = require('node:tls');

// Certificats de confiance de l'application :
//  - CHOCOLAT_TLS_CA   : autorité (CA) qui a signé le certificat du serveur (ex. rootCA.pem de mkcert) ;
//  - CHOCOLAT_TLS_CERT : certificat du serveur local, épinglé tel quel.
// Rien n'est accepté en dehors de ces certificats et des autorités du système.

function readPemCertificates(file) {
  if (!file) return [];
  const pem = fs.readFileSync(file, 'utf8');
  return pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
}

function loadTrustedCertificates(env = process.env) {
  const authorities = readPemCertificates(env.CHOCOLAT_TLS_CA);
  const pinned = readPemCertificates(env.CHOCOLAT_TLS_CERT);
  return { authorities, pinned };
}

// Node (fetch du backend vers le serveur de synchronisation, Google, OneDrive…) :
// ajoute les autorités du système et CHOCOLAT_TLS_CA aux autorités par défaut.
function trustCertificateAuthorities(env = process.env) {
  const { authorities } = loadTrustedCertificates(env);
  if (typeof tls.setDefaultCACertificates !== 'function') return authorities;
  let system = [];
  try { system = tls.getCACertificates('system'); } catch { /* magasin système indisponible */ }
  if (!authorities.length && !system.length) return authorities;
  tls.setDefaultCACertificates([...new Set([...tls.getCACertificates('default'), ...system, ...authorities])]);
  return authorities;
}

// Electron : vrai si le certificat présenté est épinglé ou signé par une autorité de confiance.
function isTrustedCertificate(pem, { authorities, pinned }) {
  let certificate;
  try { certificate = new crypto.X509Certificate(pem); } catch { return false; }
  const now = Date.now();
  if (now < Date.parse(certificate.validFrom) || now > Date.parse(certificate.validTo)) return false;
  if (pinned.some(trusted => new crypto.X509Certificate(trusted).fingerprint256 === certificate.fingerprint256)) return true;
  return authorities.some((trusted) => {
    const authority = new crypto.X509Certificate(trusted);
    return authority.ca && certificate.checkIssued(authority) && certificate.verify(authority.publicKey);
  });
}

module.exports = { readPemCertificates, loadTrustedCertificates, trustCertificateAuthorities, isTrustedCertificate };
