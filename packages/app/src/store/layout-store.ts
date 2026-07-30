import { tauriStorageKey } from "@/constants/tauri-storage";
import { tauriStorage } from "@/lib/tauri-storage";
import type { ReaderStore } from "@/pages/reader/store/create-reader-store";
import { createReaderStore } from "@/pages/reader/store/create-reader-store";
import type { TabProperties } from "app-tabs";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export interface Tab extends TabProperties {
  /** 书籍 tab 为 bookId；论文 tab 复用为 paperId（会话/线程以它为键） */
  bookId: string;
  /** 缺省为 "book"（兼容旧持久化数据无此字段） */
  type?: "book" | "paper";
}

export type TabOrientation = "horizontal" | "vertical";

interface LayoutStore {
  tabs: Tab[];
  activeTabId: string | null;
  isHomeActive: boolean;
  readerStores: Map<string, ReaderStore>;

  isChatVisible: boolean;
  isNotepadVisible: boolean;

  tabOrientation: TabOrientation;
  isVerticalTabCollapsed: boolean;

  openBook: (bookId: string, title: string) => void;
  openPaper: (paperId: string, title: string) => void;
  removeTab: (tabId: string) => void;
  activateTab: (tabId: string) => void;
  navigateToHome: () => void;
  updateTab: (tabId: string, updates: Partial<Tab>) => void;
  reorderTab: (tabId: string, fromIndex: number, toIndex: number) => void;
  getReaderStore: (tabId: string) => ReaderStore | undefined;
  toggleChatSidebar: () => void;
  toggleNotepadSidebar: () => void;
  toggleTabOrientation: () => void;
  toggleVerticalTabCollapsed: () => void;
}

