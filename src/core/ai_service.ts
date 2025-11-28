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

  // 1. Load Settings
  const settings = await readSettings();
  const safeSettings = settings as any; 
  const chatMode = safeSettings.selectedChatMode || "ask"; 
  const isAgentMode = chatMode === "agent" || chatMode === "build";
  const autoApprove = safeSettings.autoApproveChanges ?? false; 

  console.log(`--- STARTING CHAT (Mode: ${chatMode.toUpperCase()}, Auto-Approve: ${autoApprove}) ---`);

  // 2. Configure Provider
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

  // 3. Build Context & Connect MCP
  let projectContext = "";
  let appRoot = "";

  if (chatId) {
    try {
      const result = await db.select({ appPath: apps.path, appName: apps.name }).from(chats)
        .innerJoin(apps, eq(chats.appId, apps.id)).where(eq(chats.id, chatId));
      
      if (result[0]?.appPath) {
        appRoot = getDyadAppPath(result[0].appPath);
        
        if (isAgentMode) { try { await mcpManager.connect(appRoot); } catch(e) { console.error(e); } }

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

  // 4. Load Tools
  let mcpTools: any[] = [];
  let toolsPayload: any = undefined;
  if (isAgentMode && appRoot) {
      try {
          const allTools = await mcpManager.listTools();
          
          if (autoApprove) { mcpTools = allTools; } 
          else { mcpTools = allTools.filter(t => !['write_file', 'edit_file', 'execute_command', 'create_directory'].includes(t.name)); }

          if (mcpTools.length > 0) {
              toolsPayload = providerType === "google" ? formatToolsGoogle(mcpTools) : formatToolsOpenAI(mcpTools);
          }
          console.log(`🔧 [Agent] Loaded ${mcpTools.length} tools.`);
      } catch (e) {}
  }

  // 5. System Prompt
  let systemPrompt = "";
  if (isAgentMode) {
      if (autoApprove) {
          // --- AUTONOMOUS BUILDER (Simplified) ---
          systemPrompt = `You are an expert software engineer.
          
          YOUR GOAL: Build the requested app immediately.
          
          RULES:
          1. Use 'write_file' to create files.
          2. Use 'execute_command' to install packages.
          3. Do not ask questions. Just write the code.
          4. Call multiple tools in one turn to be fast.
          `;
      } else {
          // --- MANUAL MODE ---
          systemPrompt = `You are a coding consultant.
          The user must manually approve changes.
          Output code in Markdown blocks (<dyad-write>) for review.
          Do NOT use write tools.`;
      }
  } else {
      systemPrompt = "You are a helpful coding assistant.";
  }

  let messages: any[] = [
    { role: "system", content: systemPrompt + projectContext },
    { role: "user", content: prompt }
  ];

  // 6. Execution Loop
  let turnCount = 0;
  const MAX_TURNS = (isAgentMode && autoApprove) ? 15 : 1; // Increased turns for complex apps

  while (turnCount < MAX_TURNS) {
      turnCount++;
      if (isAgentMode && autoApprove) console.log(`🔄 [Loop] Turn ${turnCount}`);

      try {
        let responseData: any = null;
        let attempts = 0;

        while (attempts < 3 && !responseData) {
            try {
                attempts++;
                // Standard API Call Logic
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
                            responseData = { content: null, tool_calls: [{ id: "call_" + Date.now(), function: { name: funcCall.functionCall.name, arguments: JSON.stringify(funcCall.functionCall.args) } }] };
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
                const isWrite = responseData.tool_calls.some((t: any) => ['write_file', 'edit_file', 'execute_command', 'create_directory'].includes(t.function.name));
                if (isWrite) {
                    onChunk(`\n🛑 **Manual Approval Required**\nAgent suggested actions, but Auto-Approve is OFF. Please review the output above.\n`);
                    break; 
                }
            }

            messages.push(responseData); 
            let hasError = false;

            for (const call of responseData.tool_calls) {
                const fnName = call.function.name;
                let fnArgs: any = {};
                try { fnArgs = typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments) : call.function.arguments; } catch (e) {}
                
                // Clean Path
                if (fnArgs.path) fnArgs.path = fnArgs.path.replace(/^(C:\\.*\\dyad-apps\\[^\\]+\\)/i, '').replace(/^path[\\\/]to[\\\/]project[\\\/]/i, '');
                
                let fileTarget = "";
                if (fnArgs.path) fileTarget = ` (${fnArgs.path})`;
                
                // VISUAL LOG
                const emoji = fnName.includes("write") ? "💾" : fnName.includes("read") ? "📖" : "🛠️";
                onChunk(`\n${emoji} **Agent:** ${fnName}${fileTarget}\n`);
                
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
                    hasError = true;
                }

                messages.push({ role: "tool", tool_call_id: call.id, name: fnName, content: resultStr });
            }
            
            if (hasError && !(safeSettings.enableAutoFixProblems ?? true)) { 
                 onChunk(`\n⚠️ **Error Detected**\nAuto-Fix is OFF. Stopping.\n`);
                 break;
            }

        } else { break; }

      } catch (error: any) {
          console.error("Loop Error:", error);
          onChunk(`\n[Error: ${error.message}]\n`);
          break;
      }
  }
}