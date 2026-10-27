import { loadEnv } from "../config.js";
import { createDb } from "./client.js";

const env = loadEnv();
const handle = createDb(env.DATABASE_URL);
await handle.migrate();
await handle.close();
console.log("migrations applied");
