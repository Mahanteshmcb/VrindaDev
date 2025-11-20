import { readSettings } from "../main/settings";
import type { ChatStreamParams } from "../ipc/ipc_types";

/**
 * CORE REPLACEMENT: ai_service.ts
 * Replaces the FSL streamChat function.
 */
export async function streamChat(
  params: ChatStreamParams,
  onChunk: (content: string) => void
): Promise<void> {
  // 1. Extract parameters
  // We default prompt to empty string if missing to prevent crash, though it should be there
  const prompt = params.prompt || "";
  
  // 2. Read Settings
  const settings = await readSettings();
  const safeSettings = settings as any; // Cast to any to avoid strict type errors for now

  // 3. Determine Provider (OpenAI vs OpenRouter)
  // We look at the internal structure you verified earlier
  const selectedProvider = safeSettings.selectedModel?.provider || "openai";
  const selectedModelName = safeSettings.selectedModel?.name || "gpt-4o";
  
  // 4. Extract API Key safely
  const providerConfig = safeSettings.providerSettings?.[selectedProvider];
  const apiKey = providerConfig?.apiKey?.value;

  if (!apiKey) {
    onChunk(`Error: No API Key found for provider '${selectedProvider}'. Please check your Settings.`);
    return;
  }

  // 5. Set Endpoint
  const baseUrl = selectedProvider === "openrouter" 
    ? "https://openrouter.ai/api/v1/chat/completions" 
    : "https://api.openai.com/v1/chat/completions";

  // 6. Build Messages
  // Note: We are using a simple 2-message history for now (System + User)
  // to ensure it works before adding complex history fetching.
  const apiMessages = [
    { role: "system", content: "You are a helpful coding assistant." },
    { role: "user", content: prompt }
  ];

  // 7. Call API
  try {
    const response = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "HTTP-Referer": "https://github.com/Mahanteshmcb/VrindaDev",
        "X-Title": "VrindaDev"
      },
      body: JSON.stringify({
        model: selectedModelName,
        messages: apiMessages,
        temperature: 0.7,
        stream: true, 
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      onChunk(`API Error ${response.status}: ${errText}`);
      return;
    }

    if (!response.body) {
      onChunk("Error: No response body.");
      return;
    }

    // 8. Stream Reading
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
            const content = json.choices?.[0]?.delta?.content;
            if (content) onChunk(content);
          } catch (e) { /* ignore */ }
        }
      }
    }
  } catch (error) {
    console.error("Core AI Error:", error);
    onChunk(`\n[Error: ${error instanceof Error ? error.message : String(error)}]\n`);
  }
}