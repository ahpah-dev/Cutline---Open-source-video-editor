import type { CodexEvent, CodexStatus, CodexToolRequest, CodexToolResult } from "./editor/codexTypes";

declare global {
  interface Window {
    cutlineDesktop?: {
      isDesktop: true;
      platform: string;
      version: () => Promise<string>;
      codexConnect: (tools: unknown[]) => Promise<CodexStatus>;
      codexStatus: () => Promise<CodexStatus>;
      codexLogin: () => Promise<void>;
      codexSend: (prompt: string, projectId: string, model?: string) => Promise<{ threadId: string }>;
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
      confirmNewProject: () => Promise<boolean>;
      onBeforeClose: (callback: () => Promise<void>) => () => void;
    };
  }
}
