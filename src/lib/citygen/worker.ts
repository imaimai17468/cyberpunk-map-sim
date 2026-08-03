/// <reference lib="webworker" />
import { generationParamsSchema } from "@/entities/city";
import { generateCity } from "./pipeline";

/**
 * The generation worker.
 *
 * Stateless between jobs, which is what makes supersede-by-terminate safe: the
 * lifecycle machine kills the worker outright rather than cooperatively
 * cancelling, and a killed job leaves nothing behind to clean up. Because
 * generation is deterministic, abandoned partial work is worthless by
 * construction — rerunning the same seed reproduces it exactly.
 */

interface InboundJob {
  readonly requestId: number;
  readonly params: unknown;
}

const isInboundJob = (value: unknown): value is InboundJob =>
  typeof value === "object" &&
  value !== null &&
  typeof Reflect.get(value, "requestId") === "number";

const post = (
  message: unknown,
  transfer: readonly Transferable[] = []
): void => {
  // `postMessage` inside a module worker is the global; the transfer list is
  // the second argument, not a target origin.
  self.postMessage(message, [...transfer]);
};

self.addEventListener("message", (event: MessageEvent<unknown>) => {
  const data: unknown = event.data;
  if (!isInboundJob(data)) return;
  const { requestId } = data;

  const parsed = generationParamsSchema.safeParse(data.params);
  if (!parsed.success) {
    post({
      kind: "failure",
      requestId,
      message: `Invalid parameters: ${parsed.error.issues
        .map((issue) => issue.message)
        .join("; ")}`,
    });
    return;
  }

  try {
    const model = generateCity(parsed.data, {
      onProgress: (stageIndex) => {
        post({ kind: "progress", requestId, stageIndex });
      },
    });
    post({ kind: "success", requestId, model });
  } catch (cause: unknown) {
    post({
      kind: "failure",
      requestId,
      message: cause instanceof Error ? cause.message : "Generation failed.",
    });
  }
});
