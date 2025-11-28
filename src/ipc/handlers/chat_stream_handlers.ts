import { v4 as uuidv4 } from "uuid";
import { ipcMain } from "electron";
import type { ChatStreamParams, ChatResponseEnd } from "../ipc_types";
import { db } from "../../db";
import { chats, messages } from "../../db/schema";
import { eq } from "drizzle-orm";
import { getDyadAppPath } from "../../paths/paths";
import { readSettings } from "../../main/settings";
import { streamChat } from "../../core/ai_service";
import { streamTestResponse, getTestResponse } from "./testing_chat_handlers";
import log from "electron-log";
import fs from "node:fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { writeFile, unlink } from "fs/promises";
import { FileUploadsState } from "../utils/file_uploads_state";
import { safeSend } from "../utils/safe_sender";
import { getCurrentCommitHash } from "../utils/git_utils";

const logger = log.scope("chat_stream_handlers");
const activeStreams = new Map<number, AbortController>();
const TEMP_DIR = path.join(os.tmpdir(), "dyad-attachments");

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

const TEXT_FILE_EXTENSIONS = [".md", ".txt", ".json", ".csv", ".js", ".ts", ".html", ".css"];

async function isTextFile(filePath: string): Promise<boolean> {
  const ext = path.extname(filePath).toLowerCase();
  return TEXT_FILE_EXTENSIONS.includes(ext);
}

