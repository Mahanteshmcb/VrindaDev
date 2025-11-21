import path from "node:path";
import fs from "node:fs";
import { desc, eq } from "drizzle-orm";
import { readSettings } from "../main/settings";
import type { ChatStreamParams } from "../ipc/ipc_types";
import { db } from "../db";
import { messages as messagesTable, apps, chats } from "../db/schema";
import { getDyadAppPath } from "../paths/paths";
import { mcpManager } from "./mcp_manager";

// --- HELPERS ---

function generateFileTree(dir: string, depth = 0, maxDepth = 3): string {
  if (depth > maxDepth) return "";
  let tree = "";
  try {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      if (["node_modules", ".git", "dist", "build", ".next", ".vscode"].includes(file)) continue;
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

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// --- TOOL FORMATTERS ---

function formatToolsOpenAI(tools: any[]) {
    return tools.map(t => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.inputSchema }
    }));
}

function formatToolsGoogle(tools: any[]) {
    return [{
        function_declarations: tools.map(t => {
            const p = JSON.parse(JSON.stringify(t.inputSchema));
            if (p.$schema) delete p.$schema;
            return { name: t.name, description: t.description, parameters: p };
        })
    }];
}

// --- MAIN SERVICE ---

export async function streamChat(params: ChatStreamParams, onChunk: (content: string) => void): Promise<void> {
  const safeParams = params as any;
  const prompt = safeParams.prompt || "";
  const chatId = safeParams.chatId;
  const selectedComponents = safeParams.selectedComponents || [];

  const settings = await readSettings();
  const safeSettings = settings as any; 
  const chatMode = safeSettings.selectedChatMode || "ask"; 
  const isAgentMode = chatMode === "agent" || chatMode === "build";
  const autoApprove = safeSettings.autoApproveChanges ?? false; 

  console.log(`--- STARTING CHAT (Mode: ${chatMode}, Auto-Approve: ${autoApprove}) ---`);

  const selectedProvider = safeSettings.selectedModel?.provider || "openai";
  const selectedModelName = safeSettings.selectedModel?.name || "gpt-4o";
  let apiKey = "";
  let providerType = "openai"; 

  if (selectedProvider === "ollama") apiKey = "ollama"; 
  else {
    apiKey = safeSettings.providerSettings?.[selectedProvider]?.apiKey?.value || safeSettings.apiKeys?.[selectedProvider] || "";
    if (!apiKey && selectedProvider === "google") apiKey = safeSettings.providerSettings?.google?.apiKey?.value || safeSettings.apiKeys?.google;
  }

  if (!apiKey) { onChunk(`Error: No API Key found.`); return; }
  if (selectedProvider === "google" || selectedModelName.startsWith("gemini")) providerType = "google";

  let projectContext = "";
  let appRoot = "";

  if (chatId) {
    try {
      const result = await db.select({ appPath: apps.path, appName: apps.name }).from(chats)
        .innerJoin(apps, eq(chats.appId, apps.id)).where(eq(chats.id, chatId));
      
      if (result[0]?.appPath) {
        appRoot = getDyadAppPath(result[0].appPath);
        
        if (isAgentMode) {
            try { await mcpManager.connect(appRoot); } catch(e) { console.error("MCP Connect Error", e); }
        }

        projectContext += `\n# Project Structure (${result[0].appName}):\n${generateFileTree(appRoot)}\n`;
        
        for (const comp of selectedComponents) {
            if (comp.relativePath) {
                try {
                    const content = fs.readFileSync(path.join(appRoot, comp.relativePath), "utf-8");
                    projectContext += `\nFile: ${comp.relativePath}\n\`\`\`\n${content}\n\`\`\`\n`;
                } catch(e) {}
            }
        }
      }
    } catch (err) {}
  }

  let mcpTools: any[] = [];
  let toolsPayload: any = undefined;
  if (isAgentMode && appRoot) {
      try {
          const allTools = await mcpManager.listTools();
          
          if (autoApprove) {
              mcpTools = allTools;
          } else {
              // Manual Mode: READ ONLY tools
              mcpTools = allTools.filter(t => !['write_file', 'edit_file', 'execute_command'].includes(t.name));
          }
          
          console.log(`🔧 [Agent] Loaded ${mcpTools.length} tools.`);
          toolsPayload = providerType === "google" ? formatToolsGoogle(mcpTools) : formatToolsOpenAI(mcpTools);
      } catch (e) {}
  }

  let systemPrompt = "";
  if (isAgentMode) {
      if (autoApprove) {
          systemPrompt = `You are an expert autonomous software engineer.
          DIRECTIVES:
          1. IMPLEMENT the user's request IMMEDIATELY using tools.
          2. Call 'write_file' multiple times in one turn to create all needed files.
          3. Overwrite existing files if needed.
          4. Do not ask for permission. Just build it.`;
      } else {
          systemPrompt = `You are a coding consultant. MANUAL APPROVAL is ON.
          INSTRUCTIONS:
          1. You CANNOT modify files directly (write tools are disabled).
          2. Output the solution in Markdown code blocks (<dyad-write>) so the user can review.`;
      }
  } else {
      systemPrompt = "You are a helpful coding assistant. Answer questions based on the code context.";
  }

  let messages: any[] = [
    { role: "system", content: systemPrompt + projectContext },
    { role: "user", content: prompt }
  ];

  let turnCount = 0;
  const MAX_TURNS = (isAgentMode && autoApprove) ? 10 : 1;

  while (turnCount < MAX_TURNS) {
      turnCount++;
      if (isAgentMode && autoApprove) console.log(`🔄 [Loop] Turn ${turnCount}`);

      try {
        let responseData: any = null;
        let attempts = 0;

        while (attempts < 3 && !responseData) {
            try {
                attempts++;
                if (providerType === "google") {
                    const contents = messages.filter(m => m.role !== "system").map(m => {
                        let role = "user";
                        let text = "";
                        if (m.role === "assistant") { role = "model"; text = m.content || ""; }
                        else if (m.role === "tool") { role = "user"; text = `[Tool Result for ${m.name}]:\n${m.content}`; }
                        else { role = "user"; text = m.content || ""; }
                        return { role, parts: [{ text }] };
                    });
                    
                    const url = `https://generativelanguage.googleapis.com/v1beta/models/${selectedModelName}:generateContent?key=${apiKey}`;
                    const res = await fetch(url, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ contents, tools: toolsPayload, systemInstruction: { parts: [{ text: systemPrompt }] } })
                    });

                    if (res.status === 429) throw new Error("429 Too Many Requests");
                    if (!res.ok) throw new Error(`Google API: ${await res.text()}`);
                    
                    const json = await res.json();
                    const candidate = json.candidates?.[0]?.content;
                    if (candidate) {
                        const parts = candidate.parts || [];
                        const funcCall = parts.find((p: any) => p.functionCall);
                        if (funcCall) {
                            responseData = {
                                content: null,
                                tool_calls: [{
                                    id: "call_" + Date.now(),
                                    function: { name: funcCall.functionCall.name, arguments: JSON.stringify(funcCall.functionCall.args) }
                                }]
                            };
                        } else { responseData = { content: parts.map((p: any) => p.text).join("") }; }
                    }
                } else {
                    // OpenAI / Ollama
                    let baseUrl = "https://api.openai.com/v1/chat/completions";
                    if (selectedProvider === "ollama") baseUrl = "http://127.0.0.1:11434/v1/chat/completions";
                    if (selectedProvider === "openrouter") baseUrl = "https://openrouter.ai/api/v1/chat/completions";

                    const reqBody: any = { model: selectedModelName, messages: messages, stream: false };
                    if (toolsPayload) { reqBody.tools = toolsPayload; reqBody.tool_choice = "auto"; }

                    const res = await fetch(baseUrl, {
                        method: "POST",
                        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
                        body: JSON.stringify(reqBody)
                    });
                    
                    if (res.status === 429) throw new Error("429 Too Many Requests");
                    if (!res.ok) throw new Error(`API Error: ${await res.text()}`);
                    const json = await res.json();
                    responseData = json.choices?.[0]?.message;
                }
            } catch (err: any) {
                if (String(err).includes("429") || String(err).includes("Too Many Requests")) {
                    // FIXED: Wait only 5 seconds
                    const waitTime = 5000; 
                    onChunk(`\n⏳ Rate limit hit. Waiting 5s...\n`);
                    await sleep(waitTime);
                } else { throw err; }
            }
        }

        if (!responseData) break;

        if (responseData.content) {
            onChunk(responseData.content);
            messages.push({ role: "assistant", content: responseData.content });
        }

        if (responseData.tool_calls && responseData.tool_calls.length > 0) {
            if (!autoApprove) {
                onChunk(`\n🛑 **Approval Required**\nAuto-Approve is OFF. Stopping execution.\n`);
                break; 
            }

            messages.push(responseData); 

            for (const call of responseData.tool_calls) {
                const fnName = call.function.name;
                let fnArgs: any = {};
                try { fnArgs = typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments) : call.function.arguments; } catch (e) {}
                
                let fileTarget = "";
                if (fnArgs.path) fileTarget = ` (${fnArgs.path})`;
                onChunk(`\n🛠️ Executing: ${fnName}${fileTarget}...\n`);
                
                // Call MCP
                let resultStr = "";
                try {
                    const result = await mcpManager.callTool(fnName, fnArgs) as any;
                    if (result && result.content && Array.isArray(result.content)) {
                         resultStr = result.content.map((c: any) => c.text).join("\n");
                    } else { resultStr = "Success"; }
                    onChunk(`✅ Done.\n`);
                } catch (err) {
                    resultStr = `Error: ${err}`;
                    onChunk(`❌ Failed: ${err}\n`);
                }

                messages.push({ role: "tool", tool_call_id: call.id, name: fnName, content: resultStr });
            }
        } else { break; }

      } catch (error: any) {
          console.error("Loop Error:", error);
          onChunk(`\n[Error: ${error.message}]\n`);
          break;
      }
  }
}