CHOCOLAT BACKOFFICE — WINDOWS / EXPRESS / SQLITE
================================================

L’application contient le frontend React, une API Express et une base SQLite persistante. Aucun hébergement Internet ni abonnement à un service de base de données n’est nécessaire.

MODE APPLICATION WEB (recommandé pour partager)
-----------------------------------------------
L'application peut tourner comme un simple site web : un seul poste (le serveur)
exécute Node.js, les autres utilisateurs ouvrent l'adresse dans leur navigateur
(Chrome, Edge, Firefox). Rien à installer sur les postes clients.

Sur le poste serveur :
  npm install
  npm run web:build      (1re fois ou après modification du code : construit l'interface puis démarre)
  npm run web            (démarrages suivants)

La console affiche les adresses à communiquer, par exemple :
  Depuis le réseau  : https://192.168.1.20:3001

Configuration (.env à la racine du projet) :
  CHOCOLAT_HOST=0.0.0.0         écoute sur le réseau local (sinon accès limité à ce poste)
  PORT=3001
  CHOCOLAT_TLS_CERT / CHOCOLAT_TLS_KEY   HTTPS (recommandé)
  ou CHOCOLAT_ALLOW_INSECURE_LAN=1       HTTP en clair, réseau de confiance uniquement

HTTPS : le certificat doit contenir l'adresse IP ou le nom DNS du serveur
(scripts/generate-tls-cert.sh 192.168.1.20 mon-pc). Pour éviter l'avertissement
du navigateur, importez certs/chocolat-ca.pem (jamais la clé) comme « autorité de
certification de confiance » sur chaque poste client.

Pare-feu Linux : sudo ufw allow from 192.168.1.0/24 to any port 3001 proto tcp
Ne publiez pas ce port sur Internet sans reverse proxy HTTPS (Caddy, Nginx).

Données : par défaut le mode web réutilise la base de l'ancienne application
Electron (~/.config/chocolat-backoffice-electron/database). CHOCOLAT_DATA_DIR permet
d'en choisir une autre. Fermez l'application Electron avant de lancer le mode web
(même port, même base).

Temps réel : le serveur diffuse lui-même les changements aux navigateurs
(/api/v1/events). Le serveur de synchronisation (SYNC_ENABLED, port 3002) reste
facultatif et n'a plus besoin d'être ouvert sur le réseau.

Le « catalogue » s'ouvre dans un nouvel onglet via le bouton « Afficher les onglets ».

INSTALLATION ET PREMIER LANCEMENT
---------------------------------
1. Installez les dépendances du projet depuis sa racine : npm install
2. Construisez l’interface et l’exécutable : npm run build:electron
3. Lancez l’exécutable portable créé dans dist.
4. Au premier lancement, une fenêtre affiche le login et le mot de passe administrateur générés. Notez-les : le mot de passe n’est affiché qu’une fois.
5. Connectez-vous, créez les comptes nécessaires, puis ouvrez « Données source » et importez le classeur au format .xlsx et/ou Google Sheet.

La configuration facultative se fait dans un fichier .env placé à côté du .exe. Copiez-y les paramètres voulus depuis .env.example. Le fichier .env n’est pas inclus dans l’exécutable.

Les données sont enregistrées dans un fichier SQLite sous le profil Windows de l’utilisateur qui héberge l’application. Pour choisir un emplacement, définissez CHOCOLAT_DATA_DIR avant de lancer le programme. Sauvegardez régulièrement le dossier contenant chocolat.sqlite3 ; fermez l’application avant de copier le fichier. Limitez les droits Windows sur ce dossier aux comptes autorisés.

PARTAGE ENTRE PLUSIEURS ORDINATEURS
-----------------------------------
Un seul poste Windows doit héberger l'API et le fichier SQLite. Laissez Chocolat ouvert sur ce poste pendant le travail des autres utilisateurs. Configurez ce poste avant son premier démarrage :

  CHOCOLAT_HOST=0.0.0.0
  CHOCOLAT_TLS_CERT=C:\chemin\vers\certificat.pem
  CHOCOLAT_TLS_KEY=C:\chemin\vers\cle-privee.pem

  CHOCOLAT_TLS_CA=C:\chemin\vers\autorite-ca.pem

Le certificat TLS doit contenir le nom DNS du serveur ainsi que « localhost » et 127.0.0.1 (pour l'écran local). L'application n'accepte que les certificats signés par CHOCOLAT_TLS_CA (ou par une autorité du système) : copiez le fichier de la CA (jamais sa clé) sur chaque poste client et définissez-y CHOCOLAT_TLS_CA. Sous Linux, scripts/generate-tls-cert.sh [nom-dns-ou-ip ...] crée la CA et le certificat serveur dans certs/. Avec mkcert, la CA est le fichier rootCA.pem du dossier indiqué par « mkcert -CAROOT ». Réservez l'accès au réseau privé de l'organisation dans le pare-feu Windows. Ne publiez pas le port 3001 sur Internet.

Sur chaque poste client, définissez CHOCOLAT_SERVER_URL, par exemple :

  CHOCOLAT_SERVER_URL=https://chocolat-serveur:3001

Puis lancez le même exécutable. Il affichera l'interface hébergée, sans démarrer une base séparée. Tous les changements sont écrits dans la base SQLite du poste serveur. Une connexion sécurisée (HTTPS) est obligatoire quand l'API écoute sur le réseau.

SYNCHRONISATION EN TEMPS RÉEL (MULTI-UTILISATEUR)
------------------------------------------------
Pour activer la collaboration en temps réel entre plusieurs utilisateurs sur le poste serveur, configurez le serveur de synchronisation partagée :

  SYNC_ENABLED=true
  SYNC_URL=http://127.0.0.1:3002
  SYNC_AUTH_TOKEN=UnSecretDe32CaracteresMinimumIdentiqueSurLesDeux

Le serveur de synchronisation (port 3002) diffuse instantanément les changements (saisies, statuts de blocs, retours qualité, notifications, dictionnaires, catalogue) à tous les clients connectés via SSE (Server-Sent Events).

Pour le partage multi-poste : le poste serveur doit avoir SYNC_ENABLED=true, SYNC_URL défini sur son propre port 3002 (ex: http://127.0.0.1:3002), et SYNC_AUTH_TOKEN défini. Les postes clients utiliseront automatiquement ce serveur via l'URL déduite de CHOCOLAT_SERVER_URL.

La base de données partagée se trouve dans le dossier CHOCOLAT_SYNC_DIR (ou %PROGRAMDATA%\ChocolatBackofficeSync par défaut) sous le nom chocolat-sync.sqlite3. Sauvegardez-la régulièrement ; fermez l'application avant de copier le fichier.

CONFIGURATION FACULTATIVE
-------------------------
AUTH_BOOTSTRAP_ADMIN_LOGIN définit le login initial (admin par défaut).
AUTH_BOOTSTRAP_ADMIN_PASSWORD définit son mot de passe. Il doit compter au moins 12 caractères. Si cette variable est absente, un mot de passe aléatoire est affiché une fois au premier lancement.
PORT change le port HTTP/HTTPS (3001 par défaut).
CHOCOLAT_DATA_DIR choisit le dossier de base SQLite.

DÉVELOPPEMENT
-------------
npm --prefix frontend install
npm run backend
npm --prefix frontend run dev

Vite transmet les appels API à http://localhost:3001. Les sources peuvent être importées depuis un fichier .xlsx/.csv ou un lien Google Sheets. En développement, le serveur charge aussi frontend/.env et frontend/.env.local.

LIMITES DU MODE LOCAL
---------------------
L'import accepte les fichiers .xlsx et CSV. Pour un Google Sheet public, collez son lien. Pour un document privé, activez Google Sheets API, configurez GOOGLE_CREDENTIALS avec le chemin du fichier JSON du compte de service dans le .env à côté du .exe, pouvez-y le classeur avec l'adresse client_email de ce compte. Les exports de saisies au format Excel sont générés localement. Les sessions expirent après 12 heures. La base de données se trouve sur un seul poste hôte : ne placez pas le fichier SQLite sur un dossier réseau partagé.

SIGNATURE DE CODE (facultatif)
-----------------------------
Sans certificat de signature de code, Windows affichera un avertissement de sécurité lors de l'installation. Pour éliminer cet avertissement :

1. Test (certificat auto-signé, machine-locale uniquement) :
   npm run sign:test-cert
   puis : set CSC_LINK=%cd%\certificat-test.pfx && set CSC_KEY_PASSWORD=TestPassword123! && npm run build:electron

2. Production (certificat CA reconnue) :
   - Achetez un certificat de signature de code (DigiCert, Sectigo, etc.)
   - Exportez-le en .PFX avec son mot de passe
   - Configurez CSC_LINK et CSC_KEY_PASSWORD dans un .env à côté du .exe
   - Lancez npm run build:electron
