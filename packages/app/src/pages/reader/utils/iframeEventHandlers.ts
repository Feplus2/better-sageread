import {
  DISABLE_DOUBLE_CLICK_ON_MOBILE,
  DOUBLE_CLICK_INTERVAL_THRESHOLD_MS,
  LONG_HOLD_THRESHOLD,
} from "@/services/constants";
import { eventDispatcher } from "@/utils/event";
import { getOSPlatform } from "@/utils/misc";

const doubleClickEnabled = !DISABLE_DOUBLE_CLICK_ON_MOBILE || !["android", "ios"].includes(getOSPlatform());

let lastClickTime = 0;
let longHoldTimeout: ReturnType<typeof setTimeout> | null = null;

/** 移动端长按切句（M3）：长按 = 合成 contextmenu，复用桌面右键"选中整句 + 标注弹窗"整条路径。
 *  触发后置 suppress 标记，吃掉松手后浏览器补发的 click（否则单击弹栏会紧跟着把菜单弹出来） */
let mobileLpSuppressClick = false;
const MOBILE_LP_MS = 500;
const MOBILE_LP_MOVE_TOLERANCE = 12;

export const attachMobileLongPress = (doc: Document, win: Window) => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let startX = 0;
  let startY = 0;
  let startTarget: EventTarget | null = null;

  const cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  doc.addEventListener(
    "touchstart",
    (e) => {
      const t = e.touches[0];
      if (!t) return;
      startX = t.clientX;
      startY = t.clientY;
      startTarget = e.target;
      timer = setTimeout(() => {
        timer = null;
        mobileLpSuppressClick = true;
        const ev = new win.MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: startX,
          clientY: startY,
          view: win,
        });
        const target = startTarget as Element | null;
        if (target?.dispatchEvent) target.dispatchEvent(ev);
        else doc.dispatchEvent(ev);
      }, MOBILE_LP_MS);
    },
    { passive: true },
  );

  doc.addEventListener(
    "touchmove",
    (e) => {
      const t = e.touches[0];
      if (!t) return;
      if (
        Math.abs(t.clientX - startX) > MOBILE_LP_MOVE_TOLERANCE ||
        Math.abs(t.clientY - startY) > MOBILE_LP_MOVE_TOLERANCE
      ) {
        cancel();
      }
    },
    { passive: true },
  );
  doc.addEventListener("touchend", cancel, { passive: true });
  doc.addEventListener("touchcancel", cancel, { passive: true });
};

export const handleKeydown = (bookId: string, event: KeyboardEvent) => {
  if (["Backspace", "ArrowDown", "ArrowUp"].includes(event.key)) {
    event.preventDefault();
  }
  window.postMessage(
    {
      type: "iframe-keydown",
      bookId,
      key: event.key,
      code: event.code,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
    },
    "*",
  );
};

export const handleMousedown = (bookId: string, event: MouseEvent) => {
  longHoldTimeout = setTimeout(() => {
    longHoldTimeout = null;
  }, LONG_HOLD_THRESHOLD);

  window.postMessage(
    {
      type: "iframe-mousedown",
      bookId,
      button: event.button,
      screenX: event.screenX,
      screenY: event.screenY,
      clientX: event.clientX,
      clientY: event.clientY,
      offsetX: event.offsetX,
      offsetY: event.offsetY,
    },
    "*",
  );
};

export const handleMouseup = (bookId: string, event: MouseEvent) => {
  // we will handle mouse back and forward buttons ourselves
  if ([3, 4].includes(event.button)) {
    event.preventDefault();
  }

  window.postMessage(
    {
      type: "iframe-mouseup",
      bookId,
      button: event.button,
      screenX: event.screenX,
      screenY: event.screenY,
      clientX: event.clientX,
      clientY: event.clientY,
      offsetX: event.offsetX,
      offsetY: event.offsetY,
    },
    "*",
  );
};

export const handleMouseMove = (bookId: string, event: MouseEvent) => {
  window.postMessage(
    {
      type: "iframe-mousemove",
      bookId,
      screenX: event.screenX,
      screenY: event.screenY,
      clientX: event.clientX,
      clientY: event.clientY,
      offsetX: event.offsetX,
      offsetY: event.offsetY,
    },
    "*",
  );
};

