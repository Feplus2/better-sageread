import type { FoliateView } from "@/types/view";
import { useCallback, useEffect, useRef, useState } from "react";

export function useBookJumpBack(view: FoliateView | null) {
  const [show, setShow] = useState(false);
  const baselineRef = useRef<string | null>(null);

  useEffect(() => {
    if (!view) {
      setShow(false);
      return;
    }
    baselineRef.current = null;
    setShow(view.history.canGoBack);

    const handleIndexChange = () => {
      baselineRef.current = null;
      setShow(view.history.canGoBack);
    };
    const handleRelocate = (event: Event) => {
      const { cfi, fraction } = (event as CustomEvent<{ cfi?: string; fraction?: number }>).detail ?? {};
      if (!cfi && fraction === undefined) return;
      const location = JSON.stringify([cfi ?? null, fraction ?? null]);
      if (baselineRef.current === null) baselineRef.current = location;
      else if (baselineRef.current !== location) setShow(false);
    };

    view.history.addEventListener("index-change", handleIndexChange);
    view.addEventListener("relocate", handleRelocate);
    return () => {
      view.history.removeEventListener("index-change", handleIndexChange);
      view.removeEventListener("relocate", handleRelocate);
    };
  }, [view]);

  const jumpBack = useCallback(() => {
    if (!view?.history.canGoBack) {
      setShow(false);
      return;
    }
    baselineRef.current = null;
    view.history.back();
  }, [view]);

  return { show, jumpBack };
}
