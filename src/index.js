const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const PORT = Number(process.env.PORT || 3000);

const ROUTE_GEOMETRY_PREFIX = 'Route_Geometry_';
const ROUTE_GEOMETRY_MAX_AGE_DAYS = 14;
const DEFAULT_ROUTE_GEOMETRY_BASES = ['https://bus.data.tfl.gov.uk/'];
const ROUTE_GEOMETRY_BASE_URLS = (process.env.ROUTE_GEOMETRY_BASE_URLS || '')
	.split(',')
	.map((entry) => entry.trim())
	.filter(Boolean);

if (ROUTE_GEOMETRY_BASE_URLS.length === 0) {
	ROUTE_GEOMETRY_BASE_URLS.push(...DEFAULT_ROUTE_GEOMETRY_BASES);
}

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

async function main() {
	await refreshRouteGeometryIfStale();
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

async function refreshRouteGeometryIfStale() {
	const local = findLatestLocalRouteGeometry(DATA_DIR);
	const stale = !local || isOlderThanDays(local.date, ROUTE_GEOMETRY_MAX_AGE_DAYS);

	if (!stale) {
		console.log(`Route geometry ${local.dateToken} is fresh.`);
		return;
	}

	console.log('Route geometry is stale or missing. Checking TfL...');
	const remote = await fetchLatestRemoteRouteGeometry();
	if (!remote) {
		console.warn('Unable to find remote route geometry.');
		return;
	}

	if (local && remote.dateToken <= local.dateToken) {
		console.log('Local route geometry is already the latest.');
		return;
	}

	const zipEntry = remote.isZip ? remote : deriveZipEntry(remote);
	if (!zipEntry) {
		console.warn('Latest geometry is not available as a zip.');
		return;
	}

	try {
		await downloadAndExtract(zipEntry);
	} catch (error) {
		console.warn('Failed to refresh route geometry:', error.message);
	}
}

function findLatestLocalRouteGeometry(dataDir) {
	if (!fs.existsSync(dataDir)) {
		return null;
	}
	const entries = fs.readdirSync(dataDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => parseRouteGeometryFolder(entry.name))
		.filter(Boolean)
		.sort((a, b) => b.dateToken.localeCompare(a.dateToken));

	return entries[0] || null;
}

function parseRouteGeometryFolder(name) {
	const match = name.match(/Route_Geometry_(\d{8})/);
	if (!match) {
		return null;
	}
	const dateToken = match[1];
	const date = parseDateToken(dateToken);
	if (!date) {
		return null;
	}
	return { name, dateToken, date };
}

function parseDateToken(dateToken) {
	if (!/^\d{8}$/.test(dateToken)) {
		return null;
	}
	const year = Number(dateToken.slice(0, 4));
	const month = Number(dateToken.slice(4, 6));
	const day = Number(dateToken.slice(6, 8));
	const date = new Date(Date.UTC(year, month - 1, day));
	return Number.isNaN(date.getTime()) ? null : date;
}

function isOlderThanDays(date, days) {
	if (!date) {
		return true;
	}
	const ageMs = Date.now() - date.getTime();
	return ageMs > days * 24 * 60 * 60 * 1000;
}

async function fetchLatestRemoteRouteGeometry() {
	for (const baseUrl of ROUTE_GEOMETRY_BASE_URLS) {
		const html = await fetchText(baseUrl);
		if (!html) {
			continue;
		}
		const entries = parseRouteGeometryEntries(html, baseUrl);
		if (entries.length === 0) {
			continue;
		}
		entries.sort((a, b) => b.dateToken.localeCompare(a.dateToken));
		const newestToken = entries[0].dateToken;
		const sameDate = entries.filter((entry) => entry.dateToken === newestToken);
		const preferred = sameDate.find((entry) => entry.isZip) || sameDate[0];
		return preferred;
	}
	return null;
}

function parseRouteGeometryEntries(html, baseUrl) {
	const entries = [];
	const hrefRegex = /href=["']([^"']+)["']/gi;
	let match = null;
	while ((match = hrefRegex.exec(html)) !== null) {
		const href = match[1];
		if (!href.includes(ROUTE_GEOMETRY_PREFIX)) {
			continue;
		}
		const dateMatch = href.match(/Route_Geometry_(\d{8})/);
		if (!dateMatch) {
			continue;
		}
		const dateToken = dateMatch[1];
		const url = new URL(href, baseUrl).toString();
		const isZip = href.toLowerCase().endsWith('.zip');
		entries.push({ url, dateToken, isZip });
	}
	return entries;
}

function deriveZipEntry(entry) {
	if (!entry || !entry.url) {
		return null;
	}
	const url = entry.url.replace(/\/$/, '');
	return { ...entry, url: `${url}.zip`, isZip: true };
}

async function downloadAndExtract(entry) {
	fs.mkdirSync(DATA_DIR, { recursive: true });
	const url = new URL(entry.url);
	const zipName = path.basename(url.pathname) || `${ROUTE_GEOMETRY_PREFIX}${entry.dateToken}.zip`;
	const zipPath = path.join(DATA_DIR, zipName);
	const targetDir = path.join(DATA_DIR, `${ROUTE_GEOMETRY_PREFIX}${entry.dateToken}`);

	if (fs.existsSync(targetDir)) {
		console.log(`Route geometry ${entry.dateToken} already exists.`);
		return;
	}

	console.log(`Downloading ${entry.url}`);
	await downloadFile(entry.url, zipPath);
	console.log('Extracting route geometry...');
	await extractZip(zipPath, DATA_DIR);

	if (fs.existsSync(targetDir)) {
		console.log(`Route geometry extracted to ${targetDir}`);
	}

	try {
		fs.unlinkSync(zipPath);
	} catch (error) {
		console.warn('Could not remove zip file:', error.message);
	}
}

function downloadFile(url, destination) {
	return new Promise((resolve, reject) => {
		const parsed = new URL(url);
		const getter = parsed.protocol === 'https:' ? https.get : http.get;
		const request = getter(parsed, (res) => {
			if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
				res.resume();
				const redirected = new URL(res.headers.location, url).toString();
				resolve(downloadFile(redirected, destination));
				return;
			}
			if (res.statusCode !== 200) {
				res.resume();
				reject(new Error(`Download failed with status ${res.statusCode}`));
				return;
			}
			const file = fs.createWriteStream(destination);
			res.pipe(file);
			file.on('finish', () => file.close(resolve));
			file.on('error', (error) => {
				fs.unlink(destination, () => reject(error));
			});
		});
		request.on('error', reject);
	});
}

