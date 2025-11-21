import path from "node:path";
import fs from "node:fs";
import { desc, eq } from "drizzle-orm";
import { readSettings } from "../main/settings";
import type { ChatStreamParams } from "../ipc/ipc_types";
import { db } from "../db";
import { messages as messagesTable, apps, chats } from "../db/schema";
import { getDyadAppPath } from "../paths/paths";
import { readFileWithCache } from "../utils/codebase";

// --- HELPERS ---

function generateFileTree(dir: string, depth = 0, maxDepth = 3): string {
  if (depth > maxDepth) return "";
  let tree = "";
  try {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      if (["node_modules", ".git", "dist", ".next", ".vscode"].includes(file)) continue;
      const fullPath = path.join(dir, file);
      if (fs.statSync(fullPath).isDirectory()) {
        tree += "  ".repeat(depth) + `📁 ${file}/\n` + generateFileTree(fullPath, depth + 1, maxDepth);
      } else {
        tree += "  ".repeat(depth) + `📄 ${file}\n`;
      }
    }
  } catch (e) { return ""; }
  return tree;
}

function autoDetectFiles(prompt: string, appRoot: string): string[] {
  const foundFiles: string[] = [];
  const regex = /[\w\-\/]+\.(ts|tsx|js|jsx|json|css|html|md|py|go|rs)/g;
  const matches = prompt.match(regex);
  if (matches) {
    for (const match of matches) {
      if (fs.existsSync(path.join(appRoot, match))) foundFiles.push(match);
    }
  }
  return foundFiles;
}

// --- GOOGLE GEMINI ADAPTER ---

