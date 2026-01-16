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

function main() {
	startServer();
}

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

function safeDecodeURIComponent(value) {
	try {
		return decodeURIComponent(value);
	} catch (error) {
		return null;
	}
}

function escapeHtml(value) {
	return String(value)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

main();
