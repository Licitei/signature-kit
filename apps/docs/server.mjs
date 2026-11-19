import { fetch } from "./foldkit/host.mjs";

Bun.serve({ port: Number(process.env.PORT ?? 3001), fetch });
