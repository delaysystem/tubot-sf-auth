import { backoffDelayMs } from "./retry-backoff";

type Result = { status: number; ok: boolean; body: unknown };
// Retry seed. Origin: the pre-existing fixed 2000ms delay in this file.
const METADATA_RETRY_BASE_MS = 2000;
/** A new graph can precede its definition index. Retry only this read and exact missing-definition rejection. */
export async function readOwnedGraphMetadata(input: {
  invoke: () => Promise<Result>;
  activate?: () => Promise<Result>;
  wait: (milliseconds: number) => Promise<void>;
}): Promise<Result> {
  for (let attempt = 0; ; attempt++) {
    const result = await input.invoke();
    if (attempt >= 9 || !missingGraphDefinition(result.body)) return result;
    if (attempt === 0 && input.activate) {
      const activated = await input.activate();
      const accepted = activated.ok && activated.body !== null && typeof activated.body === "object" &&
        !Array.isArray(activated.body) && (activated.body as Record<string, unknown>).success === true;
      if (!accepted) return activated;
    }
    await input.wait(backoffDelayMs(attempt, METADATA_RETRY_BASE_MS));
  }
}

export function missingGraphDefinition(body: unknown): boolean {
  const messages: string[] = [];
  const visit = (value: unknown, depth = 0): void => {
    if (depth > 6) return;
    if (Array.isArray(value)) value.forEach(item => visit(item, depth + 1));
    else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
      if ((key === 'message' || key === 'errorMessage') && typeof child === 'string') messages.push(child);
      else if (child && typeof child === 'object') visit(child, depth + 1);
    }
  };
  visit(body);
  return messages.some(message => /DataGraph not found with definition ID/i.test(message));
}
