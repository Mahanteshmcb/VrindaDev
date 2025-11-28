import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import { glob } from "glob";
import { applySearchReplace } from "./search_replace";

const execAsync = promisify(exec);

class MCPManager {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private currentRoot: string = "";

  private customTools = [
    { 
      name: "execute_command", 
      description: "Execute a shell command (npm install, git status, build scripts, etc.). Output is limited to 2MB.", 
      inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } 
    },
    { 
      name: "create_directory", 
      description: "Create a new directory recursively.", 
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } 
    },
    { 
      name: "list_directory", 
      description: "List files and folders in a directory (non-recursive).", 
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } 
    },
    {
      name: "search_files",
      description: "Search for files using a glob pattern. USE THIS if you cannot find a file or are unsure of the path.",
      inputSchema: { type: "object", properties: { pattern: { type: "string", description: "Glob pattern (e.g. '**/button.tsx' or 'src/**/*.css')" } }, required: ["pattern"] }
    },
    { 
      name: "write_file", 
      description: "Write full content to a file (overwrites existing).", 
      inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } 
    },
    { 
      name: "read_file", 
      description: "Read content of a file.", 
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
        console.warn("⚠️ [MCP] Connection Failed. Using local fallback for file operations.", e);
        this.client = null;
    }
  }

  async listTools() {
    return this.customTools;
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
                if (!fs.existsSync(fullPath)) throw new Error(`File not found: ${args.path}. Use 'search_files' to find the correct path.`);
                const content = fs.readFileSync(fullPath, "utf-8");
                finalContent = applySearchReplace(content, args.search, args.replace);
                if (!finalContent) throw new Error(`Search block not found in ${args.path}. Ensure whitespace matches.`);
            }
            
            fs.writeFileSync(fullPath, finalContent, "utf-8");
            
            console.log(`💾 [Disk SUCCESS]: Wrote ${args.path}`);
            return { 
                success: true, 
                content: [{ type: "text", text: `Successfully wrote to ${args.path}.` }]
              };
        } catch (e: any) {
            console.error(`❌ [Disk FAIL]: ${e.message}`);
            return { error: `File Operation Failed: ${e.message}` };
        }
    }

    // --- 2. SEARCH FILES (Glob) ---
    if (name === "search_files") {
        try {
            // Safe glob search ignoring heavy folders
            // Fixed: Removed 'limit' option and used slice instead
            const files = await glob(args.pattern, { 
                cwd: this.currentRoot, 
                ignore: ["**/node_modules/**", "**/dist/**", "**/.git/**", "**/.next/**"],
                nodir: true
            });
            
            if (files.length === 0) return { content: [{ type: "text", text: "No files found matching that pattern." }] };
            
            // Manually limit results
            const limitedFiles = files.slice(0, 50);
            return { content: [{ type: "text", text: `Found files (showing first 50):\n${limitedFiles.join("\n")}` }] };
        } catch (e: any) {
            return { error: `Search Error: ${e.message}` };
        }
    }

    // --- 3. READ / LIST / CREATE (Hybrid Fallback) ---
    if (name === "read_file" || name === "list_directory" || name === "create_directory") {
        try {
            const fullPath = getFullPath(args.path);
            
            if (name === "read_file") {
                if (!fs.existsSync(fullPath)) return { error: `File not found: ${args.path}. Try using 'search_files' to locate it.` };
                const content = fs.readFileSync(fullPath, "utf-8");
                return { content: [{ type: "text", text: content }] };
            }
            if (name === "list_directory") {
                if (!fs.existsSync(fullPath)) return { error: `Directory not found: ${args.path}` };
                const items = fs.readdirSync(fullPath);
                return { content: [{ type: "text", text: items.join("\n") }] };
            }
            if (name === "create_directory") {
                fs.mkdirSync(fullPath, { recursive: true });
                return { content: [{ type: "text", text: `Created ${args.path}` }] };
            }
        } catch (localErr: any) {
            return { error: `FS Error: ${localErr.message}` };
        }
    }

    // --- 4. EXECUTE COMMAND ---
    if (name === "execute_command") {
        try {
            const { stdout, stderr } = await execAsync(args.command, { cwd: this.currentRoot, maxBuffer: 10 * 1024 * 1024 });
            console.log(`💻 [CMD SUCCESS]: ${args.command}`);
            
            const output = (stdout || "") + (stderr ? `\nSTDERR:\n${stderr}` : "");
            const truncated = output.length > 5000 ? output.substring(0, 5000) + "\n...[Output Truncated]..." : (output || "Success (No Output)");
            
            return { content: [{ type: "text", text: truncated }] };
        } catch (e: any) { 
            console.error(`CMD Failed: ${args.command}`);
            return { error: `Command Failed: ${e.message}\nStderr: ${e.stderr || ""}` }; 
        }
    }

    if (this.client) {
        try {
            return await (this.client as any).request(
                { method: "tools/call", params: { name, arguments: args } },
                { parse: (data: any) => data }
            );
        } catch (e: any) { return { error: `MCP Forward Error: ${e.message}` }; }
    }

    return { error: `Tool ${name} not found.` };
  }
}

export const mcpManager = new MCPManager();