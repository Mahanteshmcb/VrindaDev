import path from "node:path";
import fs from "node:fs";
import { desc, eq, asc } from "drizzle-orm";
import { readSettings } from "../main/settings";
import type { ChatStreamParams } from "../ipc/ipc_types";
import { db } from "../db";
import { messages as messagesTable, apps, chats } from "../db/schema";
import { getDyadAppPath } from "../paths/paths";
import { mcpManager } from "./mcp_manager";

// --- HELPERS ---

function generateFileTree(dir: string, depth = 0, maxDepth = 4): string {
  if (depth > maxDepth) return "";
  let tree = "";
  try {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      if (["node_modules", ".git", "dist", "build", ".next", ".vscode", ".DS_Store", "pnpm-lock.yaml", "yarn.lock", "package-lock.json"].includes(file)) continue;
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

  // 2. Build Provider Queue (Auto-Switching Logic)
  let providerQueue: Array<{ id: string, model: string, key: string }> = [];
  
  const getKey = (p: string) => safeSettings.providerSettings?.[p]?.apiKey?.value || safeSettings.apiKeys?.[p];
  const requestedProvider = safeSettings.selectedModel?.provider || "auto";

  if (requestedProvider !== "auto") {
      // Manual Mode: Use selected provider only
      let key = getKey(requestedProvider);
      if (requestedProvider === "ollama") key = "ollama";
      
      providerQueue.push({ 
          id: requestedProvider, 
          model: safeSettings.selectedModel?.name || "gpt-4o", 
          key: key || "" 
      });
  } else {
      // Auto Mode: Priority Fallback Chain
      if (getKey("openrouter")) providerQueue.push({ id: "openrouter", model: "google/gemini-2.0-flash-001", key: getKey("openrouter") });
      if (getKey("google")) providerQueue.push({ id: "google", model: "gemini-1.5-pro-latest", key: getKey("google") });
      if (getKey("openai")) providerQueue.push({ id: "openai", model: "gpt-4o", key: getKey("openai") });
      if (getKey("anthropic")) providerQueue.push({ id: "anthropic", model: "claude-3-5-sonnet-latest", key: getKey("anthropic") });
      if (safeSettings.isOllamaEnabled || getKey("ollama")) providerQueue.push({ id: "ollama", model: "llama3", key: "ollama" });
  }

  // Filter invalid keys
  providerQueue = providerQueue.filter(p => p.key && p.key.trim() !== "");

  if (providerQueue.length === 0) {
      onChunk("❌ Error: No valid API keys found. Please check Settings.");
      return;
  }

  console.log(`🤖 [Router] Provider Queue: ${providerQueue.map(p => p.id).join(" -> ")}`);

  // 3. Build Context & Detect Package Manager & LOAD HISTORY
  let projectContext = "";
  let appRoot = "";
  let packageManager = "npm"; // Default
  let historyMessages: any[] = [];

  if (chatId) {
    try {
      const result = await db.select({ appPath: apps.path, appName: apps.name }).from(chats)
        .innerJoin(apps, eq(chats.appId, apps.id)).where(eq(chats.id, chatId));
      
      if (result[0]?.appPath) {
        appRoot = getDyadAppPath(result[0].appPath);
        
        // Detect Package Manager
        if (fs.existsSync(path.join(appRoot, "pnpm-lock.yaml"))) packageManager = "pnpm";
        else if (fs.existsSync(path.join(appRoot, "yarn.lock"))) packageManager = "yarn";
        
        console.log(`📦 [Project] Detected Package Manager: ${packageManager}`);

        try { await mcpManager.connect(appRoot); } catch(e) { console.error("MCP Connect Error:", e); }

        projectContext += `\n# Project Context (${result[0].appName})\nRoot: ${appRoot}\nPackage Manager: ${packageManager}\n\n## File Structure:\n${generateFileTree(appRoot)}\n`;
        
        for (const comp of selectedComponents) {
            if (comp.relativePath) {
                try {
                    const content = fs.readFileSync(path.join(appRoot, comp.relativePath), "utf-8");
                    projectContext += `\nFile: ${comp.relativePath}\n\`\`\`\n${content}\n\`\`\`\n`;
                } catch(e) {}
            }
        }

        // --- LOAD HISTORY (Critical for Manual Mode Context) ---
        try {
            const dbMsgs = await db.select()
                .from(messagesTable)
                .where(eq(messagesTable.chatId, chatId))
                .orderBy(asc(messagesTable.id)); 
            
            // Map DB messages to LLM format. We take the last 20 for context window efficiency.
            historyMessages = dbMsgs.slice(-20).map(msg => ({
                role: msg.role === 'user' ? 'user' : 'assistant',
                content: msg.content || "" 
            }));
        } catch (dbErr) {
            console.error("Failed to load chat history:", dbErr);
        }
      }
    } catch (err) { console.error("Context Load Error:", err); }
  }

  // 4. Load Tools
  let mcpTools: any[] = [];
  
  if (isAgentMode && appRoot) {
      try {
          mcpTools = await mcpManager.listTools();
          console.log(`🔧 [Agent] Loaded ${mcpTools.length} tools.`);
      } catch (e) { console.error("Tool Load Error:", e); }
  }

  // 5. System Prompt
  let systemPrompt = "";
  if (isAgentMode) {
      if (autoApprove) {
          // --- AUTONOMOUS BUILDER ---
          systemPrompt = `You are a Senior Software Engineer acting as an autonomous agent.
          
          YOUR GOAL: Complete the user's request fully and efficiently.
          
          CAPABILITIES:
          - You can create, edit, and read files.
          - You can execute shell commands (npm, git, etc.).
          - You can list directories and SEARCH for files.
          
          CRITICAL RULES FOR FILES:
          1. **Never Guess Paths**: If a file read fails with "File not found", STOP guessing.
          2. **Use Search**: If you are unsure of a file path, use 'search_files'.
          3. **Read Before Edit**: Always read a file before editing to ensure you have the latest content.
          
          CRITICAL RULES FOR COMMANDS:
          1. **Package Manager**: THIS PROJECT USES **${packageManager.toUpperCase()}**. ALWAYS use '${packageManager} install' or '${packageManager} add'.
          2. **Non-Interactive**: Always use flags like '-y' or '--yes'.
          
          GENERAL RULES:
          - Be robust. If a tool fails, analyze the error and try a different strategy.
          - Do NOT ask for permission. You have full authority. Just do it.
          `;
      } else {
          // --- MANUAL / ADVISORY MODE ---
          systemPrompt = `You are a Senior Software Engineer acting as an agent.
          
          **OPERATIONAL MODE: MANUAL APPROVAL**
          
          CRITICAL RULES:
          1. **DO NOT** generate XML tags (like <dyad-write>, <dyad-execute>) yourself. The system handles UI rendering.
          2. **ALWAYS USE TOOLS**: To modify files or run commands, you MUST call the corresponding tool ('write_file', 'execute_command').
          3. **Wait for Approval**: After calling a tool, execution will pause. The user will review your proposal.
          4. **Package Manager**: Use **${packageManager.toUpperCase()}**.
          5. **History**: Check history to see what was previously proposed/rejected.
          `;
      }
  } else {
      systemPrompt = "You are a helpful coding assistant. Answer questions about the code provided.";
  }

  let messages: any[] = [
    { role: "system", content: systemPrompt + projectContext },
    ...historyMessages,
    { role: "user", content: prompt }
  ];

  // 6. Execution Loop
  let turnCount = 0;
  const MAX_TURNS = (isAgentMode && autoApprove) ? 50 : 1; 
  let currentProviderIndex = 0;

  while (turnCount < MAX_TURNS) {
      turnCount++;
      if (isAgentMode && autoApprove) console.log(`🔄 [Loop] Turn ${turnCount}/${MAX_TURNS}`);

      try {
        let responseData: any = null;
        let attempts = 0;

        // Smart Retry & Switch Loop
        while (!responseData && attempts < 10) {
            attempts++;
            const currentConfig = providerQueue[currentProviderIndex];
            
            const providerType = (currentConfig.id === "google") ? "google" : "openai";
            const apiKey = currentConfig.key;
            const modelName = currentConfig.model;

            // Format tools for current provider
            const toolsPayload = (mcpTools.length > 0) 
                ? (providerType === "google" ? formatToolsGoogle(mcpTools) : formatToolsOpenAI(mcpTools)) 
                : undefined;

            try {
                if (providerType === "google") {
                    // --- GOOGLE NATIVE API ---
                    const contents = messages.filter(m => m.role !== "system").map(m => {
                        let role = "user";
                        let text = "";
                        if (m.role === "assistant") { role = "model"; text = m.content || ""; }
                        else if (m.role === "tool") { role = "user"; text = `[Tool Result for ${m.name}]:\n${m.content}`; }
                        else { role = "user"; text = m.content || ""; }
                        return { role, parts: [{ text }] };
                    });
                    
                    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
                    const res = await fetch(url, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ contents, tools: toolsPayload, systemInstruction: { parts: [{ text: systemPrompt }] } })
                    });

                    if (res.status === 429 || res.status === 503) throw new Error("RateLimit");
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
                    // --- OPENAI / OPENROUTER / OLLAMA ---
                    let baseUrl = "https://api.openai.com/v1/chat/completions";
                    if (currentConfig.id === "ollama") baseUrl = "http://127.0.0.1:11434/v1/chat/completions";
                    if (currentConfig.id === "openrouter") baseUrl = "https://openrouter.ai/api/v1/chat/completions";

                    const reqBody: any = { model: modelName, messages: messages, stream: false };
                    if (toolsPayload) { reqBody.tools = toolsPayload; reqBody.tool_choice = "auto"; }

                    const headers: any = { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` };
                    if (currentConfig.id === "openrouter") {
                        headers["HTTP-Referer"] = "https://dyad.sh"; 
                        headers["X-Title"] = "Dyad";
                    }

                    const res = await fetch(baseUrl, { method: "POST", headers, body: JSON.stringify(reqBody) });
                    
                    if (res.status === 429 || res.status === 503) throw new Error("RateLimit");
                    if (!res.ok) throw new Error(`API Error: ${await res.text()}`);
                    const json = await res.json();
                    responseData = json.choices?.[0]?.message;
                }
            } catch (err: any) {
                const isRateLimit = String(err).includes("RateLimit") || String(err).includes("429") || String(err).includes("503") || String(err).includes("Overloaded");
                
                if (isRateLimit) {
                    onChunk(`\n⚠️ Provider **${currentConfig.id}** is overloaded.`);
                    
                    if (providerQueue.length > 1) {
                        // Switch to next provider
                        currentProviderIndex = (currentProviderIndex + 1) % providerQueue.length;
                        onChunk(` Switching to **${providerQueue[currentProviderIndex].id}**...\n`);
                        // Loop continues immediately with new provider
                    } else {
                        onChunk(`\n⏳ Waiting 5s to retry...\n`);
                        await sleep(5000);
                    }
                } else {
                    // Fatal error (auth, bad request)
                    console.error("Fatal API Error:", err);
                    // Try next provider anyway just in case it's a specific provider outage
                    if (providerQueue.length > 1) {
                         currentProviderIndex = (currentProviderIndex + 1) % providerQueue.length;
                         onChunk(` Error encountered. Switching to **${providerQueue[currentProviderIndex].id}**...\n`);
                    } else {
                        throw err;
                    }
                }
            }
        }

        if (!responseData) break;

        if (responseData.content) {
            onChunk(responseData.content);
            messages.push({ role: "assistant", content: responseData.content });
        }

        if (responseData.tool_calls && responseData.tool_calls.length > 0) {
            
            // --- MANUAL APPROVAL LOGIC ---
            if (!autoApprove) {
                const isWrite = responseData.tool_calls.some((t: any) => ['write_file', 'edit_file', 'execute_command', 'create_directory'].includes(t.function.name));
                
                if (isWrite) {
                    // INTERCEPT TOOL CALL: Convert to Dyad UI Tag instead of executing
                    for (const call of responseData.tool_calls) {
                        const fnName = call.function.name;
                        let fnArgs: any = {};
                        try { fnArgs = JSON.parse(call.function.arguments); } catch(e) {}
                        
                        let uiTag = "";
                        // Force 'path' attribute for consistency with parsers
                        let pathVal = fnArgs.path || ""; 
                        
                        if (fnName === "write_file") {
                            uiTag = `\n<dyad-write path="${pathVal}" description="Proposed file creation">\n${fnArgs.content}\n</dyad-write>\n`;
                        } else if (fnName === "edit_file") {
                            uiTag = `\n<dyad-write path="${pathVal}" description="Proposed edit (Full overwrite for safety)">\n${fnArgs.content || "(Content missing from tool call)"}\n</dyad-write>\n`;
                        } else if (fnName === "execute_command") {
                            uiTag = `\n<dyad-command type="execute" command="${fnArgs.command}">Run: ${fnArgs.command}</dyad-command>\n`;
                        } else {
                            uiTag = `\n> **Proposal:** Run tool \`${fnName}\` on \`${pathVal}\`\n`;
                        }
                        
                        onChunk(uiTag);
                    }
                    // Stop execution loop. The UI renders the tag. User must interact or reply.
                    break; 
                }
            }

            messages.push(responseData); 
            let hasError = false;

            for (const call of responseData.tool_calls) {
                const fnName = call.function.name;
                let fnArgs: any = {};
                try { fnArgs = typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments) : call.function.arguments; } catch (e) {}
                
                if (fnArgs.path) fnArgs.path = fnArgs.path.replace(/^(C:\\.*\\dyad-apps\\[^\\]+\\)/i, '').replace(/^path[\\\/]to[\\\/]project[\\\/]/i, '');
                
                let fileTarget = fnArgs.path ? ` (${fnArgs.path})` : "";
                if (fnName === "search_files") fileTarget = ` "${fnArgs.pattern || ''}"`;
                
                const emojiMap: Record<string, string> = { "write_file": "💾", "edit_file": "📝", "read_file": "📖", "execute_command": "💻", "create_directory": "📂", "list_directory": "👀", "search_files": "🔎" };
                const emoji = emojiMap[fnName] || "🛠️";
                onChunk(`\n${emoji} **Agent:** ${fnName}${fileTarget}\n`);
                
                let resultStr = "";
                try {
                    const result = await mcpManager.callTool(fnName, fnArgs) as any;
                    
                    if (result && result.content && Array.isArray(result.content)) {
                         resultStr = result.content.map((c: any) => c.text).join("\n");
                    } else if (result && result.error) {
                         resultStr = `Error: ${result.error}`;
                         hasError = true;
                    } else { resultStr = "Success"; }
                    
                    if (!hasError) onChunk(`✅ Done.\n`);
                    else onChunk(`❌ Failed: ${resultStr.substring(0, 100)}...\n`);

                } catch (err) {
                    resultStr = `Error: ${err}`;
                    onChunk(`❌ Failed: ${err}\n`);
                    hasError = true;
                }
                messages.push({ role: "tool", tool_call_id: call.id, name: fnName, content: resultStr });
            }
            
            if (hasError && !(safeSettings.enableAutoFixProblems ?? true)) break;

        } else { break; }

      } catch (error: any) {
          console.error("Loop Fatal Error:", error);
          onChunk(`\n[Fatal Error: ${error.message}]\n`);
          break;
      }
  }
}