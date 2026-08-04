import { tauriStorageKey } from "@/constants/tauri-storage";
import { tauriStorage } from "@/lib/tauri-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/** 书籍转换解析引擎（Books_Converter --engine；表格密集默认 mineru 更稳） */
export type BookConvertEngine = "mineru" | "paddleocr";

interface ConverterState {
  mineruToken: string;
  paddleocrToken: string;
  engine: BookConvertEngine;
  setMineruToken: (token: string) => void;
  setPaddleocrToken: (token: string) => void;
  setEngine: (engine: BookConvertEngine) => void;
}

/**
 * PDF 转换设置。MinerU/PaddleOCR Token 与引擎选择存于本机 converter-store.json；
 * L1 备份白名单（backup.rs JSON_FILES）与同步通道均不含此文件，密钥不会外传。
 */
export const useConverterStore = create<ConverterState>()(
  persist(
    (set) => ({
      mineruToken: "",
      paddleocrToken: "",
      engine: "mineru",
      setMineruToken: (mineruToken: string) => set({ mineruToken }),
      setPaddleocrToken: (paddleocrToken: string) => set({ paddleocrToken }),
      setEngine: (engine: BookConvertEngine) => set({ engine }),
    }),
    {
      name: tauriStorageKey.converterStore,
      storage: createJSONStorage(() => tauriStorage),
      partialize: (state) => ({
        mineruToken: state.mineruToken,
        paddleocrToken: state.paddleocrToken,
        engine: state.engine,
      }),
    },
  ),
);
