import { NextRequest, NextResponse } from "next/server";
import {
  getTextFromAIChunk,
  streamGeminiWithFallback,
} from "@/app/(protected)/generate/utils/aiClient";
import { SystemPrompt } from "@/lib/prompts/promptTemplate";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { db } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { generationRateLimit } from "@/lib/rateLimit";
import { getUserApiKeys, type UserApiKeys } from "@/lib/api-keys/getUserApiKeys";
import {
  DEV_BYPASS_USER,
  isDevelopmentAuthBypassEnabled,
} from "@/lib/auth/devBypass";
import {
  aiGenerationRequestsTotal,
  aiGenerationSuccessTotal,
  aiGenerationFailureTotal,
  aiGenerationDurationSeconds,
  aiGenerationOutputSizeBytes,
  userGenerationsTotal,
  userLastActivityTimestamp,
  httpRequestsTotal,
  httpRequestDurationSeconds,
  apiGatewayErrorsTotal,
  databaseQueryDurationSeconds,
} from "@/lib/metrics";

type ParsedOutput = {
  finalAIresponse: string;
  parsedData: Prisma.InputJsonValue;
};

const STREAM_TEST_USER_ID = "__stream_test__";

type GenerateRequestBody = {
  userInput: string;
  userId?: string;
};

async function getOrCreateLocalDevBypassUserId(): Promise<string> {
  // TEMPORARY LOCAL DEVELOPMENT AUTH BYPASS:
  // This creates/uses a mock local user so /generate can be tested in development
  // without real signup/login OAuth configuration.
  const user = await db.user.upsert({
    where: { email: DEV_BYPASS_USER.email },
    update: {
      username: DEV_BYPASS_USER.username,
      isVerified: true,
    },
    create: {
      email: DEV_BYPASS_USER.email,
      username: DEV_BYPASS_USER.username,
      password: "DEV_BYPASS_NO_PASSWORD_LOGIN",
      isVerified: true,
      plan: "enterprise",
    },
    select: { id: true },
  });

  return user.id;
}

function isJsonObject(
  value: Prisma.InputJsonValue,
): value is Record<string, Prisma.InputJsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createSSEEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function parseAIOutput(cleanedOutput: string): ParsedOutput {
  let jsonText = cleanedOutput;

  const jsonStartMarker = "```json";
  const jsonStart = jsonText.indexOf(jsonStartMarker);

  if (jsonStart !== -1) {
    jsonText = jsonText.slice(jsonStart + jsonStartMarker.length);
    const jsonEnd = jsonText.indexOf("```");
    if (jsonEnd !== -1) {
      jsonText = jsonText.slice(0, jsonEnd);
    }
  } else {
    const firstBrace = jsonText.indexOf("{");
    if (firstBrace !== -1) {
      let braceCount = 0;
      let lastBrace = -1;
      for (let i = firstBrace; i < jsonText.length; i++) {
        if (jsonText[i] === "{") braceCount++;
        if (jsonText[i] === "}") {
          braceCount--;
          if (braceCount === 0) {
            lastBrace = i;
            break;
          }
        }
      }
      if (lastBrace !== -1) {
        jsonText = jsonText.slice(firstBrace, lastBrace + 1);
      }
    }
  }

  jsonText = jsonText.trim();
  if (!jsonText) throw new Error("No JSON content found in AI response.");

  const parsedData = JSON.parse(jsonText) as Prisma.InputJsonValue;

  const mermaidStartMarker = "```mermaid";
  const mermaidStart = cleanedOutput.indexOf(mermaidStartMarker);

  if (mermaidStart !== -1) {
    let mermaidText = cleanedOutput.slice(
      mermaidStart + mermaidStartMarker.length,
    );

    const mermaidEnd = mermaidText.indexOf("```");
    if (mermaidEnd !== -1) {
      mermaidText = mermaidText.slice(0, mermaidEnd);
    }

    mermaidText = mermaidText
      .replace(/```mermaid/g, "")
      .replace(/```/g, "")
      .trim();

    if (mermaidText) {
      if (isJsonObject(parsedData)) {
        parsedData["Architecture Diagram"] = mermaidText;
      }
    }
  }

  return {
    finalAIresponse: cleanedOutput,
    parsedData,
  };
}


