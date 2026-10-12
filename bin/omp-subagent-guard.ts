#!/usr/bin/env bun
import { main } from "../src/cli";

const code = await main(process.argv.slice(2), {
	out: text => process.stdout.write(text),
	err: text => process.stderr.write(text),
});
process.exit(code);
