import { tauriStorageKey } from "@/constants/tauri-storage";
import { tauriStorage } from "@/lib/tauri-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/** 书籍转换解析引擎（Books_Converter --engine；表格密集默认 mineru 更稳） */
export type BookConvertEngine = "mineru" | "paddleocr";

/** 论文解析引擎（Papers_Converter --provider；基线 paddleocr，MinerU 表格备选，GLM 第二备选） */
export type PaperConvertEngine = "paddleocr" | "mineru" | "glm";

interface ConverterState {
  mineruToken: string;
  paddleocrToken: string;
  glmApiKey: string;
  engine: BookConvertEngine;
  paperEngine: PaperConvertEngine;
  /** Zotero 数据目录（含 zotero.sqlite 与 storage/），默认 %USERPROFILE%\Zotero */
  zoteroDataDir: string;
  setMineruToken: (token: string) => void;
  setPaddleocrToken: (token: string) => void;
  setGlmApiKey: (key: string) => void;
  setEngine: (engine: BookConvertEngine) => void;
  setPaperEngine: (engine: PaperConvertEngine) => void;
  setZoteroDataDir: (dir: string) => void;
}

/**
 * PDF 转换设置。MinerU/PaddleOCR/GLM Token 与引擎选择存于本机 converter-store.json；
 * L1 备份白名单（backup.rs JSON_FILES）与同步通道均不含此文件，密钥不会外传。
 */
export const useConverterStore = create<ConverterState>()(
  persist(
    (set) => ({
      mineruToken: "",
      paddleocrToken: "",
      glmApiKey: "",
      engine: "mineru",
      paperEngine: "paddleocr",
      zoteroDataDir: "",
      setMineruToken: (mineruToken: string) => set({ mineruToken }),
      setPaddleocrToken: (paddleocrToken: string) => set({ paddleocrToken }),
      setGlmApiKey: (glmApiKey: string) => set({ glmApiKey }),
      setEngine: (engine: BookConvertEngine) => set({ engine }),
      setPaperEngine: (paperEngine: PaperConvertEngine) => set({ paperEngine }),
      setZoteroDataDir: (zoteroDataDir: string) => set({ zoteroDataDir }),
    }),
    {
      name: tauriStorageKey.converterStore,
      storage: createJSONStorage(() => tauriStorage),
      partialize: (state) => ({
        mineruToken: state.mineruToken,
        paddleocrToken: state.paddleocrToken,
        glmApiKey: state.glmApiKey,
        engine: state.engine,
        paperEngine: state.paperEngine,
        zoteroDataDir: state.zoteroDataDir,
      }),
    },
  ),
);