async function streamGoogle(
  apiKey: string,
  model: string,
  messages: any[],
  onChunk: (c: string) => void
) {
  // Convert OpenAI format messages to Google format
  // 1. Extract System Prompt
  let systemInstruction = undefined;
  const contentHistory = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      systemInstruction = { parts: [{ text: msg.content }] };
    } else {
      // Google uses 'model' instead of 'assistant'
      const role = msg.role === "assistant" ? "model" : "user";
      contentHistory.push({ role, parts: [{ text: msg.content }] });
    }
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?key=${apiKey}`;
  
  console.log(`Connecting to Google Gemini (${model})...`);
  
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: contentHistory,
      systemInstruction: systemInstruction,
      generationConfig: { temperature: 0.7 }
    })
  });

  if (!response.ok) {
    throw new Error(`Google API Error: ${await response.text()}`);
  }
  if (!response.body) return;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    
    // Google sends a JSON array like [{...}, {...}] but sometimes broken across chunks
    // We need to split by the natural object delimiters or parse safely
    // Simple hack for Google's specific stream format which usually sends complete JSON objects starting with "data:" or just raw JSON array elements
    
    // Clean up buffer to find JSON objects
    // Note: Google stream format is tricky (comma separated array elements). 
    // We will try a regex to pull out "text" fields if simple parsing fails.
    const textMatches = buffer.match(/\"text\":\s*\"(.*?)\"/g);
    if (textMatches) {
        for (const match of textMatches) {
            // Extract content inside quotes and unescape
            const raw = match.replace('"text": "', "").slice(0, -1);
            try {
                const txt = JSON.parse(`"${raw}"`); // Let JSON.parse handle unescaping
                onChunk(txt);
            } catch (e) { /* ignore partials */ }
        }
        buffer = ""; // Clear buffer after processing
    }
  }
}

// --- MAIN SERVICE ---

export async function streamChat(
  params: ChatStreamParams,
  onChunk: (content: string) => void
): Promise<void> {
  console.log("--- STARTING STREAM CHAT ---");
  
  const safeParams = params as any;
  const prompt = safeParams.prompt || "";
  const chatId = safeParams.chatId;
  const selectedComponents = safeParams.selectedComponents || [];

  const settings = await readSettings();
  const safeSettings = settings as any; 
  
  // 1. DETERMINE PROVIDER & KEY
  // We check 'provider' string. It usually is "openai", "google", "anthropic", "ollama", "openrouter"
  const selectedProvider = safeSettings.selectedModel?.provider || "openai";
  // For Google, model names usually look like "gemini-1.5-flash"
  const selectedModelName = safeSettings.selectedModel?.name || "gpt-4o";

  let apiKey = "";
  
  // Robust Key Finding
  if (selectedProvider === "ollama") {
    apiKey = "ollama"; 
  } else {
    // Try new location -> old location -> provider specific fallback
    apiKey = safeSettings.providerSettings?.[selectedProvider]?.apiKey?.value || 
             safeSettings.apiKeys?.[selectedProvider] || "";
             
    if (!apiKey && selectedProvider === "google") {
       apiKey = safeSettings.providerSettings?.google?.apiKey?.value || safeSettings.apiKeys?.google;
    }
  }

  if (!apiKey) {
    onChunk(`Error: No API Key found for ${selectedProvider}.`);
    return;
  }

  // 2. BUILD CONTEXT
  let fileContextString = "";
  let projectMapString = "";

  if (chatId) {
    try {
      const result = await db.select({ appPath: apps.path, appName: apps.name })
        .from(chats).innerJoin(apps, eq(chats.appId, apps.id)).where(eq(chats.id, chatId));
      
      if (result[0]?.appPath) {
        const appRoot = getDyadAppPath(result[0].appPath);
        projectMapString = `\n\n# Project Structure:\n${generateFileTree(appRoot)}\n`;
        
        // File Reading
        const filesToRead = new Set<string>();
        selectedComponents.forEach((c: any) => c.relativePath && filesToRead.add(c.relativePath));
        autoDetectFiles(prompt, appRoot).forEach(f => filesToRead.add(f));

        if (filesToRead.size > 0) {
          fileContextString += "\n\n# File Contents:\n";
          for (const relPath of filesToRead) {
            try {
                const content = fs.readFileSync(path.join(appRoot, relPath), "utf-8");
                if (content.length < 60000) fileContextString += `\nFile: ${relPath}\n\`\`\`\n${content}\n\`\`\`\n`;
            } catch (e) { console.error(`Read error: ${relPath}`); }
          }
        }
      }
    } catch (err) { console.error(err); }
  }

  const baseSystemPrompt = "You are a coding assistant.";
  const finalSystemPrompt = `${baseSystemPrompt}${projectMapString}${fileContextString}`;

  const apiMessages = [
    { role: "system", content: finalSystemPrompt },
    // Add history logic here if desired (omitted for brevity, same as before)
    { role: "user", content: prompt }
  ];

  // 3. ROUTE TO CORRECT ADAPTER
  try {
    // === GOOGLE / GEMINI CASE ===
    if (selectedProvider === "google" || selectedModelName.startsWith("gemini")) {
        await streamGoogle(apiKey, selectedModelName, apiMessages, onChunk);
        return;
    }

    // === OPENAI / OPENROUTER / OLLAMA CASE ===
    let baseUrl = "https://api.openai.com/v1/chat/completions";
    
    if (selectedProvider === "ollama") {
        baseUrl = "http://127.0.0.1:11434/v1/chat/completions";
    } else if (selectedProvider === "openrouter") {
        baseUrl = "https://openrouter.ai/api/v1/chat/completions";
    }

    console.log(`Connecting to ${baseUrl} (${selectedModelName})...`);

    const response = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: selectedModelName,
        messages: apiMessages,
        temperature: 0.7,
        stream: true, 
      }),
    });

    if (!response.ok) throw new Error(await response.text());
    if (!response.body) return;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("data: ") && trimmed !== "data: [DONE]") {
            try {
                const json = JSON.parse(trimmed.slice(6));
                const content = json.choices?.[0]?.delta?.content || json.message?.content;
                if (content) onChunk(content);
            } catch (e) {}
        }
      }
    }

  } catch (error: any) {
    console.error("AI Service Error:", error);
    onChunk(`\n[Error: ${error.message || String(error)}]\n`);
  }
}