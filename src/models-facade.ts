import type { Models } from "@earendil-works/pi-ai";

/** Override only the observed operations; keep the original method receivers. */
export function modelsFacade<T extends Models>(
  models: T,
  overrides: Partial<Models>,
): T {
  const methods = new Map<PropertyKey, unknown>(Object.entries(overrides));
  return new Proxy(models, {
    get(target, key) {
      if (methods.has(key)) return methods.get(key);
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== "function" || key === "constructor") return value;
      const bound: unknown = value.bind(target);
      methods.set(key, bound);
      return bound;
    },
  });
}
