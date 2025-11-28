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
    { 
      name: "execute_command", 
      description: "Execute a shell command (npm install, git status, etc.). Output is limited to 10MB.", 
      inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } 
    },
    { 
      name: "create_directory", 
      description: "Create a new directory.", 
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } 
    },
    { 
      name: "edit_file", 
      description: "Surgically edit a file by replacing a specific block of code.", 
      inputSchema: { type: "object", properties: { path: { type: "string" }, search: { type: "string" }, replace: { type: "string" } }, required: ["path", "search", "replace"] } 
    }
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
    if (!this.client) await this.connect(this.currentRoot || process.cwd()); 
    if (!this.client) return []; 
    
    let fileTools: any[] = [];
    try {
        const result = await (this.client as any).request(
            { method: "tools/list" },
            { parse: (data: any) => data } 
        );
        fileTools = result?.tools || [];
    } catch (error) {}

    const allTools = [...fileTools, ...this.customTools];
    const uniqueTools = Array.from(new Map(allTools.map(tool => [tool.name, tool])).values());

    return uniqueTools;
  }

  async callTool(name: string, args: any) {
    if (!this.currentRoot) throw new Error("No project root set");
    console.log(`🛠️ [MCP] Executing: ${name}`);

    const getFullPath = (p: string) => path.join(this.currentRoot, p.replace(/^[\\\/]/, ''));

    // --- 1. WRITE & EDIT FILE ---
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
            
            console.log(`💾 [Disk SUCCESS]: Wrote ${args.path}`);
            return { 
                success: true, 
                message: `Successfully wrote to ${args.path}. Verify the content if needed, or proceed to the NEXT file. Do not overwrite this file again with the same content.`
              };
        } catch (e: any) {
            console.error(`❌ [Disk FAIL]: ${e.message}`);
            return { success: false, error: `File Operation Failed: ${e.message}` };
        }
    }

    // --- 2. CREATE DIRECTORY ---
    if (name === "create_directory") {
        try {
             const fullPath = getFullPath(args.path);
             if (!fs.existsSync(fullPath)) {
                 fs.mkdirSync(fullPath, { recursive: true });
                 console.log(`📂 [Dir Created]: ${args.path}`);
                 return { content: [{ type: "text", text: `Created directory: ${args.path}` }] };
             } else {
                 return { content: [{ type: "text", text: `Directory exists: ${args.path}` }] };
             }
        } catch (e: any) {
             return { content: [{ type: "text", text: `Error: ${e.message}` }] };
        }
    }

    // --- 3. EXECUTE COMMAND ---
    if (name === "execute_command") {
        try {
            const { stdout, stderr } = await execAsync(args.command, { cwd: this.currentRoot, maxBuffer: 10 * 1024 * 1024 });
            console.log(`💻 [CMD SUCCESS]: ${args.command}`);
            
            // Truncate output to prevent context overflow
            const output = stdout + (stderr ? `\nSTDERR:\n${stderr}` : "");
            const truncated = output.length > 2000 ? output.substring(0, 2000) + "\n...[Output Truncated]..." : output;
            
            return { content: [{ type: "text", text: truncated }] };
        } catch (e: any) { 
            console.error(`CMD Failed: ${args.command}`);
            return { content: [{ type: "text", text: `Command Failed: ${e.message}` }] }; 
        }
    }

    // --- 4. READ/LIST (Forward to Server) ---
    if (!this.client) throw new Error("MCP Client not connected");
    try {
      const result = await (this.client as any).request(
        { method: "tools/call", params: { name, arguments: args } },
        { parse: (data: any) => data }
      );

      if (name === "read_file" && result.content) {
          const contentStr = result.content.map((c: any) => c.text).join('\n') || '[EMPTY]';
          console.log(`📖 [Read]: ${args.path} (${contentStr.length} bytes)`);
      }
      
      return result;
    } catch (error) { throw error; }
  }
}

export const mcpManager = new MCPManager();