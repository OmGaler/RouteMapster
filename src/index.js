/**
 * Serves the static RouteMapster application during local development.
 *
 * This entry point sits outside the browser bundle and exposes repository
 * files directly from the project root so engineers can inspect generated
 * artifacts without a separate build step. It depends only on Node's
 * standard `http`, `fs`, and `path` modules.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 3000);

const MIME_TYPES = {
	'.html': 'text/html; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.geojson': 'application/geo+json; charset=utf-8',
	'.xml': 'application/xml; charset=utf-8',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.svg': 'image/svg+xml',
	'.ico': 'image/x-icon'
};

/**
 * Starts the development server.
 *
 * Returns: `void`.
 * Side effects: Opens an HTTP listener on `PORT`.
 */
function main() {
	startServer();
}

/**
 * Creates and starts the HTTP server used for local previews.
 *
 * Returns: `void`.
 * Side effects: Reads from the filesystem, writes HTTP responses, and logs
 * the listening address to stdout.
 */
function startServer() {
	const server = http.createServer((req, res) => {
		const requestUrl = new URL(req.url, `http://${req.headers.host}`);
		const pathname = safeDecodeURIComponent(requestUrl.pathname);
		if (pathname === null) {
			res.writeHead(400);
			res.end('Bad request');
			return;
		}

		const filePath = path.resolve(path.join(ROOT_DIR, pathname));
		if (!filePath.startsWith(ROOT_DIR)) {
			res.writeHead(403);
			res.end('Forbidden');
			return;
		}

		fs.stat(filePath, (error, stats) => {
			if (error) {
				res.writeHead(404);
				res.end('Not found');
				return;
			}

			if (stats.isDirectory()) {
				if (!pathname.endsWith('/')) {
					res.writeHead(301, { Location: `${pathname}/` });
					res.end();
					return;
				}
				const indexPath = path.join(filePath, 'index.html');
				if (fs.existsSync(indexPath)) {
					serveFile(indexPath, res);
					return;
				}
				serveDirectoryListing(filePath, pathname, res);
				return;
			}

			serveFile(filePath, res);
		});
	});

	server.listen(PORT, () => {
		console.log(`RouteMapster server running at http://localhost:${PORT}`);
	});
}

/**
 * Streams a single file to the HTTP response.
 *
 * @param {string} filePath Absolute path to the file being served.
 * @param {import('http').ServerResponse} res Response object for the current request.
 * @returns {void}
 * Side effects: Opens a read stream and writes bytes to the client.
 */
function serveFile(filePath, res) {
	const ext = path.extname(filePath).toLowerCase();
	const mimeType = MIME_TYPES[ext] || 'application/octet-stream';
	const stream = fs.createReadStream(filePath);
	res.writeHead(200, { 'Content-Type': mimeType });
	stream.pipe(res);
	stream.on('error', () => {
		res.writeHead(500);
		res.end('Server error');
	});
}

/**
 * Renders a simple HTML directory index when no `index.html` exists.
 *
 * @param {string} dirPath Absolute directory path on disk.
 * @param {string} urlPath Request pathname used to build child links.
 * @param {import('http').ServerResponse} res Response object for the current request.
 * @returns {void}
 * Side effects: Reads directory entries synchronously and writes an HTML page.
 */
function serveDirectoryListing(dirPath, urlPath, res) {
	const entries = fs.readdirSync(dirPath, { withFileTypes: true });
	const items = entries.map((entry) => {
		const name = entry.name + (entry.isDirectory() ? '/' : '');
		const href = path.posix.join(urlPath, name);
		return `<li><a href="${href}">${escapeHtml(name)}</a></li>`;
	}).join('');

	const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Index of ${escapeHtml(urlPath)}</title>
</head>
<body>
  <h1>Index of ${escapeHtml(urlPath)}</h1>
  <ul>${items}</ul>
</body>
</html>`;

	res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
	res.end(html);
}

/**
 * Decodes a URL component without throwing on malformed input.
 *
 * @param {string} value Raw pathname segment from the request URL.
 * @returns {string|null} Decoded text, or `null` when the request is invalid.
 */
function safeDecodeURIComponent(value) {
	try {
		return decodeURIComponent(value);
	} catch (error) {
		return null;
	}
}

/**
 * Escapes untrusted text before inserting it into HTML.
 *
 * @param {unknown} value Text-like value to escape.
 * @returns {string} HTML-safe string content.
 */
function escapeHtml(value) {
	return String(value)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

main();
