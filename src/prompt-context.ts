type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value);

/** Apply only constraints returned by Salesforce's live type validator. */
export function repairPromptContext(value: ObjectValue, message: string): boolean {
  let changed = false;
  const set = (path: string, next: unknown, remove = false) => {
    const parts = path.replace(/^\$\./, "").split(".");
    if (parts.length > 12 || parts.some(key => !/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(key) ||
        ["__proto__", "constructor", "prototype"].includes(key))) return;
    let parent = value;
    for (const key of parts.slice(0, -1)) {
      if (!Object.hasOwn(parent,key) || !object(parent[key])) parent[key] = Object.create(null);
      parent = parent[key] as ObjectValue;
    }
    const key = parts.at(-1)!;
    if (remove) { if (Object.hasOwn(parent, key)) { delete parent[key]; changed = true; } }
    else if (JSON.stringify(parent[key]) !== JSON.stringify(next)) { parent[key] = next; changed = true; }
  };
  const sample = (path: string, type: string): unknown => {
    if (type === "array") return [];
    if (type === "object") return {};
    if (["integer", "number"].includes(type)) return 0;
    if (type === "boolean") return false;
    if (type === "null") return null;
    if (/timestamp|datetime/i.test(path)) return new Date().toISOString().replace("Z", "+0000");
    if (/id$/i.test(path)) return crypto.randomUUID();
    return "Action Searcher temporary validation";
  };
  for (const match of message.matchAll(/(\$\.[A-Za-z0-9_.]+): is missing but it is required/g)) {
    set(match[1], /timestamp|datetime|channel|id$/i.test(match[1]) ? sample(match[1], "string") : {});
  }
  for (const match of message.matchAll(/(\$\.[A-Za-z0-9_.]+): [a-z]+ found, (object|array|string|integer|number|boolean|null) expected/g)) {
    set(match[1], sample(match[1], match[2]));
  }
  for (const match of message.matchAll(/property defined at (\$\.[A-Za-z0-9_.]+) because the `additionalProperties` keyword value is set to false/g)) {
    set(match[1], undefined, true);
  }
  for (const match of message.matchAll(/(\$\.[A-Za-z0-9_.]+): does not match the regex pattern ([^;]+)/g)) {
    const candidates = [new Date().toISOString().replace("Z", "+0000"), new Date().toISOString(),
      new Date().toISOString().slice(0, 10)];
    // Avoid evaluating arbitrary regexes from remote diagnostic text.
    if (/\[0-9\]\{4\}.*T.*\[-\+\]/.test(match[2])) set(match[1], candidates[0]);
  }
  return changed;
}

export function inferredContextSchema(value: unknown, depth = 0): ObjectValue {
  if (depth > 12) return {};
  if (Array.isArray(value)) return { type: "array", ...(value.length ? { items: inferredContextSchema(value[0], depth + 1) } : {}) };
  if (object(value)) return { type: "object", properties: Object.fromEntries(Object.entries(value)
    .map(([key, child]) => [key, inferredContextSchema(child, depth + 1)])) };
  return { type: value === null ? "null" : typeof value === "number" && Number.isInteger(value) ? "integer" : typeof value };
}
