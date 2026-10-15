const GENERIC_ERROR_MESSAGE = "Une erreur est survenue!";

export function reportClientError(context, error) {
  const message = error instanceof Error ? error.message : String(error);
  if (import.meta.env.DEV) {
    console.error(`[${context}] ${message}`, error);
    fetch("/__dev/client-error", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ context, message }),
      keepalive: true,
    }).catch((loggingError) => {
      console.error("[vite-client-error-log] Impossible d’écrire l’erreur dans le terminal Vite.", loggingError);
    });
  } else {
    console.error(`[${context}] Une erreur est survenue.`);
  }
}

export function userErrorMessage(context, error) {
  reportClientError(context, error);
  return GENERIC_ERROR_MESSAGE;
}
