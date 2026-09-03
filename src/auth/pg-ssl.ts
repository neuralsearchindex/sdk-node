/**
 * Optional TLS for the shared Postgres (e.g. a managed/RDS instance). Enabled when both
 * DATABASE_CA_PATH and DATABASE_CA_PEM are set: appends `sslmode=require` + the CA path to
 * the connection URL and hands the CA PEM to the pg driver. A no-op (`ssl: false`, plain
 * connection) otherwise, so local/dev Postgres is unaffected.
 *
 * Returns the `{ clientUrl, driverOptions }` pair to spread straight into `MikroORM.init`.
 */
export function pgSslOptions(baseUrl: string): {
  clientUrl: string;
  driverOptions: { connection: { ssl: false | { rejectUnauthorized: boolean; ca: string | undefined } } };
} {
  const useSSL = Boolean(process.env.DATABASE_CA_PATH && process.env.DATABASE_CA_PEM);
  let clientUrl = baseUrl;
  if (useSSL) {
    clientUrl += `${clientUrl.includes("?") ? "&" : "?"}sslmode=require&sslrootcert=${process.env.DATABASE_CA_PATH}`;
  }
  return {
    clientUrl,
    driverOptions: {
      connection: {
        ssl: useSSL ? { rejectUnauthorized: false, ca: process.env.DATABASE_CA_PEM || undefined } : false,
      },
    },
  };
}
