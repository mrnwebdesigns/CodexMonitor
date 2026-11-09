export type BrowserSelection = {
  threadId: string;
  sessionId?: string;
  url: string;
  title: string;
  selector: string;
  text: string;
  tag: string;
  rect: { x: number; y: number; width: number; height: number };
};

export type BrowserPageEvent = { threadId: string; sessionId?: string; url: string; title?: string; loading: boolean; error?: string | null };
export type BrowserBounds = { x: number; y: number; width: number; height: number };
export type BrowserDeviceViewport = { width: number; height: number; scale: number };
export type BrowserAction = "back" | "forward" | "reload" | "stop" | "annotate" | "browse" | "devtools";
export type BrowserAnnotation = BrowserSelection & {
  id: string;
  comment: string;
  screenshot: string | null;
};
