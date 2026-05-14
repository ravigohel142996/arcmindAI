// src/app/generate/utils/aiClient.ts
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { AIMessageChunk, BaseMessage } from "@langchain/core/messages";
// import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";

// ✅ Core Gemini LLM setup (LangChain compatible)
const geminiLLM = new ChatGoogleGenerativeAI({
  model: "gemini-2.5-flash-lite",
  temperature: 0.7,
  apiKey: process.env.GEMINI_API_KEY,
});

const geminiLLM_2 = new ChatGoogleGenerativeAI({
  model: "gemini-2.5-flash-lite",
  temperature: 0.7,
  apiKey: process.env.GEMINI_API_KEY_UNSECURED,
});

/**
 * Creates a Gemini client with a custom API key
 */
function createGeminiClient(apiKey: string): ChatGoogleGenerativeAI {
  return new ChatGoogleGenerativeAI({
    model: "gemini-2.5-flash-lite",
    temperature: 0.7,
    apiKey,
  });
}

/**
 * Checks if an error indicates we should fallback to the next API key
 */
function shouldFallback(error: unknown): boolean {
  if (!error) return false;

  const errorMessage =
    error instanceof Error
      ? error.message.toLowerCase()
      : String(error).toLowerCase();
  const errorString = JSON.stringify(error).toLowerCase();

  // Check for rate limit errors
  if (
    errorMessage.includes("too many requests") ||
    errorMessage.includes("rate limit") ||
    errorMessage.includes("quota exceeded") ||
    errorMessage.includes("quota") ||
    errorString.includes("429") ||
    errorString.includes("resource_exhausted")
  ) {
    return true;
  }

  // Check for API key or API not found errors
  if (
    errorMessage.includes("api key not found") ||
    errorMessage.includes("invalid api key") ||
    errorMessage.includes("api key") ||
    errorMessage.includes("api not found") ||
    errorMessage.includes("authentication") ||
    errorMessage.includes("unauthorized") ||
    errorString.includes("401") ||
    errorString.includes("403") ||
    errorString.includes("404") ||
    errorString.includes("permission_denied") ||
    errorString.includes("not_found")
  ) {
    return true;
  }

  return false;
}

export type FallbackResult = {
  response: Awaited<ReturnType<typeof geminiLLM.invoke>>;
  usedUserKey: boolean;
  allKeysFailed: boolean;
};

export type StreamFallbackResult = {
  stream: Awaited<ReturnType<typeof geminiLLM.stream>>;
  usedUserKey: boolean;
  allKeysFailed: boolean;
};

/**
 * Invokes the Gemini LLM with automatic three-tier fallback:
 * 1. User's personal API key (if provided)
 * 2. System API key 1 (GEMINI_API_KEY_UNSECURED)
 * 3. System API key 2 (GEMINI_API_KEY)
 *
 * @param messages - The messages to send to the LLM
 * @param userApiKey - Optional user's personal API key (decrypted)
 * @returns Object containing response and metadata about which key was used
 */
export async function invokeGeminiWithFallback(
  messages: BaseMessage[],
  userApiKey?: string,
): Promise<FallbackResult> {
  let usedUserKey = false;
  let allKeysFailed = false;

  // Tier 1: Try user's personal API key first (if provided)
  if (userApiKey) {
    try {
      console.log("Attempting Gemini generation with user's personal API key");
      const userClient = createGeminiClient(userApiKey);
      const response = await userClient.invoke(messages);
      usedUserKey = true;
      return { response, usedUserKey, allKeysFailed };
    } catch (error) {
      console.warn(
        "User's Gemini API key failed, falling back to system keys:",
        error,
      );
      // Continue to system keys
    }
  }

  // Tier 2: Try primary system API key
  try {
    console.log("Attempting Gemini generation with primary system API key");
    const response = await geminiLLM.invoke(messages);
    return { response, usedUserKey, allKeysFailed };
  } catch (error) {
    // Check if we should fallback
    if (shouldFallback(error)) {
      console.warn(
        "Primary Gemini API failed, falling back to secondary API key:",
        error,
      );

      // Tier 3: Try secondary system API key
      try {
        console.log(
          "Attempting Gemini generation with secondary system API key",
        );
        const response = await geminiLLM_2.invoke(messages);
        return { response, usedUserKey, allKeysFailed };
      } catch (fallbackError) {
        console.error("All Gemini API keys failed:", {
          primary: error,
          fallback: fallbackError,
        });
        allKeysFailed = true;
        // Re-throw the original error
        throw error;
      }
    }
    // If it's not a fallback-worthy error, throw it as-is
    throw error;
  }
}

/**
 * Streams from Gemini with automatic three-tier fallback:
 * 1. User's personal API key (if provided)
 * 2. System API key 1 (GEMINI_API_KEY)
 * 3. System API key 2 (GEMINI_API_KEY_UNSECURED)
 */
export async function streamGeminiWithFallback(
  messages: BaseMessage[],
  userApiKey?: string,
): Promise<StreamFallbackResult> {
  let usedUserKey = false;
  let allKeysFailed = false;

  // Tier 1: Try user's personal API key first (if provided)
  if (userApiKey) {
    try {
      console.log("Attempting Gemini stream with user's personal API key");
      const userClient = createGeminiClient(userApiKey);
      const stream = await userClient.stream(messages);
      usedUserKey = true;
      return { stream, usedUserKey, allKeysFailed };
    } catch (error) {
      console.warn(
        "User's Gemini API key stream failed, falling back to system keys:",
        error,
      );
      // Continue to system keys
    }
  }

  // Tier 2: Try primary system API key
  try {
    console.log("Attempting Gemini stream with primary system API key");
    const stream = await geminiLLM.stream(messages);
    return { stream, usedUserKey, allKeysFailed };
  } catch (error) {
    // Check if we should fallback
    if (shouldFallback(error)) {
      console.warn(
        "Primary Gemini stream failed, falling back to secondary API key:",
        error,
      );

      // Tier 3: Try secondary system API key
      try {
        console.log("Attempting Gemini stream with secondary system API key");
        const stream = await geminiLLM_2.stream(messages);
        return { stream, usedUserKey, allKeysFailed };
      } catch (fallbackError) {
        console.error("All Gemini API keys failed for stream:", {
          primary: error,
          fallback: fallbackError,
        });
        allKeysFailed = true;
        // Re-throw the original error
        throw error;
      }
    }
    // If it's not a fallback-worthy error, throw it as-is
    throw error;
  }
}

export function getTextFromAIChunk(chunk: AIMessageChunk): string {
  const { content } = chunk;

  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (
          typeof part === "object" &&
          part !== null &&
          "text" in part &&
          typeof part.text === "string"
        ) {
          return part.text;
        }
        return "";
      })
      .join("");
  }

  return "";
}

// Export the LLMs for direct use if needed (not recommended)
export { geminiLLM, geminiLLM_2 };
