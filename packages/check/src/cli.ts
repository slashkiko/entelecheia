#!/usr/bin/env node
import { main } from "./main.js";

/** `ent-check` の入口。ent とは別の bin にする。中身は `src/main.ts` にある */
process.exitCode = await main(process.argv.slice(2));
