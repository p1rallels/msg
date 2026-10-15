#!/usr/bin/env bun
import { MODEL } from "./lib.ts";
import { SCENARIOS } from "./scenarios.ts";

type Name = keyof typeof SCENARIOS;

const requested = process.argv.slice(2);
const unknown = requested.filter((name) => !(name in SCENARIOS));
if (unknown.length > 0) {
	console.error(`unknown scenario(s): ${unknown.join(", ")}. known: ${Object.keys(SCENARIOS).join(", ")}`);
	process.exit(2);
}

const names = (requested.length > 0 ? requested : Object.keys(SCENARIOS)) as Name[];
console.log(`e2e with ${MODEL}: ${names.join(", ")} (in parallel, real model calls)`);
const results = await Promise.all(names.map((name) => SCENARIOS[name]()));
const failed = names.filter((_, index) => !results[index]);
console.log(failed.length === 0 ? `\nall ${names.length} scenario(s) passed` : `\nfailed: ${failed.join(", ")}`);
process.exit(failed.length === 0 ? 0 : 1);