export const handleWheel = (bookId: string, event: WheelEvent) => {
  window.postMessage(
    {
      type: "iframe-wheel",
      bookId,
      deltaMode: event.deltaMode,
      deltaX: event.deltaX,
      deltaY: event.deltaY,
      deltaZ: event.deltaZ,
      screenX: event.screenX,
      screenY: event.screenY,
      clientX: event.clientX,
      clientY: event.clientY,
      offsetX: event.offsetX,
      offsetY: event.offsetY,
    },
    "*",
  );
};

/** D3+T4：iframe 内图片交互转发（foliate 书籍内容在 iframe 里，DOM 事件不冒泡到宿主）
 * 右键/点击命中 img 时 preventDefault 并 postMessage 给宿主层的主题菜单/大图预览 */
export const handleImageContextMenu = (bookId: string, event: MouseEvent) => {
  const img = (event.target as Element | null)?.closest?.("img");
  if (!img) return;
  event.preventDefault();
  event.stopPropagation();
  window.postMessage(
    {
      type: "iframe-image-menu",
      bookId,
      src: img.src,
      alt: img.getAttribute("alt") ?? "",
      clientX: event.clientX,
      clientY: event.clientY,
    },
    "*",
  );
};

export const handleImageClick = (bookId: string, event: MouseEvent) => {
  const img = (event.target as Element | null)?.closest?.("img");
  if (!img) return;
  event.preventDefault();
  event.stopPropagation();
  window.postMessage(
    {
      type: "iframe-image-preview",
      bookId,
      src: img.src,
      alt: img.getAttribute("alt") ?? "",
    },
    "*",
  );
};

export const handleClick = (bookId: string, event: MouseEvent) => {
  // 移动端长按切句刚触发过：本次 click 是浏览器松手补发，吃掉（M3 手势防串扰）
  if (mobileLpSuppressClick) {
    mobileLpSuppressClick = false;
    event.preventDefault();
    return;
  }
  const now = Date.now();

  if (doubleClickEnabled && now - lastClickTime < DOUBLE_CLICK_INTERVAL_THRESHOLD_MS) {
    lastClickTime = now;
    window.postMessage(
      {
        type: "iframe-double-click",
        bookId,
        screenX: event.screenX,
        screenY: event.screenY,
        clientX: event.clientX,
        clientY: event.clientY,
        offsetX: event.offsetX,
        offsetY: event.offsetY,
      },
      "*",
    );
    return;
  }

  lastClickTime = now;

  const postSingleClick = () => {
    let element: HTMLElement | null = event.target as HTMLElement;
    while (element) {
      if (["sup", "a", "audio", "video"].includes(element.tagName.toLowerCase())) {
        return;
      }
      if (element.classList.contains("js_readerFooterNote") || element.classList.contains("zhangyue-footnote")) {
        eventDispatcher.dispatch("footnote-popup", {
          bookId,
          element,
          footnote: element.getAttribute("data-wr-footernote") || element.getAttribute("zy-footnote") || "",
        });
        return;
      }
      element = element.parentElement;
    }

    // if long hold is detected, we don't want to send single click event
    if (!longHoldTimeout) {
      return;
    }

    window.postMessage(
      {
        type: "iframe-single-click",
        bookId,
        screenX: event.screenX,
        screenY: event.screenY,
        clientX: event.clientX,
        clientY: event.clientY,
        offsetX: event.offsetX,
        offsetY: event.offsetY,
      },
      "*",
    );
  };
  if (doubleClickEnabled) {
    setTimeout(() => {
      if (Date.now() - lastClickTime >= DOUBLE_CLICK_INTERVAL_THRESHOLD_MS) {
        postSingleClick();
      }
    }, DOUBLE_CLICK_INTERVAL_THRESHOLD_MS);
  } else {
    postSingleClick();
  }
};

const handleTouchEv = (bookId: string, event: TouchEvent, type: string) => {
  const touch = event.targetTouches[0];
  const touches = [];
  if (touch) {
    touches.push({
      clientX: touch.clientX,
      clientY: touch.clientY,
      screenX: touch.screenX,
      screenY: touch.screenY,
    });
  }
  window.postMessage(
    {
      type: type,
      bookId,
      targetTouches: touches,
    },
    "*",
  );
};

export const handleTouchStart = (bookId: string, event: TouchEvent) => {
  handleTouchEv(bookId, event, "iframe-touchstart");
};

export const handleTouchMove = (bookId: string, event: TouchEvent) => {
  handleTouchEv(bookId, event, "iframe-touchmove");
};

export const handleTouchEnd = (bookId: string, event: TouchEvent) => {
  handleTouchEv(bookId, event, "iframe-touchend");
};