async function fetchText(url) {
	return new Promise((resolve) => {
		const parsed = new URL(url);
		const getter = parsed.protocol === 'https:' ? https.get : http.get;
		const request = getter(parsed, (res) => {
			if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
				res.resume();
				const redirected = new URL(res.headers.location, url).toString();
				resolve(fetchText(redirected));
				return;
			}
			if (res.statusCode !== 200) {
				res.resume();
				resolve(null);
				return;
			}
			let body = '';
			res.setEncoding('utf8');
			res.on('data', (chunk) => {
				body += chunk;
			});
			res.on('end', () => resolve(body));
		});
		request.on('error', () => resolve(null));
	});
}

async function extractZip(zipPath, destDir) {
	if (process.platform === 'win32') {
		const command = `Expand-Archive -Path "${zipPath}" -DestinationPath "${destDir}" -Force`;
		await runCommand('powershell.exe', ['-NoProfile', '-Command', command]);
		return;
	}

	try {
		await runCommand('unzip', ['-o', zipPath, '-d', destDir]);
	} catch (error) {
		await runCommand('tar', ['-xf', zipPath, '-C', destDir]);
	}
}

function runCommand(command, args) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: 'inherit' });
		child.on('error', reject);
		child.on('close', (code) => {
			if (code === 0) {
				resolve();
			} else {
				reject(new Error(`${command} exited with code ${code}`));
			}
		});
	});
}

main().catch((error) => {
	console.error('Server startup failed:', error);
	process.exitCode = 1;
});
