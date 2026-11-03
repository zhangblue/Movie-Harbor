import { vi } from "vitest";

// 配置上传模拟是否手动完成，在安装测试桩时使用。
type UploadXhrOptions = { manual?: boolean };

// 定义测试对单次上传进度和结果的控制接口。
export type UploadController = {
  progress: (loaded: number, total: number) => void;
  indeterminateProgress: () => void;
  finishUpload: () => void;
  respondFromFetch: () => Promise<void>;
  networkError: () => void;
};

// 模拟上传请求及事件，在组件测试替代浏览器 XMLHttpRequest 时使用。
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

  // 记录请求方法和地址，在客户端初始化上传请求时调用。
  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  // 记录请求头，在模拟上传请求设置头部时调用。
  setRequestHeader(name: string, value: string): void {
    this.headers.set(name, value);
  }

  // 返回模拟响应头，在上传客户端解析响应时调用。
  getAllResponseHeaders(): string {
    return this.responseHeaders;
  }

  // 登记上传并按配置触发完成，在客户端发送上传请求时调用。
  send(body: Document | XMLHttpRequestBodyInit | null): void {
    this.body = body;
    const controller = createController(this);
    controllers.push(controller);
    if (!manual) {
      controller.finishUpload();
      void controller.respondFromFetch().catch(controller.networkError);
    }
  }

  // 保存模拟响应状态和内容，在请求完成时调用。
  setResponse(response: Response, body: string): void {
    this.status = response.status;
    this.statusText = response.statusText;
    this.responseText = body;
    this.responseHeaders = [...response.headers].map(([name, value]) => `${name}: ${value}`).join("\r\n");
  }
}

let manual = false;
let controllers: UploadController[] = [];

// 描述模拟上传进度事件的数据，在构造事件时使用。
type UploadEventDetail = {
  lengthComputable?: boolean;
  loaded?: number;
  total?: number;
};

// 构造带进度字段的上传事件，在测试驱动进度时调用。
function uploadEvent(type: string, detail: UploadEventDetail = {}): Event {
  return Object.assign(new Event(type), detail);
}

// 创建单次上传的事件控制器，在模拟请求发送时调用。
function createController(xhr: UploadXhr): UploadController {
  return {
    // 触发可计算进度事件，在测试推进上传字节时调用。
    progress(loaded, total) {
      xhr.upload.dispatchEvent(uploadEvent("progress", { lengthComputable: true, loaded, total }));
    },
    // 触发总量未知的进度事件，在测试不确定进度时调用。
    indeterminateProgress() {
      xhr.upload.dispatchEvent(uploadEvent("progress", { lengthComputable: false, loaded: 0, total: 0 }));
    },
    // 触发请求体上传完成事件，在测试进入服务端处理阶段时调用。
    finishUpload() {
      xhr.upload.dispatchEvent(new Event("load"));
    },
    // 通过模拟服务完成请求并分发响应，在测试结束上传时调用。
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
    // 分发网络错误事件，在模拟上传失败时调用。
    networkError() {
      xhr.dispatchEvent(new Event("error"));
    },
  };
}

// 安装并重置上传模拟，在需要控制上传事件的测试开始时调用。
export function installUploadXhr(options: UploadXhrOptions = {}) {
  manual = options.manual ?? false;
  controllers = [];
  vi.stubGlobal("XMLHttpRequest", UploadXhr);
  return {
    // 返回待处理上传数，在测试检查并发请求时调用。
    pendingCount(): number {
      return controllers.length;
    },
    // 取出下一次待处理上传，在测试驱动上传事件时调用。
    next(): UploadController {
      const controller = controllers.shift();
      if (!controller) throw new Error("No pending upload XMLHttpRequest");
      return controller;
    },
  };
}
