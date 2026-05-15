import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { DOC_ROUTES } from "@/lib/routes";

import { ArchitectureData } from "../utils/types";

interface GenerateResponse {
  success: boolean;
  output: string;
}

type SSEEventPayload = {
  success?: boolean;
  chunk?: string;
  output?: string;
  partial?: Partial<ArchitectureData>;
  error?: string;
  status?: number;
  message?: string;
};

type ErrorBody = {
  error?: string;
  message?: string;
};

function isErrorBody(value: unknown): value is ErrorBody {
  return (
    typeof value === "object" &&
    value !== null &&
    ("error" in value || "message" in value)
  );
}

export function useGenerateSystem(refetchHistory?: () => Promise<void>) {
  const { data: session } = useSession();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [streamedOutput, setStreamedOutput] = useState("");
  const [partialData, setPartialData] = useState<Partial<ArchitectureData> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const stopGeneration = useCallback(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
  }, []);

  useEffect(() => {
    return () => {
      stopGeneration();
    };
  }, [stopGeneration]);

  const parseSSEMessage = (rawEvent: string) => {
    const lines = rawEvent.split(/\r?\n/);
    let event = "message";
    const dataLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
    }

    const normalizedData = dataLines.join("\n");
    if (!normalizedData) return null;

    let payload: SSEEventPayload;
    try {
      payload = JSON.parse(normalizedData) as SSEEventPayload;
    } catch {
      payload = { error: "Failed to parse streaming payload" };
    }

    return { event, payload };
  };

  const generate = async (
    userInput: string,
  ): Promise<GenerateResponse | null> => {
    // @ts-expect-error accessToken is added to session in NextAuth callbacks
    if (!session?.user?.accessToken) {
      setError("No access token available. Please log in.");
      return null;
    }

    stopGeneration();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setIsLoading(true);
    setError(null);
    setStreamedOutput("");
    setPartialData(null);

    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

    try {
      const response = await fetch(DOC_ROUTES.API.GENERATE.ROOT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          userInput,
          // @ts-expect-error id is added to session in NextAuth callbacks
          userId: session?.user?.id ?? undefined,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const parsedErrorBody = await response.json().catch(() => null);
        const errorBody = isErrorBody(parsedErrorBody) ? parsedErrorBody : null;
        const message =
          errorBody?.error ||
          errorBody?.message ||
          `Request failed with status ${response.status}`;
        throw new Error(message);
      }

      if (!response.body) {
        throw new Error("Readable stream is not available.");
      }

      reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      let finalResult: GenerateResponse | null = null;
      const eventSeparator = /\r?\n\r?\n/;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        let separatorMatch = eventSeparator.exec(buffer);
        let separatorIndex = separatorMatch ? separatorMatch.index : -1;
        while (separatorIndex !== -1) {
          const rawEvent = buffer.slice(0, separatorIndex);
          const separatorLength = separatorMatch?.[0].length ?? 2;
          buffer = buffer.slice(separatorIndex + separatorLength);

          const parsed = parseSSEMessage(rawEvent);
          if (!parsed) {
            separatorMatch = eventSeparator.exec(buffer);
            separatorIndex = separatorMatch ? separatorMatch.index : -1;
            continue;
          }

          const { event, payload } = parsed;

          if (event === "chunk" && payload.chunk) {
            setStreamedOutput((prev) => prev + payload.chunk);
          } else if (event === "partial" && payload.partial) {
            setPartialData((prev) => ({ ...(prev ?? {}), ...payload.partial }));
          } else if (event === "done" && payload.output) {
            finalResult = {
              success: true,
              output: payload.output,
            };
          } else if (event === "abort") {
            throw new DOMException(
              payload.message || "Generation was cancelled.",
              "AbortError",
            );
          } else if (event === "error") {
            throw new Error(payload.error || "Failed to stream AI response.");
          }

          separatorMatch = eventSeparator.exec(buffer);
          separatorIndex = separatorMatch ? separatorMatch.index : -1;
        }
      }

      if (buffer.trim()) {
        const parsed = parseSSEMessage(buffer.trim());
        if (parsed) {
          const { event, payload } = parsed;
          if (event === "chunk" && payload.chunk) {
            setStreamedOutput((prev) => prev + payload.chunk);
          } else if (event === "partial" && payload.partial) {
            setPartialData((prev) => ({ ...(prev ?? {}), ...payload.partial }));
          } else if (event === "done" && payload.output) {
            finalResult = {
              success: true,
              output: payload.output,
            };
          } else if (event === "error") {
            throw new Error(payload.error || "Failed to stream AI response.");
          }
        }
      }

      if (finalResult?.success && refetchHistory) {
        await refetchHistory();
      }

      return finalResult;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        setError("Generation was cancelled.");
        return null;
      }

      const errorMessage =
        err instanceof Error ? err.message : "An error occurred";
      setError(errorMessage);
      return null;
    } finally {
      if (controller.signal.aborted) {
        await reader?.cancel().catch((cancelError) => {
          console.warn("Failed to cancel stream reader:", cancelError);
        });
      }
      reader?.releaseLock();
      abortControllerRef.current = null;
      setIsLoading(false);
    }
  };

  return {
    generate,
    stopGeneration,
    streamedOutput,
    partialData,
    isLoading,
    error,
  };
}
