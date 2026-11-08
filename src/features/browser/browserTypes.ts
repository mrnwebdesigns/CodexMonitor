export type BrowserSelection = {
  url: string;
  title: string;
  selector: string;
  text: string;
  tag: string;
  rect: { x: number; y: number; width: number; height: number };
};

export type BrowserPageEvent = { url: string; title?: string; loading: boolean };
export type BrowserBounds = { x: number; y: number; width: number; height: number };
export type BrowserAction = "back" | "forward" | "reload" | "stop" | "annotate" | "browse";
export type BrowserAnnotation = BrowserSelection & {
  id: string;
  comment: string;
  screenshot: string | null;
};
