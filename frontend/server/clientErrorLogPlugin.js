export function clientErrorLogPlugin() {
  return {
    name: "client-error-log",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__dev/client-error", (req, res, next) => {
        if (req.method !== "POST") return next();
        let body = "";
        let tooLarge = false;
        req.setEncoding("utf8");
        req.on("data", (chunk) => {
          body += chunk;
          if (body.length > 8_192) tooLarge = true;
        });
        req.on("end", () => {
          if (tooLarge) {
            res.statusCode = 413;
            return res.end();
          }

          try {
            const entry = JSON.parse(body);
            const context = typeof entry.context === "string" ? entry.context.slice(0, 80) : "frontend";
            const message = typeof entry.message === "string" ? entry.message.slice(0, 2_000) : "Erreur inconnue";
            server.config.logger.error(`[client:${context}] ${message}`);
          } catch (error) {
            server.config.logger.error("[client] Journal d’erreur invalide.", { error });
          }
          res.statusCode = 204;
          return res.end();
        });
      });
    },
  };
}
