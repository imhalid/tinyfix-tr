// onnxruntime-node 1.20.1 points "types" at a file it doesn't ship. Only what the bench uses is declared here.
declare module "onnxruntime-node" {
  export class Tensor {
    constructor(type: "int64", data: BigInt64Array, dims: readonly number[]);
    constructor(type: "float32", data: Float32Array, dims: readonly number[]);
    readonly data: Float32Array | BigInt64Array;
  }
  export class InferenceSession {
    static create(path: string): Promise<InferenceSession>;
    readonly inputNames: readonly string[];
    run(feeds: Record<string, Tensor>): Promise<Record<string, Tensor>>;
  }
}
