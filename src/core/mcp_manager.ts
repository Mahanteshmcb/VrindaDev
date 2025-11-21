import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import { applySearchReplace } from "./search_replace";

const execAsync = promisify(exec);

class MCPManager {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private currentRoot: string = process.cwd(); // Default to CWD

  // --- CUSTOM & OVERRIDDEN TOOLS ---
  private customTools = [
    {
      name: "execute_command",
      description: "Execute a shell command (npm install, git status, etc.). Output is limited to 10MB.",
      inputSchema: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"]
      }
    },
    {
      name: "edit_file",
      description: "Surgically edit a file by replacing a specific block of code. Use this for modifications instead of overwriting the whole file.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          search: { type: "string" },
          replace: { type: "string" }
        },
        required: ["path", "search", "replace"]
      }
    }
    // We don't need to re-define write_file/read_file schema here, we just intercept the calls.
  ];

  async connect(rootPath: string) {
    // Normalize path for Windows consistency
    const normalizedPath = path.normalize(rootPath);

    if (this.client && this.currentRoot === normalizedPath) return;
    
    // Close existing connection
    if (this.client) {
        try { await this.transport?.close(); } catch(e) {}
        this.client = null;
    }

    this.currentRoot = normalizedPath;
    console.log(`🔌 [MCP] Setting Target Root: ${this.currentRoot}`);
    
    // We still start the server for 'list_directory' and discovery, 
    // but we will handle writes ourselves.
    try {
        const SERVER_CONFIG = {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", this.currentRoot],
        };
        
        this.transport = new StdioClientTransport(SERVER_CONFIG);
        this.client = new Client(
          { name: "VrindaDev-Client", version: "1.0.0" },
          { capabilities: {} }
        );

        await this.client.connect(this.transport);
        console.log("✅ [MCP] Server Connected!");
    } catch (e) {
        console.error("❌ [MCP] Connection Failed:", e);
        this.client = null;
    }
  }

  async listTools() {
    if (!this.client) return []; 
    let fileTools: any[] = [];
    try {
        const result = await (this.client as any).request(
            { method: "tools/list" },
            { parse: (data: any) => data } 
        );
        fileTools = result?.tools || [];
    } catch (error) {}

    // Add our custom tools to the list
    return [...fileTools, ...this.customTools];
  }

  async callTool(name: string, args: any) {
    if (!this.currentRoot) throw new Error("No project root set");
    console.log(`🛠️ [MCP] Executing: ${name}`);

    // --- 1. INTERCEPT FILE WRITES (Direct FS Access) ---
    if (name === "write_file") {
        try {
            // Strip leading slashes to ensure it joins correctly to currentRoot
            const safePath = args.path.replace(/^[\\\/]/, '');
            const fullPath = path.join(this.currentRoot, safePath);
            const dir = path.dirname(fullPath);
            
            // Ensure directory exists
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            // Force write to disk
            fs.writeFileSync(fullPath, args.content, "utf-8");
            console.log(`💾 [Disk] Wrote to: ${fullPath}`);
            
            return { content: [{ type: "text", text: `Successfully wrote to ${args.path}` }] };
        } catch (e: any) {
            return { content: [{ type: "text", text: `Write Error: ${e.message}` }] };
        }
    }

    // --- 2. INTERCEPT FILE EDITS (Surgical) ---
    if (name === "edit_file") {
        try {
            const safePath = args.path.replace(/^[\\\/]/, '');
            const fullPath = path.join(this.currentRoot, safePath);
            
            if (!fs.existsSync(fullPath)) return { isError: true, content: [{ type: "text", text: `File not found: ${args.path}` }]};
            
            const content = fs.readFileSync(fullPath, "utf-8");
            const newContent = applySearchReplace(content, args.search, args.replace);
            
            if (!newContent) return { isError: true, content: [{ type: "text", text: "Search block not found." }]};
            
            fs.writeFileSync(fullPath, newContent, "utf-8");
            console.log(`💾 [Disk] Patched: ${fullPath}`);
            return { content: [{ type: "text", text: `Successfully patched ${args.path}` }] };
        } catch (e: any) {
            return { content: [{ type: "text", text: `Edit Error: ${e.message}` }] };
        }
    }

    // --- 3. INTERCEPT SHELL COMMANDS ---
    if (name === "execute_command") {
        try {
            const { stdout, stderr } = await execAsync(args.command, { 
                cwd: this.currentRoot, 
                maxBuffer: 10 * 1024 * 1024 
            });
            return { content: [{ type: "text", text: stdout + (stderr ? `\nSTDERR:\n${stderr}` : "") }] };
        } catch (e: any) { 
            return { content: [{ type: "text", text: `Command Failed:\n${e.message}` }] }; 
        }
    }

    // --- 4. FORWARD READS/LISTS TO SERVER ---
    if (!this.client) throw new Error("MCP Client not connected");
    
    try {
      const result = await (this.client as any).request(
        { 
          method: "tools/call",
          params: { name, arguments: args }
        },
        { parse: (data: any) => data }
      );
      return result;
    } catch (error) {
      console.error(`❌ [MCP] Tool execution error: ${error}`);
      throw error;
    }
  }
}

export const mcpManager = new MCPManager();