export function registerChatStreamHandlers() {
  ipcMain.handle("chat:stream", async (event, req: ChatStreamParams) => {
    try {
      const fileUploadsState = FileUploadsState.getInstance();
      let dyadRequestId: string | undefined;
      const abortController = new AbortController();
      activeStreams.set(req.chatId, abortController);

      // 1. Fetch Chat Info
      const chat = await db.query.chats.findFirst({
        where: eq(chats.id, req.chatId),
        with: {
          messages: { orderBy: (messages, { asc }) => [asc(messages.createdAt)] },
          app: true,
        },
      });

      if (!chat) throw new Error(`Chat not found: ${req.chatId}`);

      // 2. Handle Redo (Delete old messages if requested)
      if (req.redo) {
        const chatMessages = [...chat.messages];
        let lastUserMessageIndex = chatMessages.length - 1;
        while (lastUserMessageIndex >= 0 && chatMessages[lastUserMessageIndex].role !== "user") {
          lastUserMessageIndex--;
        }
        if (lastUserMessageIndex >= 0) {
          await db.delete(messages).where(eq(messages.id, chatMessages[lastUserMessageIndex].id));
          if (lastUserMessageIndex < chatMessages.length - 1 && chatMessages[lastUserMessageIndex + 1].role === "assistant") {
            await db.delete(messages).where(eq(messages.id, chatMessages[lastUserMessageIndex + 1].id));
          }
        }
      }

      // 3. Process Attachments
      let attachmentInfo = "";
      let attachmentPaths: string[] = [];
      if (req.attachments && req.attachments.length > 0) {
        attachmentInfo = "\n\nAttachments:\n";
        for (const [index, attachment] of req.attachments.entries()) {
          const hash = crypto.createHash("md5").update(attachment.name + Date.now()).digest("hex");
          const filename = `${hash}${path.extname(attachment.name)}`;
          const filePath = path.join(TEMP_DIR, filename);
          const base64Data = attachment.data.split(";base64,").pop() || "";
          
          await writeFile(filePath, Buffer.from(base64Data, "base64"));
          attachmentPaths.push(filePath);

          if (attachment.attachmentType === "upload-to-codebase") {
            const fileId = `DYAD_ATTACHMENT_${index}`;
            fileUploadsState.addFileUpload({ chatId: req.chatId, fileId }, { filePath, originalName: attachment.name });
            attachmentInfo += `\n\nFile to upload: ${attachment.name} (ID: ${fileId})\n`;
          } else {
            attachmentInfo += `- ${attachment.name} (${attachment.type})\n`;
          }
        }
      }

      // 4. Save User Message
      let userPrompt = req.prompt + (attachmentInfo || "");
      const componentsToProcess = req.selectedComponents || [];
      if (componentsToProcess.length > 0) {
        userPrompt += "\n\n[User selected files:]\n";
        userPrompt += componentsToProcess.map(c => `- ${c.relativePath}`).join("\n");
      }

      await db.insert(messages).values({
        chatId: req.chatId,
        role: "user",
        content: userPrompt,
      });

      // 5. Create Placeholder Assistant Message
      // FIX: Read settings fresh here to ensure we capture the toggle state
      const settings = readSettings();
      const safeSettings = settings as any;
      
      if (settings.enableDyadPro) dyadRequestId = uuidv4();

      const [placeholderAssistantMessage] = await db.insert(messages).values({
        chatId: req.chatId,
        role: "assistant",
        content: "", // Start empty
        requestId: dyadRequestId,
        sourceCommitHash: await getCurrentCommitHash({ path: getDyadAppPath(chat.app.path) }),
      }).returning();

      // 6. Prepare the LIVE Message List for the UI
      const updatedChat = await db.query.chats.findFirst({
        where: eq(chats.id, req.chatId),
        with: {
          messages: { orderBy: (messages, { asc }) => [asc(messages.createdAt)] },
          app: true,
        },
      });

      if (!updatedChat) throw new Error("Failed to retrieve updated chat");

      safeSend(event.sender, "chat:response:chunk", {
        chatId: req.chatId,
        messages: updatedChat.messages,
      });

      // 7. Check for Test Response (Dev Mode)
      const testResponse = getTestResponse(req.prompt);
      if (testResponse) {
        await streamTestResponse(event, req.chatId, testResponse, abortController, chat);
        return req.chatId;
      }

      // -------------------------------------------------------
      // CALLING CORE AI SERVICE
      // -------------------------------------------------------
      logger.log("--- DELEGATING TO CORE AI SERVICE ---");

      const coreParams = {
        chatId: req.chatId,
        prompt: userPrompt,
        selectedComponents: req.selectedComponents, 
        attachments: req.attachments,
        // FIX: Explicitly pass the autoApprove setting
        autoApprove: safeSettings.autoApproveChanges 
      };

      let fullResponseAccumulator = "";
      let lastDbSave = Date.now();

      // We clone the messages array so we can mutate the last message (the assistant placeholder)
      const liveMessages = [...updatedChat.messages];
      const assistantMsgIndex = liveMessages.findIndex(m => m.id === placeholderAssistantMessage.id);

      await streamChat(coreParams, async (chunk) => {
        if (abortController.signal.aborted) return;

        // 1. Update local string
        fullResponseAccumulator += chunk;

        // 2. Update the message object that goes to the UI
        if (assistantMsgIndex !== -1) {
            liveMessages[assistantMsgIndex] = {
                ...liveMessages[assistantMsgIndex],
                content: fullResponseAccumulator
            };
        }

        // 3. SEND THE FULL MESSAGE LIST
        safeSend(event.sender, "chat:response:chunk", {
          chatId: req.chatId,
          messages: liveMessages 
        });

        // 4. Save to DB occasionally
        if (Date.now() - lastDbSave > 500) {
          await db.update(messages)
            .set({ content: fullResponseAccumulator })
            .where(eq(messages.id, placeholderAssistantMessage.id));
          lastDbSave = Date.now();
        }
      });

      // Final Save
      await db.update(messages)
        .set({ content: fullResponseAccumulator })
        .where(eq(messages.id, placeholderAssistantMessage.id));

      safeSend(event.sender, "chat:response:end", {
        chatId: req.chatId,
        updatedFiles: false
      });

      if (attachmentPaths.length > 0) {
        attachmentPaths.forEach(p => fs.existsSync(p) && unlink(p).catch(() => {}));
      }

      return req.chatId;

    } catch (error) {
      logger.error("Handler Error:", error);
      safeSend(event.sender, "chat:response:error", {
        chatId: req.chatId,
        error: `System Error: ${error}`,
      });
      activeStreams.delete(req.chatId);
      return "error";
    }
  });

  ipcMain.handle("chat:cancel", async (event, chatId: number) => {
    const controller = activeStreams.get(chatId);
    if (controller) {
      controller.abort();
      activeStreams.delete(chatId);
      logger.log(`Aborted chat ${chatId}`);
    }
    safeSend(event.sender, "chat:response:end", { chatId, updatedFiles: false });
    return true;
  });
}