import { defineConfig } from "cf/config";

export default defineConfig({
  worker: {
    "name": "openza-website",
    "compatibilityDate": "2026-10-06",
    "domains": ["openza.org"],
    "assets": { "notFoundHandling": "404-page" },
    "observability": {
      "enabled": false
    }
  }
});
