import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

const port = Number(process.env.PORT || 4173);
const root = process.cwd();
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

createServer((request, response) => {
  const requestedPath = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  const relativePath = normalize(requestedPath)
    .replace(/^[/\\]+/, "")
    .replace(/^(\.\.(\/|\\|$))+/, "");
  let filePath = join(root, relativePath || "index.html");
  if (!filePath.startsWith(root) || !existsSync(filePath) || statSync(filePath).isDirectory()) {
    filePath = join(root, "index.html");
  }
  response.setHeader("Content-Type", contentTypes[extname(filePath)] || "application/octet-stream");
  response.setHeader("Cache-Control", "no-store");
  createReadStream(filePath).pipe(response);
}).listen(port, "127.0.0.1", () => {
  console.log(`Member Download Website: http://localhost:${port}`);
});
