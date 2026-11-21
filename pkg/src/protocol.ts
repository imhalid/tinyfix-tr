import type { BinaryData, CheckOptions, Fix, Flag, LoadProgress, Mode, RawData } from "./types.ts";

export type WorkerRequest =
  | {
      type: "load";
      id: number;
      baseUrl?: string;
      data?: RawData | BinaryData;
      mode: Mode;
      minCount?: number;
      minPair?: number;
      ignored?: string[];
      context?: boolean;
      wasmPaths?: string;
    }
  | {
      type: "check";
      id: number;
      text: string;
      options?: CheckOptions;
    }
  | {
      type: "inspect";
      id: number;
      text: string;
      options?: CheckOptions;
    }
  | {
      type: "ignore";
      word: string;
    }
  | {
      type: "unignore";
      word: string;
    }
  | {
      type: "setMode";
      mode: Mode;
    }
  | {
      type: "dispose";
      id: number;
    };

export type WorkerResponse =
  | {
      type: "progress";
      id: number;
      progress: LoadProgress;
    }
  | {
      type: "warning";
      id: number;
      message: string;
    }
  | {
      type: "loaded";
      id: number;
      hasContext: boolean;
    }
  | {
      type: "result";
      id: number;
      fixes: Fix[];
    }
  | {
      type: "inspectResult";
      id: number;
      fixes: Fix[];
      flags: Flag[];
    }
  | {
      type: "disposed";
      id: number;
    }
  | {
      type: "error";
      id: number;
      message: string;
    };
