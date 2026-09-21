import { vi } from "vitest";

type UploadXhrOptions = { manual?: boolean };

export type UploadController = {
  progress: (loaded: number, total: number) => void;
  indeterminateProgress: () => void;
  finishUpload: () => void;
  respondFromFetch: () => Promise<void>;
  networkError: () => void;
};

class UploadXhr extends EventTarget {
  readonly upload = new EventTarget();
  readonly headers = new Headers();
  method = "GET";
  url = "";
  body: Document | XMLHttpRequestBodyInit | null = null;
  status = 0;
  statusText = "";
  responseText = "";
  private responseHeaders = "";

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string): void {
    this.headers.set(name, value);
  }

  getAllResponseHeaders(): string {
    return this.responseHeaders;
  }

  send(body: Document | XMLHttpRequestBodyInit | null): void {
    this.body = body;
    const controller = createController(this);
    controllers.push(controller);
    if (!manual) {
      controller.finishUpload();
      void controller.respondFromFetch().catch(controller.networkError);
    }
  }

  setResponse(response: Response, body: string): void {
    this.status = response.status;
    this.statusText = response.statusText;
    this.responseText = body;
    this.responseHeaders = [...response.headers].map(([name, value]) => `${name}: ${value}`).join("\r\n");
  }
}

let manual = false;
let controllers: UploadController[] = [];

function uploadEvent(type: string, detail: Record<string, unknown> = {}): Event {
  return Object.assign(new Event(type), detail);
}

function createController(xhr: UploadXhr): UploadController {
  return {
    progress(loaded, total) {
      xhr.upload.dispatchEvent(uploadEvent("progress", { lengthComputable: true, loaded, total }));
    },
    indeterminateProgress() {
      xhr.upload.dispatchEvent(uploadEvent("progress", { lengthComputable: false, loaded: 0, total: 0 }));
    },
    finishUpload() {
      xhr.upload.dispatchEvent(new Event("load"));
    },
    async respondFromFetch() {
      const response = await fetch(xhr.url, {
        method: xhr.method,
        headers: xhr.headers,
        credentials: "same-origin",
        body: xhr.body as BodyInit | null,
      });
      xhr.setResponse(response, await response.text());
      xhr.dispatchEvent(new Event("load"));
    },
    networkError() {
      xhr.dispatchEvent(new Event("error"));
    },
  };
}

export function installUploadXhr(options: UploadXhrOptions = {}) {
  manual = options.manual ?? false;
  controllers = [];
  vi.stubGlobal("XMLHttpRequest", UploadXhr);
  return {
    next(): UploadController {
      const controller = controllers.shift();
      if (!controller) throw new Error("No pending upload XMLHttpRequest");
      return controller;
    },
  };
}
