export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });

export const fail = <T = never>(error: string): Result<T> => ({ ok: false, error });

export const unwrap = <T>(result: Result<T>): T => {
	if (result.ok) return result.value;
	throw new Error(result.error);
};
