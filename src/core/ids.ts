import { randomBytes } from "node:crypto";

export type RandomHex = (bytes: number) => string;

export const randomHex: RandomHex = (bytes) => randomBytes(bytes).toString("hex");

/** Time-sortable message id: base36 epoch ms (fixed width) + random suffix, e.g. `0mgqk3x2p-a1b2c3`. */
export const newMessageId = (now: number, random: RandomHex = randomHex): string =>
	`${Math.max(0, Math.floor(now)).toString(36).padStart(9, "0")}-${random(3)}`;

export const timeOfMessageId = (id: string): number | undefined => {
	const stamp = id.split("-")[0];
	if (!stamp || !/^[0-9a-z]{9}$/.test(stamp)) return undefined;
	const value = Number.parseInt(stamp, 36);
	return Number.isFinite(value) ? value : undefined;
};
