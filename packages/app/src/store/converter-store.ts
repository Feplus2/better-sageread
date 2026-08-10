import { tauriStorageKey } from "@/constants/tauri-storage";
import { tauriStorage } from "@/lib/tauri-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/** 书籍转换解析引擎（Books_Converter --engine；表格密集默认 mineru 更稳） */
export type BookConvertEngine = "mineru" | "paddleocr";

/** 论文解析引擎（Papers_Converter --provider；基线 paddleocr，MinerU 表格备选，GLM 第二备选；
 * mineru-pipeline = MinerU pipeline 后端 + 不强制 OCR：文字版论文零幻觉、整图不碎） */
export type PaperConvertEngine = "paddleocr" | "mineru" | "mineru-pipeline" | "glm";

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
 * PDF 转换设置。MinerU/PaddleOCR/GLM Token 由 OS 凭据管理器（keyring）保管（批次 A），
 * 仅启动时载入内存供请求使用；引擎选择等非密配置存于本机 converter-store.json；
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
        // 安全（批次 A）：token 仅存内存（启动时自 keyring 载入），落盘不含密钥
        mineruToken: "",
        paddleocrToken: "",
        glmApiKey: "",
        engine: state.engine,
        paperEngine: state.paperEngine,
        zoteroDataDir: state.zoteroDataDir,
      }),
    },
  ),
);
