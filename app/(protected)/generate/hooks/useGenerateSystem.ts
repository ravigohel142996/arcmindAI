import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { DOC_ROUTES } from "@/lib/routes";

interface GenerateResponse {
  success: boolean;
  output: string;
}

type SSEEventPayload = {
  success?: boolean;
  chunk?: string;
  output?: string;
  error?: string;
  status?: number;
};

export function useGenerateSystem(refetchHistory?: () => Promise<void>) {
  const { data: session } = useSession();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [streamedOutput, setStreamedOutput] = useState("");
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
    const lines = rawEvent.split("\n");
    let event = "message";
    let data = "";

    for (const line of lines) {
      if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        data += line.slice(5).trim();
      }
    }

    if (!data) return null;

    let payload: SSEEventPayload;
    try {
      payload = JSON.parse(data) as SSEEventPayload;
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
          userId: session?.user.id,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = (await response.json().catch(() => null)) as
          | { error?: string; message?: string }
          | null;
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

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        let separatorIndex = buffer.indexOf("\n\n");
        while (separatorIndex !== -1) {
          const rawEvent = buffer.slice(0, separatorIndex);
          buffer = buffer.slice(separatorIndex + 2);

          const parsed = parseSSEMessage(rawEvent);
          if (!parsed) {
            separatorIndex = buffer.indexOf("\n\n");
            continue;
          }

          const { event, payload } = parsed;

          if (event === "chunk" && payload.chunk) {
            setStreamedOutput((prev) => prev + payload.chunk);
          } else if (event === "done" && payload.output) {
            finalResult = {
              success: true,
              output: payload.output,
            };
          } else if (event === "error") {
            throw new Error(payload.error || "Failed to stream AI response.");
          }

          separatorIndex = buffer.indexOf("\n\n");
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
      reader?.releaseLock();
      abortControllerRef.current = null;
      setIsLoading(false);
    }
  };

  return {
    generate,
    stopGeneration,
    streamedOutput,
    isLoading,
    error,
  };
}
