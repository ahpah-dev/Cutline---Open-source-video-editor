import type { AIConnection, CustomAPISettings, CodexEvent, CodexImage, CodexStatus, CodexToolRequest, CodexToolResult } from "./editor/codexTypes";

declare global {
  interface Window {
    cutlineDesktop?: {
      isDesktop: true;
      platform: string;
      version: () => Promise<string>;
      codexConnect: (tools: unknown[], connection?:AIConnection) => Promise<CodexStatus>;
      apiSettings: () => Promise<CustomAPISettings>;
      forgetAPI: () => Promise<CustomAPISettings>;
      codexStatus: () => Promise<CodexStatus>;
      codexLogin: () => Promise<void>;
      codexSend: (prompt: string, projectId: string, model?: string, effort?:string, images?:CodexImage[]) => Promise<{ threadId: string }>;
      codexStop: () => Promise<void>;
      codexReset: () => Promise<void>;
      codexDisconnect: () => Promise<void>;
      codexToolActive: (id: string) => Promise<boolean>;
      onCodexEvent: (callback: (event: CodexEvent) => void) => () => void;
      onCodexTool: (callback: (request: CodexToolRequest) => Promise<CodexToolResult>) => () => void;
      listInstalledFonts: (refresh?: boolean) => Promise<string[]>;
      minimize: () => void;
      maximize: () => void;
      toggleFullscreen: () => void;
      isFullscreen: () => Promise<boolean>;
      onFullscreenChange: (callback: (fullscreen: boolean) => void) => () => void;
      close: () => void;
      isMaximized: () => Promise<boolean>;
      onMaximizedChange: (callback: (maximized: boolean) => void) => () => void;
      saveFile: (suggestedName: string, bytes: ArrayBuffer) => Promise<{ canceled: boolean; filePath?: string }>;
      beginVideoExport: (suggestedName: string) => Promise<{ canceled: boolean; token?: string; filePath?: string }>;
      writeVideoExport: (token: string, position: number, bytes: ArrayBuffer) => Promise<void>;
      finishVideoExport: (token: string, size: number) => Promise<{ filePath: string; size: number }>;
      cancelVideoExport: (token: string) => Promise<void>;
      confirmNewProject: () => Promise<boolean>;
      onBeforeClose: (callback: () => Promise<void>) => () => void;
    };
  }
}
