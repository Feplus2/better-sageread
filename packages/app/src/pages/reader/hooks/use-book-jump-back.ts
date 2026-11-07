import type { FoliateView } from "@/types/view";
import { useCallback, useEffect, useRef, useState } from "react";
import { consumeProgrammaticNavigation, hasPendingProgrammaticNavigation } from "./navigation-tracker";

interface BookLocation {
  cfi?: string;
  fraction?: number;
  sectionFraction?: number;
  size?: number;
}

const DWELL_DISTANCE_PX = 140;

export function useBookJumpBack(view: FoliateView | null) {
  const [show, setShow] = useState(false);
  const baselineRef = useRef<BookLocation | null>(null);

  useEffect(() => {
    if (!view) {
      setShow(false);
      return;
    }
    const bookId = view.id.startsWith("foliate-view-") ? view.id.slice("foliate-view-".length) : "";
    baselineRef.current = null;
    setShow(view.history.canGoBack && !hasPendingProgrammaticNavigation(bookId));

    const handleIndexChange = () => {
      baselineRef.current = null;
      if (consumeProgrammaticNavigation(bookId)) {
        setShow(false);
        return;
      }
      setShow(view.history.canGoBack);
    };
    const handleRelocate = (event: Event) => {
      const location = (event as CustomEvent<BookLocation>).detail ?? {};
      const { cfi, sectionFraction, size } = location;
      if (!cfi && sectionFraction === undefined) return;
      const baseline = baselineRef.current;
      if (baseline === null) {
        baselineRef.current = location;
        return;
      }

      if (
        view.renderer.scrolled &&
        sectionFraction !== undefined &&
        baseline.sectionFraction !== undefined &&
        view.renderer.viewSize > 0
      ) {
        if (Math.abs(sectionFraction - baseline.sectionFraction) * view.renderer.viewSize >= DWELL_DISTANCE_PX) {
          setShow(false);
        }
        return;
      }
      if (size !== undefined && size > 0 && sectionFraction !== undefined && baseline.sectionFraction !== undefined) {
        if (Math.abs(sectionFraction - baseline.sectionFraction) / size >= 1) setShow(false);
        return;
      }
      if (location.cfi !== baseline.cfi || location.fraction !== baseline.fraction) setShow(false);
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
