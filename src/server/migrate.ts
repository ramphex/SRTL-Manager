import { resolveDatabaseUrl } from "./config";
import { openDatabase } from "./db/database";

const database = await openDatabase({ databaseUrl: resolveDatabaseUrl(), migrate: true });
await database.close();
