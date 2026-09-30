import { exec } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import http from 'node:http'
import * as desktops from './lib/desktops.js'
import { UserError } from './lib/gcloud.js'

const PORT = Number(process.env.PORT) || 4870
const URL_BASE = `http://localhost:${PORT}`
const ALLOWED_HOSTS = [`localhost:${PORT}`, `127.0.0.1:${PORT}`]
const ALLOWED_ORIGINS = ALLOWED_HOSTS.map(host => `http://${host}`)
const OPEN_BROWSER = !process.argv.includes('--no-open')

const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
}

const ROUTES = {
  'GET /api/session': () => desktops.session(),
  'GET /api/projects': () => desktops.listProjects(),
  'GET /api/billing-accounts': () => desktops.listBillingAccounts(),
  'POST /api/projects/create': body => desktops.createProject(body),
  'POST /api/projects/link-billing': body => desktops.linkBilling(body),
  'GET /api/desktops': (_, query) => desktops.list({ project: query.get('project') }),
  'POST /api/enable-compute': body => desktops.enableCompute(body),
  'POST /api/desktops/create': body => desktops.create(body),
  'POST /api/desktops/start': body => desktops.start(body),
  'POST /api/desktops/stop': body => desktops.stop(body),
  'POST /api/desktops/delete': body => desktops.remove(body),
  'POST /api/desktops/connect': body => desktops.connect(body),
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, URL_BASE)

  // Only answer this machine's own browser: blocks DNS rebinding and cross-site requests
  const origin = request.headers.origin
  if (!ALLOWED_HOSTS.includes(request.headers.host) || (origin && !ALLOWED_ORIGINS.includes(origin))) {
    return send(response, 403, { error: 'Forbidden' })
  }

  const file = request.method === 'GET' && STATIC_FILES[url.pathname]
  if (file) {
    const [name, type] = file
    response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
    return response.end(await readFile(new URL(`./public/${name}`, import.meta.url)))
  }

  const route = ROUTES[`${request.method} ${url.pathname}`]
  if (!route) return send(response, 404, { error: 'Not found' })

  try {
    const body = request.method === 'POST' ? await readJson(request) : {}
    send(response, 200, (await route(body, url.searchParams)) ?? { ok: true })
  } catch (error) {
    if (!(error instanceof UserError)) console.error(error)
    send(response, error instanceof UserError ? 400 : 500, { error: error.message, code: error.code })
  }
})

server.on('error', error => {
  if (error.code !== 'EADDRINUSE') throw error
  console.log(`VM GUI is already running at ${URL_BASE}`)
  if (OPEN_BROWSER) openBrowser()
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`VM GUI is running at ${URL_BASE}\nKeep this window open while you use it. Close it to quit.\n`)
  if (OPEN_BROWSER) openBrowser()
})

async function readJson(request) {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new UserError('Expected JSON')
  let text = ''
  for await (const chunk of request) text += chunk
  return JSON.parse(text || '{}')
}

function send(response, status, data) {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(data))
}

function openBrowser() {
  const command = process.platform === 'win32' ? `start "" "${URL_BASE}"` : process.platform === 'darwin' ? `open "${URL_BASE}"` : `xdg-open "${URL_BASE}"`
  exec(command, { windowsHide: true })
}
