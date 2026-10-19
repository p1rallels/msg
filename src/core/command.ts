import type { Presence } from "./registry.ts";

export interface MsgCommand {
	readonly to: string;
	readonly text: string;
}

export const MSG_COMMAND_USAGE = "usage: /msg <to> <text>. <to>: parent, children, a folder (/…, ~/…, ./…), a session name, id or id prefix";

/** `/msg <to> <text>`: `to` is the first word, or a quoted string (a folder with spaces); the rest is the text. */
export const parseMsgCommand = (args: string): MsgCommand | undefined => {
	const trimmed = args.trim();
	const quote = trimmed[0] === '"' || trimmed[0] === "'" ? trimmed[0] : undefined;
	const end = quote ? trimmed.indexOf(quote, 1) : trimmed.search(/\s/);
	if (end <= 0) return undefined;
	const to = quote ? trimmed.slice(1, end) : trimmed.slice(0, end);
	const text = trimmed.slice(end + 1).trim();
	return to.trim() && text ? { to: to.trim(), text } : undefined;
};

export interface Completion {
	readonly value: string;
	readonly label: string;
	readonly description?: string;
}

const addressOf = (record: Presence): string => {
	if (!record.name) return record.id;
	return /\s/.test(record.name) ? `"${record.name}"` : record.name;
};

/** What `/msg <prefix>` completes to while the recipient is being typed: parent, children, then live sessions, family first. */
export const recipientCompletions = (prefix: string, live: readonly Presence[], self: Pick<Presence, "id" | "parent">): Completion[] | null => {
	if (/\s/.test(prefix.trimStart())) return null;
	const wanted = prefix.trim().replace(/^["']/, "").toLowerCase();
	const others = live.filter((record) => record.id !== self.id);
	const children = others.filter((record) => record.parent === self.id);
	const rank = (record: Presence): number => (record.id === self.parent ? 0 : record.parent === self.id ? 1 : 2);
	const candidates: Completion[] = [
		...(self.parent ? [{ value: "parent", label: "parent", description: self.parent }] : []),
		...(children.length > 0 ? [{ value: "children", label: "children", description: `every live child (${children.length})` }] : []),
		...[...others]
			.sort((a, b) => rank(a) - rank(b))
			.map((record) => ({ value: addressOf(record), label: record.name ?? record.id.slice(0, 8), description: `${record.id} · ${record.mode} · ${record.activity}` })),
	];
	const matches = candidates.filter((item) => item.label.toLowerCase().startsWith(wanted) || item.value.replace(/^"/, "").toLowerCase().startsWith(wanted));
	return matches.length > 0 ? matches : null;
};
