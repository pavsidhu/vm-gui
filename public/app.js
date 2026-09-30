const $ = selector => document.querySelector(selector)

const VM_NAME = /^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/
const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9 -]{2,28}[A-Za-z0-9]$/

// GCE instance status → [label, dot style]
const STATUS = {
  PROVISIONING: ['Starting', 'busy'],
  STAGING: ['Starting', 'busy'],
  RUNNING: ['Running', 'running'],
  STOPPING: ['Stopping', 'busy'],
  SUSPENDING: ['Suspending', 'busy'],
  REPAIRING: ['Repairing', 'busy'],
  SUSPENDED: ['Suspended', ''],
  STOPPED: ['Stopped', ''],
  TERMINATED: ['Stopped', ''],
}

const state = {
  platform: null,
  project: null,
  desktops: [],
  loaded: false,
  listError: null,
  enabling: null,
  billingAccounts: null,
  pending: new Map(), // key → { label, desktop }
  logins: new Map(), // key → { ip, username, password, revealed }
}

const key = desktop => `${desktop.project}/${desktop.name}`

async function api(path, body) {
  const response = await fetch(
    path,
    body && { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
  )
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw Object.assign(new Error(data.error || `Request failed (${response.status})`), { code: data.code })
  return data
}

// Setup

async function init() {
  $('#project').addEventListener('change', event => selectProject(event.target.value))
  $('#new-project-toggle').addEventListener('click', toggleNewProject)
  $('#new-project').addEventListener('submit', createProject)
  $('#refresh').addEventListener('click', () => refresh())
  $('#create').addEventListener('submit', create)
  $('#name').addEventListener('input', event => {
    const input = event.target
    const normalized = input.value.toLowerCase().replace(/\s+/g, '-')
    if (normalized !== input.value) input.value = normalized
  })
  document.addEventListener('visibilitychange', () => document.hidden || refresh())

  render()
  await Promise.all([loadSession(), loadProjects()]).catch(error => showNotice(error.message))
}

async function loadSession() {
  const session = await api('/api/session')
  state.platform = session.platform
  $('#account').textContent = session.account ?? ''
  if (!session.account) {
    showNotice('You’re not signed in to Google Cloud. Close this app and run the start script again to sign in.')
  }
}

async function loadProjects() {
  const projects = await api('/api/projects')
  const select = $('#project')
  const saved = localStorage.getItem('project')

  select.replaceChildren(
    h('option', { value: '', textContent: projects.length ? 'Choose a project' : 'No projects found' }),
    ...projects.map(project =>
      h('option', {
        value: project.id,
        textContent: project.name === project.id ? project.id : `${project.name} (${project.id})`,
      }),
    ),
  )
  select.disabled = false

  if (projects.some(project => project.id === saved)) {
    select.value = saved
    selectProject(saved)
  }
}

function selectProject(project) {
  state.project = project || null
  state.desktops = []
  state.loaded = false
  state.listError = null
  if (project) localStorage.setItem('project', project)
  render()
  refresh()
}

// New projects: create, link billing, turn on Compute Engine

async function toggleNewProject() {
  const form = $('#new-project')
  form.hidden = !form.hidden
  $('#new-project-toggle').textContent = form.hidden ? 'New project' : 'Cancel'
  if (form.hidden) return
  $('#project-name').focus()
  if (!state.billingAccounts) await loadBillingAccounts()
}

async function loadBillingAccounts() {
  setProjectStatus('Loading billing accounts…')
  try {
    state.billingAccounts = await api('/api/billing-accounts')
  } catch (error) {
    return setProjectStatus(error.message)
  }
  $('#billing-account').replaceChildren(
    ...state.billingAccounts.map(account => h('option', { value: account.id, textContent: account.name })),
  )
  $('#billing-field').hidden = state.billingAccounts.length < 2
  showBillingHint()
}

function showBillingHint() {
  const accounts = state.billingAccounts ?? []
  if (accounts.length === 0) {
    return setProjectStatus(
      'Desktops need a billing account. ',
      h('a', { href: 'https://console.cloud.google.com/billing/create', target: '_blank', textContent: 'Create one' }),
      ', then reopen this form.',
    )
  }
  const billedTo = accounts.length === 1 ? `Billed to ${accounts[0].name}. ` : ''
  setProjectStatus(`${billedTo}Billing and Compute Engine are set up for you, which takes a minute or two.`)
}

async function createProject(event) {
  event.preventDefault()
  const form = event.target
  const name = $('#project-name').value.trim()
  const billingAccount = $('#billing-account').value
  if (!PROJECT_NAME.test(name)) return toast('Project names need 4–30 letters, numbers, spaces or hyphens.', 'error')
  if (!billingAccount) return toast('Desktops need a billing account first.', 'error')

  const controls = [...form.querySelectorAll('input, select, button'), $('#new-project-toggle')]
  controls.forEach(control => (control.disabled = true))
  let project

  try {
    setProjectStatus('Creating the project…')
    project = (await api('/api/projects/create', { name })).id
    setProjectStatus('Linking billing…')
    await api('/api/projects/link-billing', { project, billingAccount })
    setProjectStatus('Turning on Compute Engine (about a minute)…')
    await api('/api/enable-compute', { project })

    toast(`${name} is ready for desktops.`)
    form.reset()
    form.hidden = true
    $('#new-project-toggle').textContent = 'New project'
  } catch (error) {
    toast(project ? `Created ${name}, but couldn’t finish setting it up: ${error.message}` : error.message, 'error')
  } finally {
    controls.forEach(control => (control.disabled = false))
    showBillingHint()
    if (project) {
      localStorage.setItem('project', project)
      await loadProjects().catch(error => toast(error.message, 'error'))
    }
  }
}

function setProjectStatus(...parts) {
  $('#new-project-status').replaceChildren(...parts)
}

// Loading desktops: every 4s while anything is changing, otherwise every 20s

let refreshTimer
let refreshId = 0

async function refresh() {
  clearTimeout(refreshTimer)
  const project = state.project

  if (project && !document.hidden) {
    const id = ++refreshId
    try {
      const desktops = await api(`/api/desktops?project=${encodeURIComponent(project)}`)
      if (id !== refreshId) return
      state.desktops = desktops.map(desktop => ({ ...desktop, project }))
      state.listError = null
    } catch (error) {
      if (id !== refreshId) return
      state.desktops = []
      state.listError = error
    }
    state.loaded = true
    render()
  }

  const busy = state.pending.size > 0 || state.desktops.some(desktop => STATUS[desktop.status]?.[1] === 'busy')
  refreshTimer = setTimeout(refresh, busy ? 4000 : 20000)
}

// Actions

async function create(event) {
  event.preventDefault()
  const input = $('#name')
  const name = input.value.trim()
  if (!state.project) return toast('Choose a project first.', 'error')
  if (!VM_NAME.test(name)) {
    return toast('Names can only use lowercase letters, numbers and hyphens, and must start with a letter.', 'error')
  }

  const desktop = { project: state.project, name, zone: '', status: 'PROVISIONING', ip: null }
  state.pending.set(key(desktop), { label: 'Creating…', desktop })
  input.value = ''
  render()

  try {
    await api('/api/desktops/create', { project: desktop.project, name })
    toast(`${name} is starting. Windows takes about 5 minutes to set up the first time, then you can connect.`)
  } catch (error) {
    toast(error.message, 'error')
    input.value ||= name
  } finally {
    state.pending.delete(key(desktop))
    refresh()
  }
}

async function act(desktop, label, action) {
  state.pending.set(key(desktop), { label, desktop })
  render()
  try {
    return await api(`/api/desktops/${action}`, { project: desktop.project, zone: desktop.zone, name: desktop.name })
  } catch (error) {
    toast(error.message, error.code === 'NOT_READY' ? 'info' : 'error')
  } finally {
    state.pending.delete(key(desktop))
    refresh()
  }
}

async function connect(desktop) {
  const login = await act(desktop, 'Connecting…', 'connect')
  if (login) {
    state.logins.set(key(desktop), login)
    render()
  }
}

function start(desktop) {
  act(desktop, 'Starting…', 'start')
}

function stop(desktop) {
  if (confirm(`Stop ${desktop.name}? Anything open on it will be closed.`)) act(desktop, 'Stopping…', 'stop')
}

function remove(desktop) {
  if (confirm(`Delete ${desktop.name}? This permanently erases it and everything on it.`)) {
    state.logins.delete(key(desktop))
    act(desktop, 'Deleting…', 'delete')
  }
}

async function enableCompute() {
  const project = state.project
  state.enabling = project
  render()
  try {
    await api('/api/enable-compute', { project })
  } catch (error) {
    toast(error.message, 'error')
  } finally {
    state.enabling = null
    refresh()
  }
}

// Rendering

function render() {
  const container = $('#desktops')

  if (!state.project) return container.replaceChildren(empty('Choose a project to see its desktops.'))

  if (state.listError?.code === 'COMPUTE_DISABLED') {
    const enabling = state.enabling === state.project
    return container.replaceChildren(
      empty('Compute Engine needs to be turned on for this project before it can run desktops.'),
      h('p', {}, button(enabling ? 'Enabling… (about a minute)' : 'Enable Compute Engine', 'primary', enableCompute, enabling)),
    )
  }

  if (state.listError) return container.replaceChildren(empty(state.listError.message))
  if (!state.loaded) return container.replaceChildren(empty('Loading desktops…'))

  const creating = [...state.pending.values()]
    .filter(({ label, desktop }) => label === 'Creating…' && desktop.project === state.project)
    .map(({ desktop }) => desktop)
    .filter(desktop => !state.desktops.some(listed => listed.name === desktop.name))
  const desktops = [...state.desktops, ...creating]

  if (desktops.length === 0) return container.replaceChildren(empty('No desktops yet. Create one above.'))
  container.replaceChildren(...desktops.flatMap(desktop => [desktopRow(desktop), loginPanel(desktop)]).filter(Boolean))
}

function desktopRow(desktop) {
  const pending = state.pending.get(key(desktop))
  const [label, tone] = pending ? [pending.label, 'busy'] : (STATUS[desktop.status] ?? [desktop.status, ''])
  const disabled = Boolean(pending) || !desktop.zone
  const actions = []

  if (desktop.status === 'RUNNING') {
    actions.push(
      button('Connect', 'primary', () => connect(desktop), disabled),
      button('Stop', '', () => stop(desktop), disabled),
    )
  }
  if (desktop.status === 'TERMINATED' || desktop.status === 'STOPPED') {
    actions.push(button('Start', 'primary', () => start(desktop), disabled))
  }
  actions.push(button('Delete', 'danger', () => remove(desktop), disabled))

  return h(
    'div',
    { className: 'desktop' },
    h(
      'div',
      {},
      h('div', { className: 'name', textContent: desktop.name }),
      h('div', { className: 'meta' }, h('span', { className: `dot ${tone}` }), [label, desktop.ip].filter(Boolean).join(' · ')),
    ),
    h('div', { className: 'actions' }, actions),
  )
}

function loginPanel(desktop) {
  const login = state.logins.get(key(desktop))
  if (!login || desktop.status !== 'RUNNING') return null

  const message = {
    darwin: 'Windows App is opening. The password is on your clipboard, so paste it when asked.',
    win32: 'Remote Desktop is opening and will sign in automatically.',
  }[state.platform] ?? 'Open your Remote Desktop app and connect with these details.'

  const toggle = () => {
    login.revealed = !login.revealed
    render()
  }

  return h(
    'div',
    { className: 'login' },
    h('div', { className: 'section-head' }, h('p', { textContent: message }), button('Hide', 'ghost', () => {
      state.logins.delete(key(desktop))
      render()
    })),
    h(
      'div',
      { className: 'fields' },
      field('Address', login.ip, copyButton(login.ip)),
      field('Username', login.username, copyButton(login.username)),
      field('Password', login.revealed ? login.password : '•'.repeat(login.password.length), [
        button(login.revealed ? 'Hide' : 'Show', 'ghost', toggle),
        copyButton(login.password),
      ]),
    ),
  )
}

function field(label, value, actions) {
  return [
    h('span', { className: 'muted', textContent: label }),
    h('code', { textContent: value }),
    h('span', { className: 'actions' }, actions),
  ]
}

function copyButton(text) {
  return button('Copy', '', async event => {
    const target = event.currentTarget
    await navigator.clipboard.writeText(text)
    target.textContent = 'Copied'
    setTimeout(() => (target.textContent = 'Copy'), 1500)
  })
}

function button(text, className, onClick, disabled = false) {
  return h('button', { type: 'button', className, textContent: text, disabled, onClick })
}

function empty(text) {
  return h('p', { className: 'empty', textContent: text })
}

function showNotice(message) {
  const notice = $('#notice')
  notice.textContent = message
  notice.hidden = false
}

function toast(message, tone = 'info') {
  const element = h('div', { className: `toast ${tone}`, textContent: message, onClick: () => element.remove() })
  $('#toasts').append(element)
  setTimeout(() => element.remove(), tone === 'error' ? 12000 : 7000)
}

function h(tag, props = {}, ...children) {
  const element = document.createElement(tag)
  for (const [name, value] of Object.entries(props)) {
    if (name.startsWith('on')) element.addEventListener(name.slice(2).toLowerCase(), value)
    else element[name] = value
  }
  element.append(...children.flat(Infinity).filter(child => child != null && child !== false))
  return element
}

init()
