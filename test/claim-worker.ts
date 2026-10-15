import { claim, pending } from "../src/core/maildir.ts";

const [root, id] = process.argv.slice(2);
if (!root || !id) throw new Error("usage: claim-worker <root> <id>");

const claimed = pending(root, id).flatMap((file) => {
	const result = claim(root, id, file);
	return result?.kind === "message" ? [result.message.text] : [];
});

process.stdout.write(claimed.map((text) => `${text}\n`).join(""));
