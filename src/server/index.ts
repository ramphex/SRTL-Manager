import { createApp } from "./app";

const { app, config } = await createApp();

try {
  await app.listen({ host: config.host, port: config.port });
  app.log.info(`SRTL Manager API listening on http://${config.host}:${config.port}`);
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
