import crypto from "crypto";
import { Tiktoken, getEncoding } from "js-tiktoken";
import Keyv from "keyv";
import OpenAI from "openai";
import {
  ChatCompletionAssistantMessageParam,
  ChatCompletionChunk,
  ChatCompletionCreateParamsBase,
  ChatCompletionMessageParam,
  ChatCompletionSystemMessageParam,
  ChatCompletionUserMessageParam,
} from "openai/resources/chat/completions.mjs";
import { Stream } from "openai/streaming.mjs";
import QuickLRU from "quick-lru";

class ChatGPTAPI {
  private model: ChatCompletionCreateParamsBase["model"] = "gpt-3.5-turbo";
  private store: Keyv<ChatMessage>;
  private openai: OpenAI;
  private maxModelTokens: number = 8000;
  private maxResponseTokens: number = 1000;
  private tokenizer: Tiktoken = getEncoding("cl100k_base");

  constructor(opts: ChatGPTAPIOptions) {
    this.openai = new OpenAI({ apiKey: opts.apiKey });
    this.store = new Keyv<ChatMessage, any>({
      store: new QuickLRU<string, ChatMessage>({ maxSize: 10000 }),
    });
  }

  public async *sendMessage(opts: SendMessageOptions): AsyncGenerator<ChatMessage, void, unknown> {
    const latestQuestion = this.createMessage({ role: "user", text: opts.text }, opts);
    const newMessage = this.createMessage({ role: "assistant", text: "", parentMessageId: latestQuestion.id }, opts);

    const { maxTokens, messages } = await this.buildMessages(opts.text, opts);

    for await (const chunk of await this.streamCompletion(messages, maxTokens)) {
      this.updateResultFromStream(chunk, newMessage);
      console.log(latestQuestion.choice?.finish_reason);
      if (latestQuestion.choice?.finish_reason !== "stop") yield newMessage;

      this.storeMessages(latestQuestion, newMessage);
    }
  }

  private createMessage(
    config: { role: ChatMessage["role"]; text: string; parentMessageId?: string },
    opts: SendMessageOptions,
  ): ChatMessage {
    return {
      id: crypto.randomUUID(),
      role: config.role,
      text: config.text,
      parentMessageId: config?.parentMessageId || opts?.parentMessageId || undefined,
      fileLink: opts?.fileLink,
    };
  }

  private async buildMessages(
    text: string,
    opts: SendMessageOptions,
  ): Promise<{ messages: ChatCompletionMessageParam[]; maxTokens: number }> {
    let messages: Array<ChatCompletionUserMessageParam | ChatCompletionSystemMessageParam> = [];
    if (opts.systemMessage) {
      messages.push({ role: "system", content: opts.systemMessage });
    }

    const maxNumTokens = this.maxModelTokens - this.maxResponseTokens;
    let numTokens = 0;

    do {
      const userMessages: ChatCompletionUserMessageParam = {
        role: "user",
        content: [
          { type: "text", text },
          opts.fileLink ? { type: "image_url", image_url: { url: opts.fileLink } } : null,
        ].filter(Boolean) as ChatCompletionUserMessageParam["content"],
      };
      messages.push(userMessages);
      const prompt = this.formatPrompt(messages);
      numTokens = this.getTokenCount(prompt);

      if (numTokens > maxNumTokens || !opts.parentMessageId) break;

      const parentMessage = await this.store.get(opts.parentMessageId);
      if (!parentMessage) break;

      text = parentMessage.text;
      opts.parentMessageId = parentMessage.parentMessageId;
    } while (true);

    const maxTokens = Math.max(1, Math.min(this.maxModelTokens - numTokens, this.maxResponseTokens));
    return { messages, maxTokens };
  }

  private formatPrompt(
    messages: Array<
      ChatCompletionUserMessageParam | ChatCompletionSystemMessageParam | ChatCompletionAssistantMessageParam
    >,
  ): string {
    return messages
      .map((message) => {
        switch (message.role) {
          case "system":
            return `Instructions:\n${message.content}`;
          case "assistant":
            return `Assistant:\n${(message as ChatCompletionAssistantMessageParam).content}`;
          case "user":
            return `User:\n${
              Array.isArray(message.content)
                ? message.content.map((p) => (p.type === "text" ? p.text : p.image_url.url)).join("")
                : message.content
            }`;
          default:
            return "";
        }
      })
      .join("\n\n");
  }

  private async streamCompletion(
    messages: ChatCompletionMessageParam[],
    max_tokens: number,
  ): Promise<Stream<ChatCompletionChunk>> {
    return this.openai.chat.completions.create({
      model: this.model,
      messages,
      max_tokens,
      stream: true,
    });
  }

  private updateResultFromStream(chunk: ChatCompletionChunk, result: ChatMessage): void {
    const choice = chunk.choices?.[0];
    if (choice?.delta?.content) {
      result.text += choice.delta.content;
      result.detail = chunk;
      result.delta = choice.delta;
    }
    if (choice.finish_reason === "stop") {
      console.log("stop");
      result.choice = choice;
    }
  }

  private storeMessages(latestQuestion: ChatMessage, result: ChatMessage): void {
    this.store.set(latestQuestion.id, latestQuestion);
    this.store.set(result.id, result);
  }

  private getTokenCount(text: string): number {
    return this.tokenizer.encode(text.replace(/<\|endoftext\|>/g, "")).length;
  }
}

export type Role = OpenAI.Chat.Completions.ChatCompletionChunk["choices"][0]["delta"]["role"];

export type ChatGPTAPIOptions = {
  apiKey: string;
};

export type SendMessageOptions = {
  text: string;
  parentMessageId?: string | null;
  systemMessage?: string;
  fileLink?: string;
};

export interface ChatMessage {
  id: string;
  text: string;
  role: Role;
  delta?: OpenAI.Chat.Completions.ChatCompletionChunk["choices"][0]["delta"];
  choice?: OpenAI.Chat.Completions.ChatCompletionChunk["choices"][0];
  detail?: OpenAI.Chat.Completions.ChatCompletionChunk;
  usage?: ChatUsage;
  parentMessageId?: string;
  fileLink?: string;
}

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

const globalForPrisma = global as unknown as { api: ChatGPTAPI };

export const gpt = globalForPrisma.api || new ChatGPTAPI({ apiKey: process.env.OPEN_AI });

if (process.env.NODE_ENV !== "production") globalForPrisma.api = gpt;
