import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

export function useCtrlWheelZoom<T extends HTMLElement>(
  ref: RefObject<T | null>,
  onZoom: (factor: number) => void,
  enabled = true,
) {
  const onZoomRef = useRef(onZoom);
  useLayoutEffect(() => { onZoomRef.current = onZoom; });

  useEffect(() => {
    const element = ref.current;
    if (!enabled || !element) return;
    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      // React's wheel listener is passive; a native listener prevents WebView
      // from zooming the entire application instead of the hovered pane.
      event.preventDefault();
      event.stopPropagation();
      const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1);
      if (pixels) onZoomRef.current(Math.exp(-Math.max(-240, Math.min(240, pixels)) * 0.0015));
    };
    element.addEventListener("wheel", handleWheel, { passive: false });
    return () => element.removeEventListener("wheel", handleWheel);
  }, [ref, enabled]);
}
