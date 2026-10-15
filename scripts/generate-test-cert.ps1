# Script PowerShell pour générer un certificat de signature de code auto-signé (test uniquement)
# Ce certificat n'est valide que sur la machine locale — il ne fonctionnera pas sur d'autres postes.
# Pour un déploiement en production, utilisez un certificat délivré par une Autorité de Certification (CA) reconnue.

param(
  [string]$CertPath = "certificat-test.pfx",
  [string]$Password = "TestPassword123!",
  [string]$Subject = "CN=Chocolat Backoffice Test"
)

$ErrorActionPreference = "Stop"

Write-Host "Génération d'un certificat de signature de code auto-signé pour les tests..."
Write-Host "  Fichier : $CertPath"
Write-Host "  Sujet   : $Subject"
Write-Host ""

$thumbprint = New-SelfSignedCertificate `
  -Subject $Subject `
  -KeyUsage DigitalSignature `
  -FriendlyName "Chocolat Backoffice Test Certificate" `
  -CertStoreLocation "Cert:\CurrentUser\My" `
  -NotAfter (Get-Date).AddYears(1)

$certBytes = $thumbprint.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pkcs12, $Password)
[System.IO.File]::WriteAllBytes($CertPath, $certBytes)

Write-Host "Certificat généré : $CertPath"
Write-Host ""
Write-Host "Pour signer l'application, lancez :"
Write-Host "  set CSC_LINK=$PWD\\$CertPath && set CSC_KEY_PASSWORD=$Password && npm run build:electron"
Write-Host ""
Write-Host "NOTE : Ce certificat est auto-signé et ne sera pas reconnu par les postes clients."
Write-Host "      Utilisez-le uniquement pour tester le processus de signature."
Write-Host "      Pour la production, achetez un certificat de signature de code auprès d'une CA."