function tryParsePartialJSON(text: string): Prisma.InputJsonValue | null {
  const jsonStartMarker = "```json";
  let jsonText = text;

  const jsonStart = jsonText.indexOf(jsonStartMarker);
  if (jsonStart !== -1) {
    jsonText = jsonText.slice(jsonStart + jsonStartMarker.length);
  }

  const firstBrace = jsonText.indexOf("{");
  if (firstBrace === -1) return null;

  let braceCount = 0;
  let inString = false;
  let escaped = false;
  let lastBrace = -1;

  for (let i = firstBrace; i < jsonText.length; i++) {
    const ch = jsonText[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{") braceCount++;
    if (ch === "}") {
      braceCount--;
      if (braceCount === 0) {
        lastBrace = i;
        break;
      }
    }
  }

  if (lastBrace === -1) return null;

  const candidate = jsonText.slice(firstBrace, lastBrace + 1).trim();
  try {
    return JSON.parse(candidate) as Prisma.InputJsonValue;
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  const startTime = Date.now();
  const route = "/api/generate";
  const method = "POST";
  httpRequestsTotal.inc({ route, method });

  try {
    const body = await req.json().catch(() => null);
    if (!body || !body.userInput) {
      apiGatewayErrorsTotal.inc({ status_code: "400" });
      httpRequestDurationSeconds.observe(
        { route },
        (Date.now() - startTime) / 1000,
      );
      return NextResponse.json(
        { error: "Invalid request body. Missing 'userInput' field." },
        { status: 400 },
      );
    }

    const { userInput, userId } = body as GenerateRequestBody;
    const isStreamTestModeEnabled = process.env.ENABLE_STREAM_TEST_MODE === "true";
    const isDevelopmentWithoutDatabase =
      process.env.NODE_ENV === "development" &&
      !process.env.DATABASE_URL?.trim();
    // TEMPORARY DEVELOPMENT FALLBACK:
    // When DATABASE_URL is not configured in local development, bypass database-
    // dependent logic so /generate streaming can be tested safely.
    // Remove this once local development always provides a working DATABASE_URL.
    // Production behavior remains unchanged because this is development-only.
    const enableStreamingTestMode =
      isStreamTestModeEnabled &&
      process.env.NODE_ENV !== "production" &&
      req.headers.get("x-stream-test-mode")?.trim() === "1";
    const enableLocalDevAuthBypass =
      isDevelopmentAuthBypassEnabled() &&
      !userId &&
      !enableStreamingTestMode &&
      !isDevelopmentWithoutDatabase;
    // Keep stream-test mode separate from local auth bypass because stream-test has
    // its own dedicated mock-user flow controlled by x-stream-test-mode.

    const bypassUserId = enableLocalDevAuthBypass
      ? await getOrCreateLocalDevBypassUserId()
      : undefined;
    const resolvedUserId = userId ?? bypassUserId;
    const effectiveUserId = resolvedUserId ?? STREAM_TEST_USER_ID;

    if (
      !enableStreamingTestMode &&
      !isDevelopmentWithoutDatabase &&
      !resolvedUserId
    ) {
      apiGatewayErrorsTotal.inc({ status_code: "400" });
      httpRequestDurationSeconds.observe(
        { route },
        (Date.now() - startTime) / 1000,
      );
      return NextResponse.json(
        { error: "Missing userId. You must be logged in to generate." },
        { status: 400 },
      );
    }

    if (!userInput || userInput.trim().length === 0) {
      apiGatewayErrorsTotal.inc({ status_code: "400" });
      httpRequestDurationSeconds.observe(
        { route },
        (Date.now() - startTime) / 1000,
      );
      return NextResponse.json(
        { error: "Invalid input. Please provide a valid project idea." },
        { status: 400 },
      );
    }

    let limit: number | undefined;
    let remaining: number | undefined;
    let reset: number | undefined;
    let userApiKeys: UserApiKeys = {};

    // In development without DATABASE_URL, skip user/rate-limit/key lookups that require Prisma.
    if (!enableStreamingTestMode && !isDevelopmentWithoutDatabase) {
      const userFindStart = Date.now();
      const user = await db.user.findFirst({
        where: {
          id: resolvedUserId,
        },
      });
      databaseQueryDurationSeconds.observe(
        { operation: "findFirst" },
        (Date.now() - userFindStart) / 1000,
      );

      if (!user) {
        apiGatewayErrorsTotal.inc({ status_code: "404" });
        httpRequestDurationSeconds.observe(
          { route },
          (Date.now() - startTime) / 1000,
        );
        return NextResponse.json(
          { status: 404, message: "User not Found" },
          { status: 404 },
        );
      }

      if (user.isVerified === false) {
        apiGatewayErrorsTotal.inc({ status_code: "401" });
        httpRequestDurationSeconds.observe(
          { route },
          (Date.now() - startTime) / 1000,
        );
        return NextResponse.json(
          {
            status: 401,
            message: "Email is not verified",
          },
          { status: 401 },
        );
      }

      const generationCount = await db.generation.count({
        where: { userId: resolvedUserId },
      });

      const planLimits = {
        free: 10,
        pro: 200,
        enterprise: 9999,
      };

      const plan = user.plan as keyof typeof planLimits | undefined;
      const userLimit = plan ? planLimits[plan] : undefined;

      if (userLimit !== undefined && generationCount >= userLimit) {
        apiGatewayErrorsTotal.inc({ status_code: "403" });
        httpRequestDurationSeconds.observe(
          { route },
          (Date.now() - startTime) / 1000,
        );
        return NextResponse.json(
          {
            error: `You have reached your limit of ${userLimit} generations for the ${user.plan} plan.`,
            upgrade: user.plan === "free",
          },
          { status: 403 },
        );
      }

      const rateLimitResult = await generationRateLimit.limit(resolvedUserId!);
      if (!rateLimitResult.success) {
        apiGatewayErrorsTotal.inc({ status_code: "429" });
        httpRequestDurationSeconds.observe(
          { route },
          (Date.now() - startTime) / 1000,
        );
        return NextResponse.json(
          {
            error:
              "Rate limit exceeded. Please wait 2 minutes before making another request.",
          },
          { status: 429 },
        );
      }

      limit = rateLimitResult.limit;
      remaining = rateLimitResult.remaining;
      reset = rateLimitResult.reset;

      userApiKeys = await getUserApiKeys(resolvedUserId!);
    }

    aiGenerationRequestsTotal.inc();
    userLastActivityTimestamp.set({ user_id: effectiveUserId }, Date.now() / 1000);

    const messages = [
      new SystemMessage(SystemPrompt),
      new HumanMessage(userInput),
    ];

    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let streamClosed = false;
        const closeStream = () => {
          if (!streamClosed) {
            streamClosed = true;
            controller.close();
          }
        };
        const onAbort = () => {
          sendEvent("abort", { success: false, message: "Request aborted" });
          closeStream();
        };

        const sendEvent = (event: string, data: unknown) => {
          if (!streamClosed) {
            controller.enqueue(encoder.encode(createSSEEvent(event, data)));
          }
        };
        req.signal.addEventListener("abort", onAbort, { once: true });

        const run = async () => {
          const aiStart = Date.now();

          try {
            sendEvent("start", { success: true });

            const { stream: aiStream } = await streamGeminiWithFallback(
              messages,
              userApiKeys.geminiApiKey,
            );

            let fullResponse = "";

            for await (const chunk of aiStream) {
              const textChunk = getTextFromAIChunk(chunk);
              if (!textChunk) continue;

              fullResponse += textChunk;
              sendEvent("chunk", { chunk: textChunk });

              const partial = tryParsePartialJSON(fullResponse);
              if (partial && isJsonObject(partial)) {
                sendEvent("partial", { partial });
              }
            }

            const aiDuration = (Date.now() - aiStart) / 1000;
            aiGenerationDurationSeconds.observe(aiDuration);

            if (!fullResponse.trim()) {
              throw new Error("Empty AI response received.");
            }

            const { finalAIresponse, parsedData } = parseAIOutput(fullResponse);

            if (
              !enableStreamingTestMode &&
              !isDevelopmentWithoutDatabase &&
              resolvedUserId
            ) {
              // Development fallback intentionally skips persistence when DATABASE_URL is missing.
              const createGenerationStart = Date.now();
              await db.generation.create({
                data: {
                  userInput,
                  generatedOutput: parsedData,
                  userId: resolvedUserId,
                },
              });
              databaseQueryDurationSeconds.observe(
                { operation: "create" },
                (Date.now() - createGenerationStart) / 1000,
              );
            }

            aiGenerationSuccessTotal.inc();
            userGenerationsTotal.inc({ user_id: effectiveUserId });
            userLastActivityTimestamp.set(
              { user_id: effectiveUserId },
              Date.now() / 1000,
            );
            aiGenerationOutputSizeBytes.set(JSON.stringify(parsedData).length);

            sendEvent("done", {
              success: true,
              output: finalAIresponse,
              ...(limit !== undefined ? { limit } : {}),
              ...(remaining !== undefined ? { remaining } : {}),
              ...(reset !== undefined ? { reset } : {}),
            });
          } catch (error: unknown) {
            aiGenerationFailureTotal.inc();
            console.error("Error generating streamed response:", error);

            let status = 500;
            const errorMessage =
              error instanceof Error ? error.message : "Unknown error";

            const isApiKeyError =
              errorMessage.toLowerCase().includes("api key") ||
              errorMessage.toLowerCase().includes("rate limit") ||
              errorMessage.toLowerCase().includes("quota") ||
              errorMessage.toLowerCase().includes("unauthorized") ||
              errorMessage.toLowerCase().includes("authentication");

            if (
              typeof error === "object" &&
              error !== null &&
              "code" in error &&
              error.code === "P2002"
            ) {
              status = 409;
            } else if (isApiKeyError) {
              status = 503;
            } else if (errorMessage.includes("AI")) {
              status = 502;
            } else if (
              errorMessage.includes("No JSON content found") ||
              errorMessage.includes("Unexpected end of JSON input")
            ) {
              status = 422;
            }

            apiGatewayErrorsTotal.inc({ status_code: status.toString() });
            sendEvent("error", {
              success: false,
              status,
              error:
                errorMessage ||
                "An unexpected server error occurred while generating the response.",
            });
          } finally {
            req.signal.removeEventListener("abort", onAbort);
            httpRequestDurationSeconds.observe(
              { route },
              (Date.now() - startTime) / 1000,
            );
            closeStream();
          }
        };

        run().catch((unhandledError) => {
          console.error("Unhandled stream execution error:", unhandledError);
          closeStream();
        });
      },
      cancel() {
        // Readable stream cancellation is expected when clients disconnect.
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error: unknown) {
    aiGenerationFailureTotal.inc();
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("Error initializing stream:", error);
    apiGatewayErrorsTotal.inc({ status_code: "500" });
    httpRequestDurationSeconds.observe(
      { route },
      (Date.now() - startTime) / 1000,
    );
    return NextResponse.json(
      {
        error:
          errorMessage ||
          "An unexpected server error occurred while initializing the response stream.",
      },
      { status: 500 },
    );
  }
}
