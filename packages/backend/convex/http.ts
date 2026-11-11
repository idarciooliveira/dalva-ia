import { httpRouter } from "convex/server";

import { API_METHODS, financeApi } from "./api/v1/router";
import { auth } from "./auth";

const http = httpRouter();

auth.addHttpRoutes(http);

// Finance API v1: one handler; routes are matched against the contract's route map.
for (const method of API_METHODS) {
  http.route({ pathPrefix: "/api/v1/", method, handler: financeApi });
}

export default http;
