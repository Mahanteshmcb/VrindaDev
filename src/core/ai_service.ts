import path from "node:path";
import { desc, eq } from "drizzle-orm";
import { readSettings } from "../main/settings";
import type { ChatStreamParams } from "../ipc/ipc_types";
import { db } from "../db";
import { messages as messagesTable, apps, chats } from "../db/schema";
import { readFileWithCache } from "../utils/codebase";

/**
 * CORE REPLACEMENT: AI Service (Ollama + OpenRouter + OpenAI Support)
 */
export async function streamChat(
  params: ChatStreamParams,
  onChunk: (content: string) => void
): Promise<void> {
  console.log("--- STARTING STREAM CHAT ---");
  
  const safeParams = params as any;
  const prompt = safeParams.prompt || "";
  const chatId = safeParams.chatId;
  const selectedComponents = safeParams.selectedComponents || [];

  // --- 1. Read Settings & Configure Provider ---
  const settings = await readSettings();
  const safeSettings = settings as any; 
  
  const selectedProvider = safeSettings.selectedModel?.provider || "openai";
  const selectedModelName = safeSettings.selectedModel?.name || "gpt-4o";
  
  let apiKey = "";
  let baseUrl = "";

  // --- PROVIDER CONFIGURATION LOGIC ---
  if (selectedProvider === "ollama") {
    // OLLAMA SPECIAL CASE:
    // 1. Use a dummy key to pass checks (Ollama doesn't check keys locally)
    apiKey = "ollama"; 
    // 2. Use the standard local Ollama endpoint
    // Note: We use 127.0.0.1 to avoid some Node.js 'localhost' resolution issues
    baseUrl = "http://127.0.0.1:11434/v1/chat/completions";
    console.log("Configured for OLLAMA (Local)");
  } 
  else if (selectedProvider === "openrouter") {
    apiKey = safeSettings.providerSettings?.openrouter?.apiKey?.value || safeSettings.apiKeys?.openrouter || "";
    baseUrl = "https://openrouter.ai/api/v1/chat/completions";
  } 
  else {
    // Default to OpenAI for everything else
    apiKey = safeSettings.providerSettings?.[selectedProvider]?.apiKey?.value || 
             safeSettings.apiKeys?.[selectedProvider] || 
             (selectedProvider === "openai" ? (safeSettings.providerSettings?.openai?.apiKey?.value || safeSettings.apiKeys?.openai) : "");
    baseUrl = "https://api.openai.com/v1/chat/completions";
  }

  // FINAL CHECK
  if (!apiKey) {
    console.error(`CRITICAL: No API Key found for provider '${selectedProvider}'`);
    onChunk(`Error: No API Key found for ${selectedProvider}. Please check your Settings.`);
    return;
  }

  // --- 2. Build File Context ---
  let fileContextString = "";
  if (chatId && selectedComponents.length > 0) {
    try {
      const result = await db
        .select({ appPath: apps.path })
        .from(chats)
        .innerJoin(apps, eq(chats.appId, apps.id))
        .where(eq(chats.id, chatId));

      const appRoot = result[0]?.appPath;

      if (appRoot) {
        fileContextString += "\n\n--- USER SELECTED CONTEXT ---\n";
        for (const component of selectedComponents) {
          if (component.relativePath) {
            const fullPath = path.join(appRoot, component.relativePath);
            const content = await readFileWithCache(fullPath);
            if (content) {
              fileContextString += `\nFile: ${component.relativePath}\n\`\`\`\n${content}\n\`\`\`\n`;
            }
          }
        }
      }
    } catch (err) {
      console.error("Failed to read file context:", err);
    }
  }

  // --- 3. Fetch History ---
  let history: any[] = [];
  if (chatId) {
    try {
      const dbMessages = await db
        .select({
          role: messagesTable.role,
          content: messagesTable.content,
        })
        .from(messagesTable)
        .where(eq(messagesTable.chatId, chatId))
        .orderBy(desc(messagesTable.createdAt))
        .limit(20);

      history = dbMessages.reverse().map(m => ({
        role: m.role,
        content: m.content
      }));
    } catch (err) {
      console.error("Failed to fetch chat history:", err);
    }
  }

  // --- 4. Construct Prompt ---
  const baseSystemPrompt = "You are a helpful coding assistant.";
  const fullSystemPrompt = fileContextString 
    ? `${baseSystemPrompt}\n\nThe user has referenced the following files:${fileContextString}`
    : baseSystemPrompt;

  const apiMessages = [
    { role: "system", content: fullSystemPrompt },
    ...history, 
    { role: "user", content: prompt }
  ];

  // --- 5. Call API ---
  try {
    console.log(`Connecting to ${baseUrl}...`);
    const response = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "HTTP-Referer": "https://github.com/Mahanteshmcb/VrindaDev",
        "X-Title": "VrindaDev"
      },
      body: JSON.stringify({
        model: selectedModelName, // e.g. "llama3", "mistral", etc.
        messages: apiMessages,
        temperature: 0.7,
        stream: true, 
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("API Error:", errText);
      onChunk(`API Error (${response.status}): ${errText}`);
      return;
    }

    if (!response.body) return;

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; 

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === "data: [DONE]") continue;
        if (trimmed.startsWith("data: ")) {
          try {
            const json = JSON.parse(trimmed.slice(6));
            // Ollama sometimes returns content in different fields, checking standard OpenAI format first
            const content = json.choices?.[0]?.delta?.content || json.message?.content;
            if (content) onChunk(content);
          } catch (e) { /* ignore */ }
        }
      }
    }
  } catch (error) {
    console.error("Network Error:", error);
    // Specific hint for Ollama connection errors
    if (String(error).includes("ECONNREFUSED")) {
      onChunk(`\nError: Could not connect to Ollama at ${baseUrl}. Is Ollama running?\n`);
    } else {
      onChunk(`\n[System Error: ${error instanceof Error ? error.message : String(error)}]\n`);
    }
  }
}