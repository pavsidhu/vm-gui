import { execFile, spawn } from 'node:child_process'
import { randomBytes, randomInt } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { gcloud, UserError } from './gcloud.js'

const execFileAsync = promisify(execFile)

// London zones, tried in order if one is out of capacity
const ZONES = ['europe-west2-a', 'europe-west2-b', 'europe-west2-c']
// Google Cloud labels, tags and attributes keep the app's original name so existing desktops keep working
const LABEL_FILTER = 'labels.app=cloud-desktops'
const NETWORK_TAG = 'cloud-desktops-rdp'
const USERNAME = 'user'
const STARTUP_SCRIPT = new URL('./windows-startup.ps1', import.meta.url)

const PROJECT_ID = /^([a-z0-9.-]+:)?[a-z][-a-z0-9]{4,28}[a-z0-9]$/
const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9 -]{2,28}[A-Za-z0-9]$/
const BILLING_ACCOUNT = /^[0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6}$/
const VM_NAME = /^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/

export async function session() {
  const accounts = await gcloud(['auth', 'list'])
  return {
    account: accounts.find(account => account.status === 'ACTIVE')?.account ?? null,
    platform: process.platform,
  }
}

export async function listProjects() {
  const projects = await gcloud(['projects', 'list'])
  return projects
    .map(project => ({ id: project.projectId, name: project.name }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export async function listBillingAccounts() {
  const accounts = await gcloud(['billing', 'accounts', 'list'])
  return accounts
    .filter(account => account.open)
    .map(account => ({ id: account.name.split('/').pop(), name: account.displayName }))
}

// Creates a project with an ID like "my-desktops-3f9a1c"
export async function createProject({ name }) {
  if (!PROJECT_NAME.test(name ?? '')) {
    throw new UserError('Project names need 4–30 letters, numbers, spaces or hyphens.')
  }

  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^[^a-z]+/, '').slice(0, 23).replace(/-+$/, '')
  const id = `${slug || 'desktops'}-${randomBytes(3).toString('hex')}`
  await gcloud(['projects', 'create', id, `--name=${name}`], { format: null })
  return { id }
}

export async function linkBilling({ project, billingAccount }) {
  checkProject(project)
  if (!BILLING_ACCOUNT.test(billingAccount ?? '')) throw new UserError('Choose a billing account.')
  await gcloud(['billing', 'projects', 'link', project, `--billing-account=${billingAccount}`], { format: null })
}

export async function enableCompute({ project }) {
  checkProject(project)
  await gcloud(['services', 'enable', 'compute.googleapis.com', `--project=${project}`], { format: null })
}

export async function list({ project }) {
  checkProject(project)
  const instances = await gcloud(['compute', 'instances', 'list', `--project=${project}`, `--filter=${LABEL_FILTER}`])
  return instances
    .map(instance => ({
      name: instance.name,
      zone: instance.zone.split('/').pop(),
      status: instance.status,
      ip: externalIp(instance),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export async function create({ project, name }) {
  checkProject(project)
  if (!VM_NAME.test(name ?? '')) {
    throw new UserError('Names can only use lowercase letters, numbers and hyphens, and must start with a letter.')
  }

  const existing = await gcloud(['compute', 'instances', 'list', `--project=${project}`, `--filter=name=${name}`])
  if (existing.length > 0) throw new UserError(`There’s already a VM called “${name}” in this project.`)

  const dir = await mkdtemp(join(tmpdir(), 'vm-gui-'))
  try {
    const scriptFile = join(dir, 'startup.ps1')
    const passwordFile = join(dir, 'password')
    await copyFile(STARTUP_SCRIPT, scriptFile)
    await writeFile(passwordFile, generatePassword())

    for (const [index, zone] of ZONES.entries()) {
      try {
        await gcloud([
          'compute', 'instances', 'create', name,
          `--project=${project}`,
          `--zone=${zone}`,
          '--machine-type=e2-standard-2',
          '--image-family=windows-2025',
          '--image-project=windows-cloud',
          '--boot-disk-type=pd-balanced',
          `--tags=${NETWORK_TAG}`,
          '--labels=app=cloud-desktops',
          '--no-service-account',
          '--no-scopes',
          `--metadata=rdp-username=${USERNAME},enable-guest-attributes=TRUE`,
          `--metadata-from-file=windows-startup-script-ps1=${scriptFile},rdp-password=${passwordFile}`,
        ])
        return { zone }
      } catch (error) {
        const outOfCapacity = /RESOURCE_POOL_EXHAUSTED|enough resources|STOCKOUT/i.test(error.message)
        if (!outOfCapacity || index === ZONES.length - 1) throw error
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export async function start(vm) {
  await instanceCommand('start', vm)
}

export async function stop(vm) {
  await instanceCommand('stop', vm)
}

export async function remove(vm) {
  await instanceCommand('delete', vm)
}

// Opens the VM's Remote Desktop port to this computer's IP, then launches the Remote Desktop app.
export async function connect(vm) {
  const { project, zone, name } = checkVm(vm)
  const instance = await gcloud(['compute', 'instances', 'describe', name, `--project=${project}`, `--zone=${zone}`])
  if (instance.status !== 'RUNNING') throw new UserError(`${name} isn’t running. Start it first.`)

  const metadata = Object.fromEntries((instance.metadata?.items ?? []).map(item => [item.key, item.value]))
  const ip = externalIp(instance)
  const username = metadata['rdp-username']
  const password = metadata['rdp-password']
  if (!ip || !username || !password) throw new UserError(`${name} doesn’t have a Remote Desktop login set up.`)

  const [ready] = await Promise.all([isReady(instance, project, zone), allowCurrentIp(project)])
  if (!ready) {
    throw new UserError(
      'Windows is still starting up. This takes a couple of minutes (about 5 the first time), so try again shortly.',
      'NOT_READY',
    )
  }

  const rdpFile = await writeRdpFile(name, ip, username)
  await openRemoteDesktop(rdpFile, ip, username, password)
  return { ip, username, password }
}

async function instanceCommand(command, vm) {
  const { project, zone, name } = checkVm(vm)
  await gcloud(['compute', 'instances', command, name, `--project=${project}`, `--zone=${zone}`], { format: null })
}

// The VM's startup script records when it finished; it's ready once that's after the latest boot.
async function isReady(instance, project, zone) {
  let attributes
  try {
    attributes = await gcloud([
      'compute', 'instances', 'get-guest-attributes', instance.name,
      `--project=${project}`,
      `--zone=${zone}`,
      '--query-path=cloud-desktops/',
    ])
  } catch (error) {
    if (/not found|NOT_FOUND/i.test(error.message)) return false
    throw error
  }

  const readyAt = attributes?.find(attribute => attribute.key === 'ready')?.value
  if (!readyAt) return false
  return !instance.lastStartTimestamp || new Date(readyAt) > new Date(instance.lastStartTimestamp)
}

const allowedIps = new Set()

async function allowCurrentIp(project) {
  const ip = await publicIp()
  if (allowedIps.has(`${project} ${ip}`)) return

  try {
    await gcloud([
      'compute', 'firewall-rules', 'create', `cloud-desktops-rdp-${ip.replaceAll('.', '-')}`,
      `--project=${project}`,
      '--network=default',
      '--direction=INGRESS',
      '--allow=tcp:3389,udp:3389',
      `--source-ranges=${ip}/32`,
      `--target-tags=${NETWORK_TAG}`,
      '--description=Remote Desktop access from a VM GUI user',
    ], { format: null })
  } catch (error) {
    if (!/already exists/i.test(error.message)) throw error
  }
  allowedIps.add(`${project} ${ip}`)
}

async function publicIp() {
  for (const url of ['https://api.ipify.org', 'https://checkip.amazonaws.com']) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) })
      const ip = (await response.text()).trim()
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip
    } catch {}
  }
  throw new UserError('Couldn’t work out your public IP address to allow Remote Desktop through the firewall. Check your internet connection.')
}

async function writeRdpFile(name, ip, username) {
  const dir = join(tmpdir(), 'vm-gui')
  await mkdir(dir, { recursive: true })
  const file = join(dir, `${name}.rdp`)
  const settings = [
    `full address:s:${ip}`,
    `username:s:${username}`,
    'prompt for credentials:i:0',
    'screen mode id:i:1',
    'dynamic resolution:i:1',
    'redirectclipboard:i:1',
    'audiomode:i:0',
    'autoreconnection enabled:i:1',
  ]
  await writeFile(file, settings.join('\r\n') + '\r\n')
  return file
}

async function openRemoteDesktop(rdpFile, ip, username, password) {
  if (process.platform === 'win32') {
    // Save the login in Windows Credential Manager so Remote Desktop Connection signs straight in
    await execFileAsync('cmdkey', [`/generic:TERMSRV/${ip}`, `/user:${username}`, `/pass:${password}`], { windowsHide: true })
    spawn('mstsc', [rdpFile], { detached: true, stdio: 'ignore' }).unref()
  } else if (process.platform === 'darwin') {
    // Windows App can't read passwords from .rdp files, so put it on the clipboard to paste
    await copyToClipboard(password)
    try {
      await execFileAsync('open', [rdpFile])
    } catch {
      throw new UserError('Couldn’t open Windows App. Run start-mac.command again to install it.')
    }
  }
}

function copyToClipboard(text) {
  return new Promise((resolve, reject) => {
    const child = spawn('pbcopy')
    child.on('error', reject).on('close', resolve)
    child.stdin.end(text)
  })
}

function externalIp(instance) {
  return instance.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP ?? null
}

const PASSWORD_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'

// Meets Windows' complexity rules: upper, lower, digit, and doesn't contain the username
function generatePassword() {
  while (true) {
    const password = Array.from({ length: 20 }, () => PASSWORD_CHARS[randomInt(PASSWORD_CHARS.length)]).join('')
    if (/[A-Z]/.test(password) && /[a-z]/.test(password) && /\d/.test(password) && !password.toLowerCase().includes(USERNAME)) {
      return password
    }
  }
}

function checkProject(project) {
  if (!PROJECT_ID.test(project ?? '')) throw new UserError('Choose a project first.')
}

function checkVm({ project, zone, name } = {}) {
  checkProject(project)
  if (!ZONES.includes(zone) || !VM_NAME.test(name ?? '')) throw new UserError('Unknown VM.')
  return { project, zone, name }
}
