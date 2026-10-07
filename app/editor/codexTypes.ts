export type CodexModel = { id:string; name:string; isDefault:boolean; reasoningEfforts?:{id:string;description:string}[]; defaultEffort?:string|null; inputModalities?:string[] };
export type CodexImage = {name:string;imageUrl:string};
export type CodexStatus = {
  connected: boolean; needsLogin: boolean; busy: boolean;
  account?: { type: string; email?: string; planType?: string } | null;
  models: CodexModel[];
};
export type CodexEvent =
  | ({ type: "status" } & CodexStatus)
  | { type: "setup" | "error"; message: string }
  | { type: "message"; id: string; text?: string; delta?: string }
  | { type: "tool"; name: string; status: "working" | "done" | "error"; message?: string };
export type CodexToolRequest = { id: string; name: string; args: unknown; projectId: string };
export type CodexToolResult = { success: boolean; contentItems: ({ type: "inputText"; text: string } | { type: "inputImage"; imageUrl: string })[] };
