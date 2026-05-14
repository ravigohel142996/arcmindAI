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
import { getUserApiKeys } from "@/lib/api-keys/getUserApiKeys";
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
      if (typeof parsedData === "object" && parsedData !== null) {
        (parsedData as Record<string, unknown>)["Architecture Diagram"] =
          mermaidText;
      }
    }
  }

  return {
    finalAIresponse: cleanedOutput,
    parsedData,
  };
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

    const { userInput, userId } = body as {
      userInput: string;
      userId?: string;
    };

    if (!userId) {
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

    const userFindStart = Date.now();
    const user = await db.user.findFirst({
      where: {
        id: userId,
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
      where: { userId },
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

    const { success, limit, remaining, reset } =
      await generationRateLimit.limit(userId);
    if (!success) {
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

    aiGenerationRequestsTotal.inc();
    userLastActivityTimestamp.set({ user_id: userId }, Date.now() / 1000);

    const messages = [
      new SystemMessage(SystemPrompt),
      new HumanMessage(userInput),
    ];
    const userApiKeys = await getUserApiKeys(userId);

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

        const sendEvent = (event: string, data: unknown) => {
          if (!streamClosed) {
            controller.enqueue(encoder.encode(createSSEEvent(event, data)));
          }
        };

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
              if (req.signal.aborted) {
                sendEvent("abort", { success: false, message: "Request aborted" });
                closeStream();
                return;
              }

              const textChunk = getTextFromAIChunk(chunk);
              if (!textChunk) continue;

              fullResponse += textChunk;
              sendEvent("chunk", { chunk: textChunk });
            }

            const aiDuration = (Date.now() - aiStart) / 1000;
            aiGenerationDurationSeconds.observe(aiDuration);

            if (!fullResponse.trim()) {
              throw new Error("Empty AI response received.");
            }

            const { finalAIresponse, parsedData } = parseAIOutput(fullResponse);

            const createGenerationStart = Date.now();
            await db.generation.create({
              data: {
                userInput,
                generatedOutput: parsedData,
                userId,
              },
            });
            databaseQueryDurationSeconds.observe(
              { operation: "create" },
              (Date.now() - createGenerationStart) / 1000,
            );

            aiGenerationSuccessTotal.inc();
            userGenerationsTotal.inc({ user_id: userId });
            userLastActivityTimestamp.set({ user_id: userId }, Date.now() / 1000);
            aiGenerationOutputSizeBytes.set(JSON.stringify(parsedData).length);

            sendEvent("done", {
              success: true,
              output: finalAIresponse,
              limit,
              remaining,
              reset,
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
            httpRequestDurationSeconds.observe(
              { route },
              (Date.now() - startTime) / 1000,
            );
            closeStream();
          }
        };

        void run();
      },
      cancel() {
        req.signal.throwIfAborted();
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
