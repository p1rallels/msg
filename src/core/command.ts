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
