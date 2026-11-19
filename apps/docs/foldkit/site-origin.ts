const productionHost =
  typeof process === "undefined" ? undefined : process.env.VERCEL_PROJECT_PRODUCTION_URL;

export const siteOrigin =
  productionHost !== undefined && productionHost.length > 0
    ? `https://${productionHost}`
    : "https://signaturekit.dev";
