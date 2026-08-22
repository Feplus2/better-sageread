import type { ChatContext } from "@/hooks/use-chat-state";
import { type UIMessage, type UseChatOptions, useChat as useChatSDK } from "@ai-sdk/react";
import type { ChatInit, LanguageModel } from "ai";
import { useEffect, useRef } from "react";
import { CustomChatTransport } from "../custom-chat-transport";
import { setLiveChatContext } from "../utils/live-chat-context";

type CustomChatOptions = Omit<ChatInit<UIMessage>, "transport"> &
  Pick<UseChatOptions<UIMessage>, "experimental_throttle" | "resume"> & {
    chatContext?: ChatContext;
  };

export function useChat(model: LanguageModel, options?: CustomChatOptions) {
  const { chatContext, ...restOptions } = options || {};
  const chatContextRef = useRef(chatContext);
  // 活注册表：渲染即写（模块级单例），transport 兜底读取——结构性消灭陈旧捕获类故障
  if (chatContext) setLiveChatContext(chatContext);
  const transportRef = useRef<CustomChatTransport | null>(null);

  useEffect(() => {
    chatContextRef.current = chatContext;
  }, [chatContext]);

  if (!transportRef.current) {
    transportRef.current = new CustomChatTransport(model, {
      scopeHint: chatContext?.agentScope,
      prepareSendMessagesRequest: ({ body }) => {
        const currentChatContext = chatContextRef.current;
        return {
          body: {
            ...body,
            chatContext: currentChatContext,
          },
        };
      },
    });
  }

  useEffect(() => {
    if (transportRef.current) {
      transportRef.current.updateModel(model);
    }
  }, [model]);

  const chatResult = useChatSDK({
    transport: transportRef.current,
    ...restOptions,
  });

  return chatResult;
}
