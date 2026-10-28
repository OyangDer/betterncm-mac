/**
 * @fileoverview
 * betterncm-mac: helpers for NCM 3.x on macOS (CEF, driven over CDP)
 */

export const isMac = () => navigator.platform.startsWith("Mac");

/**
 * Walks the React fiber tree under `#root` (depth first, bounded) and returns
 * the first `memoizedProps[key]` that passes `test`.
 * Used to reach the dva store and the in-memory router history, which are not
 * exposed on `window`.
 */
// rome-ignore lint/suspicious/noExplicitAny: React internals are untyped
export function findReactProp<T = any>(
	key: string,
	// rome-ignore lint/suspicious/noExplicitAny: React internals are untyped
	test: (value: any) => boolean = (value) => !!value,
	limit = 20000,
): T | null {
	// rome-ignore lint/suspicious/noExplicitAny: React internals are untyped
	const root = document.getElementById("root") as any;
	const first = root?._reactRootContainer?._internalRoot?.current;
	const stack = first ? [first] : [];
	for (let visited = 0; stack.length > 0 && visited < limit; visited++) {
		const fiber = stack.pop();
		const value = fiber.memoizedProps?.[key];
		if (value && typeof value === "object" && test(value)) return value;
		if (fiber.sibling) stack.push(fiber.sibling);
		if (fiber.child) stack.push(fiber.child);
	}
	return null;
}
