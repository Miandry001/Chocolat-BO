import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { clientErrorLogPlugin } from "./server/clientErrorLogPlugin.js";
import { sheetsPlugin } from "./server/sheetsPlugin.js";

export default defineConfig(async ({ mode }) => {
  // Variables sans préfixe VITE_ : lues uniquement côté serveur, jamais exposées au navigateur.
  const env = loadEnv(mode, process.cwd(), "");
  const apiTarget = env.API_TARGET ?? "http://localhost:3001";
  const isProduction = mode === "production";
  const apiTargetUrl = new URL(apiTarget);
  const connectSrc = isProduction ? apiTargetUrl.origin : "ws://localhost:5173 ws://127.0.0.1:5173";
  const securityHeaders = {
    "Content-Security-Policy": `default-src 'self'; base-uri 'self'; object-src 'none'; script-src 'self'; worker-src 'self' blob:; form-action 'self'; frame-ancestors 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; connect-src 'self' ${connectSrc}`,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
  };
  return {
    server: {
      // React Fast Refresh injecte un petit module inline en développement seulement.
      headers: { ...securityHeaders, "Content-Security-Policy": securityHeaders["Content-Security-Policy"].replace("script-src 'self'", "script-src 'self' 'unsafe-inline'") },
      watch: { usePolling: true, interval: 1000 },
      proxy: {
        "/api/v1": { target: apiTarget, changeOrigin: true },
      },
    },
    preview: { headers: securityHeaders },
    // Exposer API_TARGET au frontend en production avec le préfixe VITE_
    define: {
      'import.meta.env.VITE_API_TARGET': JSON.stringify(apiTarget),
      'import.meta.env.VITE_SYNC_URL': JSON.stringify(env.SYNC_URL || ''),
    },
    plugins: [
      react(),
      clientErrorLogPlugin(),
      sheetsPlugin({
        keyFile: env.GOOGLE_CREDENTIALS ?? "secrets/creds.json",
        sheetId: env.SHEET_ID,
        driveFolderId: env.GOOGLE_DRIVE_FOLDER_ID,
        appOrigin: env.APP_ORIGIN,
        authApiTarget: apiTarget,
        // Seul l'onglet « référent » est lu ; les autres onglets du fichier sont ignorés.
        range: env.SHEET_RANGE ?? "'référent'!A:ZZ",
      }),
    ],
  };
});
