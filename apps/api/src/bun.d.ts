/** The slice of the Bun runtime API the entrypoint uses (avoids @types/bun, whose `fetch` type breaks shared packages). */
declare const Bun: {
  serve(options: {
    port: number;
    hostname?: string;
    fetch: (request: Request) => Response | Promise<Response>;
    maxRequestBodySize?: number;
  }): {
    /** The bound port (port 0 picks a free one). */
    readonly port: number;
    stop(closeActiveConnections?: boolean): Promise<void>;
  };
};
