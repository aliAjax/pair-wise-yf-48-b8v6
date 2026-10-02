// 浏览器 API polyfill，需在导入被测模块前执行
const store = new Map<string, string>();
const session = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k)
};
(globalThis as any).sessionStorage = {
  getItem: (k: string) => (session.has(k) ? session.get(k)! : null),
  setItem: (k: string, v: string) => void session.set(k, v),
  removeItem: (k: string) => void session.delete(k)
};
(globalThis as any).BroadcastChannel = class {
  static channels: any[] = [];
  onmessage: ((ev: any) => void) | null = null;
  constructor(public name: string) { (globalThis as any).__channels.push(this); }
  postMessage(data: any) { for (const ch of (globalThis as any).__channels) if (ch !== this && ch.onmessage) ch.onmessage({ data }); }
  close() {}
};
(globalThis as any).__channels = [];
(globalThis as any).navigator = { onLine: true };
(globalThis as any).window = { addEventListener: () => {} };