export const useLayoutStore = create<LayoutStore>()(
  persist(
    (set, get) => ({
      tabs: [],
      activeTabId: null,
      isHomeActive: true,
      readerStores: new Map(),
      isChatVisible: true,
      isNotepadVisible: false,
      tabOrientation: "horizontal",
      isVerticalTabCollapsed: false,

      openBook: (bookId: string, title: string) => {
        const tabId = `reader-${bookId}`;
        const { tabs, activateTab, readerStores } = get();

        const existingTab = tabs.find((t) => t.id === tabId);
        if (existingTab) {
          activateTab(tabId);
          return;
        }

        if (!readerStores.has(tabId)) {
          const store = createReaderStore(bookId);
          readerStores.set(tabId, store);
        }

        const newTab: Tab = {
          id: tabId,
          title,
          active: true,
          isCloseIconVisible: true,
          bookId,
          type: "book",
        };

        // 分组聚拢：书籍排在论文前，新书插到首个论文 tab 之前（无论文则追加到末尾）
        const nextTabs = tabs.map((t) => ({ ...t, active: false }));
        const firstPaperIndex = nextTabs.findIndex((t) => (t.type ?? "book") === "paper");
        if (firstPaperIndex === -1) {
          nextTabs.push(newTab);
        } else {
          nextTabs.splice(firstPaperIndex, 0, newTab);
        }

        set({
          tabs: nextTabs,
          activeTabId: tabId,
          isHomeActive: false,
        });
      },

      openPaper: (paperId: string, title: string) => {
        const tabId = `paper-${paperId}`;
        const { tabs, activateTab } = get();

        const existingTab = tabs.find((t) => t.id === tabId);
        if (existingTab) {
          activateTab(tabId);
          return;
        }

        // 论文 tab 无需 foliate reader store（非 EPUB 渲染）
        const newTab: Tab = {
          id: tabId,
          title,
          active: true,
          isCloseIconVisible: true,
          bookId: paperId,
          type: "paper",
        };

        // 论文组在末尾，直接追加即保持"书籍在前、论文在后"
        set({
          tabs: [...tabs.map((t) => ({ ...t, active: false })), newTab],
          activeTabId: tabId,
          isHomeActive: false,
        });
      },

      removeTab: (tabId: string) => {
        const { tabs, readerStores } = get();

        const store = readerStores.get(tabId);
        if (store) {
          readerStores.delete(tabId);
        }

        const removedTabIndex = tabs.findIndex((t) => t.id === tabId);
        const removedTab = tabs[removedTabIndex];
        const wasActive = removedTab?.active;
        const tabsAfterClose = tabs.filter((t) => t.id !== tabId);

        if (wasActive) {
          if (tabsAfterClose.length > 0) {
            const newActiveIndex =
              removedTabIndex < tabsAfterClose.length ? removedTabIndex : tabsAfterClose.length - 1;
            const newActiveTab = tabsAfterClose[newActiveIndex];
            if (newActiveTab) {
              const updatedTabs = tabsAfterClose.map((t) => ({ ...t, active: t.id === newActiveTab.id }));
              set({
                tabs: updatedTabs,
                activeTabId: newActiveTab.id,
                isHomeActive: false,
              });
            }
          } else {
            set({
              tabs: tabsAfterClose,
              activeTabId: null,
              isHomeActive: true,
            });
          }
        } else {
          set({ tabs: tabsAfterClose });
        }
      },

      activateTab: (tabId: string) => {
        const { tabs } = get();
        set({
          tabs: tabs.map((t) => ({ ...t, active: t.id === tabId })),
          activeTabId: tabId,
          isHomeActive: false,
        });
      },

      navigateToHome: () => {
        const { tabs } = get();
        set({
          tabs: tabs.map((t) => ({ ...t, active: false })),
          activeTabId: null,
          isHomeActive: true,
        });
      },

      updateTab: (tabId: string, updates: Partial<Tab>) => {
        const { tabs } = get();
        set({
          tabs: tabs.map((t) => (t.id === tabId ? { ...t, ...updates } : t)),
        });
      },

      reorderTab: (tabId: string, fromIndex: number, toIndex: number) => {
        const { tabs } = get();
        if (fromIndex === toIndex || fromIndex < 0 || fromIndex >= tabs.length) return;
        const newTabs = [...tabs];
        const [moved] = newTabs.splice(fromIndex, 1);
        if (!moved) return;
        // 分组约束（书籍在前、论文在后）：目标位置限制在同组范围内，拖拽不能跨界
        const movedType = moved.type ?? "book";
        let min = movedType === "book" ? 0 : newTabs.length;
        let max = min;
        newTabs.forEach((t, i) => {
          if ((t.type ?? "book") === movedType) {
            min = Math.min(min, i);
            max = Math.max(max, i + 1);
          }
        });
        const clampedTo = Math.max(min, Math.min(toIndex, max));
        newTabs.splice(clampedTo, 0, moved);
        set({ tabs: newTabs });
      },

      getReaderStore: (tabId: string) => {
        return get().readerStores.get(tabId);
      },

      toggleChatSidebar: () => {
        set({ isChatVisible: !get().isChatVisible });
      },

      toggleNotepadSidebar: () => {
        set({ isNotepadVisible: !get().isNotepadVisible });
      },

      toggleTabOrientation: () => {
        set({ tabOrientation: get().tabOrientation === "horizontal" ? "vertical" : "horizontal" });
      },

      toggleVerticalTabCollapsed: () => {
        set({ isVerticalTabCollapsed: !get().isVerticalTabCollapsed });
      },
    }),
    {
      name: tauriStorageKey.layoutStore,
      storage: createJSONStorage(() => tauriStorage),
      partialize: (state) => ({
        tabs: state.tabs,
        activeTabId: state.activeTabId,
        isHomeActive: state.isHomeActive,
        isChatVisible: state.isChatVisible,
        isNotepadVisible: state.isNotepadVisible,
        tabOrientation: state.tabOrientation,
        isVerticalTabCollapsed: state.isVerticalTabCollapsed,
      }),
      merge: (persistedState, currentState) => {
        const persisted = persistedState as any;
        const readerStores = new Map<string, ReaderStore>();

        // 分组聚拢（书籍在前、论文在后，组内保持原顺序）+ 兼容旧数据（无 type 字段视为 book）
        const persistedTabs: Tab[] = Array.isArray(persisted?.tabs) ? persisted.tabs : [];
        const tabs = [
          ...persistedTabs.filter((t) => (t.type ?? "book") === "book"),
          ...persistedTabs.filter((t) => (t.type ?? "book") === "paper"),
        ];

        for (const tab of tabs) {
          if ((tab.type ?? "book") !== "book") continue; // 论文 tab 无 foliate reader store，无需重建
          if (!readerStores.has(tab.id)) {
            const store = createReaderStore(tab.bookId);
            readerStores.set(tab.id, store);
          }
        }

        return {
          ...currentState,
          tabs,
          activeTabId: persisted?.activeTabId || null,
          isHomeActive: persisted?.isHomeActive ?? true,
          isChatVisible: persisted?.isChatVisible ?? true,
          isNotepadVisible: persisted?.isNotepadVisible ?? false,
          tabOrientation: persisted?.tabOrientation === "vertical" ? "vertical" : "horizontal",
          isVerticalTabCollapsed: persisted?.isVerticalTabCollapsed ?? false,
          readerStores,
        } as LayoutStore;
      },
    },
  ),
);
