/** The slice of the Bun runtime API the entrypoint uses (avoids @types/bun, whose `fetch` type breaks shared packages). */
declare const Bun: {
  serve(options: {
    port: number;
    fetch: (request: Request) => Response | Promise<Response>;
    maxRequestBodySize?: number;
  }): {
    stop(closeActiveConnections?: boolean): Promise<void>;
  };
};

/** Text files bundled as strings (`import x from "./file.md" with { type: "text" }`). */
declare module "*.md" {
  const text: string;
  export default text;
}
