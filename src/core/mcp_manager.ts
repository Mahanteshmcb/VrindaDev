import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import { applySearchReplace } from "./search_replace";

const execAsync = promisify(exec);

class MCPManager {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private currentRoot: string = "";

  private customTools = [
    { name: "execute_command", description: "Execute a shell command (npm install, git status, etc.).", inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
    { name: "edit_file", description: "Surgically edit a file by replacing a specific block of code.", inputSchema: { type: "object", properties: { path: { type: "string" }, search: { type: "string" }, replace: { type: "string" } }, required: ["path", "search", "replace"] } }
  ];

  async connect(rootPath: string) {
    const normalizedPath = path.normalize(rootPath);
    if (this.client && this.currentRoot === normalizedPath) return;
    
    if (this.client) {
        try { await this.transport?.close(); } catch(e) {}
        this.client = null;
    }

    this.currentRoot = normalizedPath;
    console.log(`🔌 [MCP] Setting Target Root: ${this.currentRoot}`);
    
    try {
        const SERVER_CONFIG = {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", this.currentRoot],
        };
        
        this.transport = new StdioClientTransport(SERVER_CONFIG);
        this.client = new Client({ name: "VrindaDev", version: "1.0" }, { capabilities: {} });
        await this.client.connect(this.transport);
        console.log("✅ [MCP] Server Connected!");
    } catch (e) {
        console.error("❌ [MCP] Connection Failed:", e);
        this.client = null;
    }
  }

  async listTools() {
    // FIX: Pass currentRoot explicitly if called without arguments
    if (!this.client) await this.connect(this.currentRoot || process.cwd()); 
    if (!this.client) return []; 
    
    let fileTools: any[] = [];
    if (this.client) {
        try {
            const result = await (this.client as any).request(
                { method: "tools/list" },
                { parse: (data: any) => data } 
            );
            fileTools = result?.tools || [];
        } catch (error) {}
    }

    const allTools = [...fileTools, ...this.customTools];
    const uniqueTools = Array.from(new Map(allTools.map(tool => [tool.name, tool])).values());

    return uniqueTools;
  }

  async callTool(name: string, args: any) {
    // FIX: Pass currentRoot explicitly if called without arguments
    if (!this.client) await this.connect(this.currentRoot || process.cwd());
    if (!this.currentRoot) throw new Error("No project root set");
    console.log(`🛠️ [MCP] Executing: ${name}`);

    // Helper to get sanitized path for FS operations
    const getFullPath = (p: string) => path.join(this.currentRoot, p.replace(/^[\\\/]/, ''));

    // --- 1. INTERCEPT WRITE/EDIT (Direct FS Access) ---
    if (name === "write_file" || name === "edit_file") {
        try {
            const fullPath = getFullPath(args.path);
            const dir = path.dirname(fullPath);
            
            if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }

            let finalContent = args.content;
            
            if (name === "edit_file") {
                const content = fs.readFileSync(fullPath, "utf-8");
                finalContent = applySearchReplace(content, args.search, args.replace);
                if (!finalContent) throw new Error(`Search block not found in ${args.path}.`);
            }
            
            fs.writeFileSync(fullPath, finalContent, "utf-8");
            
            return { success: true, message: `Successfully wrote to ${args.path}` };
        } catch (e: any) {
            console.error(`❌ [Disk FAIL]: ${e.message}`);
            return { success: false, error: `File Operation Failed: ${e.message}` };
        }
    }

    // --- 2. INTERCEPT SHELL COMMANDS ---
    if (name === "execute_command") {
        try {
            const { stdout, stderr } = await execAsync(args.command, { 
                cwd: this.currentRoot, 
                maxBuffer: 10 * 1024 * 1024 
            });
            return { content: [{ type: "text", text: stdout + (stderr ? `\nSTDERR:\n${stderr}` : "") }] };
        } catch (e: any) { 
            console.error(`CMD Failed: ${args.command}`);
            return { content: [{ type: "text", text: `Command Failed: ${e.message}` }] }; 
        }
    }

    // --- 3. FORWARD READS/LISTS TO SERVER ---
    if (!this.client) throw new Error("MCP Client not connected");
    
    try {
      // NOTE: We still use the server for list_directory/read_file to get the nice JSON-RPC structure
      const result = await (this.client as any).request(
        { method: "tools/call", params: { name, arguments: args } },
        { parse: (data: any) => data }
      );
      
      // If the file was read, we log a preview to the backend console
      if (name === "read_file" && result.content) {
          const contentStr = result.content.map((c: any) => c.text).join('\n') || '[EMPTY CONTENT]';
          console.log(`📖 [Read Success: ${args.path}] (First 200 chars):\n${contentStr.substring(0, 200)}...`);
      }
      
      return result;
    } catch (error) { throw error; }
  }
}

export const mcpManager = new MCPManager();